/**
 * quality-gate.mjs — Verification-Auto-Fix-Loop core (Pattern 4, PRD #521).
 *
 * Exports `runQualityGateWithRetry({ maxRetries, dispatchFixer, repoRoot, commands })`
 * which runs lint → typecheck → test in order, and on failure dispatches a
 * caller-supplied fixer callback (typically a `code-implementer` subagent) up
 * to `maxRetries` times before aborting with a diagnostics bundle.
 *
 * Design notes:
 *
 *   - The module is pure-orchestration. It does NOT know about the Task tool,
 *     subagent prompts, or any specific Claude Code internals. The `dispatchFixer`
 *     callback is the seam: the coordinator constructs the subagent invocation
 *     and passes the closure in. This keeps the module unit-testable with a
 *     trivial fake fixer (e.g. `async () => {}`).
 *
 *   - Commands resolve in this priority order:
 *       1. `opts.commands.{lint,typecheck,test}` if non-empty
 *       2. Session Config keys from `parse-config.mjs` output
 *       3. Built-in defaults (`npm run lint`, `npm run typecheck`, `npm test`)
 *     The quality-gates policy file (.orchestrator/policy/quality-gates.json)
 *     is intentionally NOT consulted here — that overrides live in the legacy
 *     `run-quality-gate.mjs` wrapper. The auto-fix loop targets the loop-scope
 *     resolution defined in the PRD.
 *
 *   - Output collection: each gate captures the last ~50 lines of combined
 *     stdout+stderr (vs. `gate-helpers.mjs::runCheck` which truncates to 5).
 *     The longer tail flows into the diagnostics bundle and the fixer's
 *     failureContext.
 *
 *   - `last-green-sha.txt` lives at `.orchestrator/runtime/last-green-sha.txt`
 *     and is updated atomically after every successful gate. `changedFiles`
 *     diffs against this file when present, falling back to `HEAD~1` otherwise.
 *     The file is best-effort — git diff failures degrade to an empty array
 *     rather than blocking the gate.
 *
 *   - `corrective_context` is read from `.orchestrator/current-session.json`
 *     (written by `hooks/post-tool-failure-corrective-context.mjs`). Missing
 *     file / parse failure → empty array. The most recent 5 entries are
 *     forwarded to the fixer (older noise is dropped to keep prompts lean).
 *
 *   - Diagnostics bundle path: `.orchestrator/metrics/verification-failures/<ts>.json`.
 *     Timestamp colons are replaced with `-` for filesystem portability.
 *
 *   - The function never throws — every error path returns a structured
 *     `{ ok: false, ... }` result so the wave-executor can decide how to
 *     present the failure to the operator.
 *
 * Related files:
 *   scripts/run-quality-gate.mjs                      — legacy variant-based entrypoint
 *   scripts/lib/gates/gate-helpers.mjs                — runCheck, csvToJsonArray, …
 *   hooks/post-tool-failure-corrective-context.mjs    — writes corrective_context
 *   "gsd Pattern Adoption Quick-Wins" (#517/#521; archived in the private Meta-Vault) § 4 Pattern 4
 *   skills/wave-executor/wave-loop.md                 — caller (Agent B's scope)
 *   tests/unit/quality-gate-autofix.test.mjs          — unit tests (Agent C's scope)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactDiagnosticsBundle } from './quality-gate/diagnostics.mjs';
export { redactDiagnosticsBundle } from './quality-gate/diagnostics.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gate execution order — fail-fast on the first non-zero exit. */
const GATE_ORDER = /** @type {const} */ (['lint', 'typecheck', 'test']);

/** Built-in defaults (matched to this repo's package.json scripts). */
const DEFAULT_COMMANDS = {
  lint: 'npm run lint',
  typecheck: 'npm run typecheck',
  test: 'npm test',
};

/** Max lines of combined stdout+stderr retained per failure. */
const OUTPUT_TAIL_LINES = 50;

/** Max corrective_context entries forwarded to the fixer (most-recent). */
const CORRECTIVE_CONTEXT_TAIL = 5;

/** Hard ceiling on retries — defensive coercion. */
const MAX_RETRIES_HARD_CAP = 10;

/** Per-gate command timeout (15 min). Wave gates can be long; never infinite. */
const GATE_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the repo root that owns `.orchestrator/`. Uses opts.repoRoot if
 * provided, else falls back to process.cwd().
 *
 * @param {string|undefined} explicit
 * @returns {string}
 */
function resolveRepoRoot(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  return process.cwd();
}

/**
 * Load default commands from Session Config via `scripts/parse-config.mjs`.
 * Returns a partial object — keys that fail to resolve are simply absent
 * (the caller falls through to DEFAULT_COMMANDS for those).
 *
 * Never throws.
 *
 * @param {string} repoRoot
 * @returns {{lint?: string, typecheck?: string, test?: string}}
 */
export function loadCommandsFromSessionConfig(repoRoot) {
  try {
    const scriptPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'parse-config.mjs',
    );
    if (!existsSync(scriptPath)) return {};
    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    if (result.status !== 0 || !result.stdout) return {};
    const cfg = JSON.parse(result.stdout);
    const out = {};
    if (typeof cfg['lint-command'] === 'string' && cfg['lint-command'].trim()) {
      out.lint = cfg['lint-command'];
    }
    if (typeof cfg['typecheck-command'] === 'string' && cfg['typecheck-command'].trim()) {
      out.typecheck = cfg['typecheck-command'];
    }
    if (typeof cfg['test-command'] === 'string' && cfg['test-command'].trim()) {
      out.test = cfg['test-command'];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve the three gate commands. Precedence: override > session config > defaults.
 *
 * @param {{lint?: string, typecheck?: string, test?: string}|undefined} override
 * @param {string} repoRoot
 * @returns {{lint: string, typecheck: string, test: string}}
 */
function resolveCommands(override, repoRoot) {
  const sessionCfg = loadCommandsFromSessionConfig(repoRoot);
  const pick = (key) => {
    if (override && typeof override[key] === 'string' && override[key].trim()) {
      return override[key];
    }
    if (sessionCfg[key]) return sessionCfg[key];
    return DEFAULT_COMMANDS[key];
  };
  return {
    lint: pick('lint'),
    typecheck: pick('typecheck'),
    test: pick('test'),
  };
}

/**
 * Run a shell command, capture stdout+stderr, return last ~50 lines plus exit code.
 *
 * Does NOT throw — failures are encoded in the return value. Honours
 * GATE_TIMEOUT_MS as a hard ceiling.
 *
 * @param {string} cmd
 * @param {string} cwd
 * @returns {{ exitCode: number, output: string, timedOut: boolean }}
 */
function runGate(cmd, cwd) {
  try {
    const result = spawnSync(cmd, {
      cwd,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GATE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024, // 16 MiB cap
    });
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    const tail = combined.split('\n').slice(-OUTPUT_TAIL_LINES).join('\n').trim();
    const timedOut = result.signal === 'SIGTERM' && result.error?.code === 'ETIMEDOUT';
    const exitCode = typeof result.status === 'number'
      ? result.status
      : (timedOut ? 124 : 1);
    return { exitCode, output: tail, timedOut };
  } catch (err) {
    return {
      exitCode: 1,
      output: `quality-gate: failed to spawn command "${cmd}": ${err?.message ?? String(err)}`,
      timedOut: false,
    };
  }
}

/**
 * Read `.orchestrator/runtime/last-green-sha.txt`. Returns null on miss.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
function readLastGreenSha(repoRoot) {
  try {
    const p = join(repoRoot, '.orchestrator', 'runtime', 'last-green-sha.txt');
    if (!existsSync(p)) return null;
    const sha = readFileSync(p, 'utf8').trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Write the current HEAD sha to `.orchestrator/runtime/last-green-sha.txt`
 * atomically (tmp + rename). Best-effort; failures are silent.
 *
 * @param {string} repoRoot
 */
function writeLastGreenSha(repoRoot) {
  try {
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (sha.status !== 0 || !sha.stdout) return;
    const head = sha.stdout.trim();
    if (!head) return;
    const runtimeDir = join(repoRoot, '.orchestrator', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const target = join(runtimeDir, 'last-green-sha.txt');
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, head + '\n', 'utf8');
    renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

/**
 * List files changed since `ref` (or HEAD~1 if no ref). Best-effort: returns
 * empty array on any git failure.
 *
 * @param {string} repoRoot
 * @param {string|null} ref
 * @returns {string[]}
 */
function listChangedFiles(repoRoot, ref) {
  const baseRef = ref ?? 'HEAD~1';
  try {
    const result = spawnSync('git', ['diff', '--name-only', baseRef, 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read `corrective_context` array from `.orchestrator/current-session.json`.
 * Returns the most-recent N entries. Empty array on missing file / parse failure.
 *
 * @param {string} repoRoot
 * @returns {Array<object>}
 */
function readCorrectiveContext(repoRoot) {
  try {
    const p = join(repoRoot, '.orchestrator', 'current-session.json');
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.corrective_context) ? parsed.corrective_context : [];
    return arr.slice(-CORRECTIVE_CONTEXT_TAIL);
  } catch {
    return [];
  }
}

/**
 * Write the diagnostics bundle to `.orchestrator/metrics/verification-failures/<ts>.json`.
 * Returns the absolute path on success, null on failure.
 *
 * @param {string} repoRoot
 * @param {object} bundle
 * @returns {string|null}
 */
function writeDiagnosticsBundle(repoRoot, bundle) {
  try {
    const dir = join(repoRoot, '.orchestrator', 'metrics', 'verification-failures');
    mkdirSync(dir, { recursive: true });
    // Replace colons in ISO timestamp for cross-fs portability.
    const ts = new Date().toISOString().replace(/:/g, '-');
    const target = join(dir, `${ts}.json`);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(redactDiagnosticsBundle(bundle), null, 2) + '\n', 'utf8');
    renameSync(tmp, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * Detect whether the current wave touched shared-lib / hooks / husky code surface.
 * Returns `{ touched: boolean, paths: string[] }`.
 *
 * Used by the inter-wave Quality-Lite step to auto-promote Lite → Full Gate
 * when shared code is touched (#555 FL-3). The rationale: deep-1647 inter-wave
 * 3→4 caught 2 cross-cutting regressions only because Quality-Lite happened to
 * run the full test suite. When an Impl wave touches files under
 * `scripts/lib/*`, `hooks/*`, or `.husky/*`, the blast radius is wider than the
 * agent could predict — auto-promote to Full Gate.
 *
 * Safe-default: any git failure (missing sinceRef, detached HEAD, no commits)
 * returns `{ touched: false, paths: [] }` so the gate never blocks a session.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot                    — repo to diff against.
 * @param {string} [opts.sinceRef]                  — ref to diff from. Defaults to
 *                                                    last-green-sha.txt, then HEAD~1.
 * @param {string[]} [opts.promoteWhenTouched]      — path prefixes that trigger
 *                                                    promotion. Default:
 *                                                    `['scripts/lib/', 'hooks/', '.husky/']`.
 * @returns {{ touched: boolean, paths: string[] }} `paths` only contains files
 *   matching at least one of `promoteWhenTouched` prefixes; never the full diff.
 */
export function detectSharedLibTouch(opts) {
  const safeOpts = (typeof opts === 'object' && opts !== null) ? opts : {};
  const repoRoot = resolveRepoRoot(safeOpts.repoRoot);
  const prefixes = Array.isArray(safeOpts.promoteWhenTouched) && safeOpts.promoteWhenTouched.length > 0
    ? safeOpts.promoteWhenTouched
    : ['scripts/lib/', 'hooks/', '.husky/'];
  const sinceRef = (typeof safeOpts.sinceRef === 'string' && safeOpts.sinceRef.trim())
    ? safeOpts.sinceRef
    : (readLastGreenSha(repoRoot) ?? 'HEAD~1');

  const changed = listChangedFiles(repoRoot, sinceRef);
  if (changed.length === 0) return { touched: false, paths: [] };

  const matched = changed.filter((file) => prefixes.some((p) => file.startsWith(p)));
  return { touched: matched.length > 0, paths: matched };
}

/**
 * Coerce `maxRetries` to [0, MAX_RETRIES_HARD_CAP] integer.
 *
 * @param {unknown} n
 * @returns {number}
 */
function coerceMaxRetries(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 2;
  const int = Math.trunc(n);
  if (int < 0) return 0;
  if (int > MAX_RETRIES_HARD_CAP) return MAX_RETRIES_HARD_CAP;
  return int;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run quality gate (lint → typecheck → test, fail-fast), dispatching a fixer
 * callback on each failure up to `maxRetries` times.
 *
 * @param {object} opts
 * @param {number} [opts.maxRetries=2]    — bounded retry budget. Coerced to [0, 10].
 * @param {(ctx: {
 *   failures: Array<{gate: string, exitCode: number, output: string, timedOut: boolean}>,
 *   correctiveContext: Array<object>,
 *   changedFiles: string[],
 *   attempt: number,
 *   maxRetries: number,
 * }) => Promise<void>} opts.dispatchFixer — caller-supplied fixer.
 *   Receives the latest failure context; expected to mutate the working tree
 *   (typically by dispatching a `code-implementer` subagent). The next loop
 *   iteration re-runs the gate.
 * @param {string} [opts.repoRoot]        — defaults to process.cwd().
 * @param {{lint?: string, typecheck?: string, test?: string}} [opts.commands]
 *                                          — override individual gate commands.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   attempts: number,
 *   finalFailure?: { gate: string, exitCode: number, output: string, changedFiles: string[] },
 *   diagnosticsBundlePath?: string,
 * }>}
 *
 * Never throws. Always returns a structured result.
 */
export async function runQualityGateWithRetry(opts) {
  const safeOpts = (typeof opts === 'object' && opts !== null) ? opts : {};
  const maxRetries = coerceMaxRetries(safeOpts.maxRetries);
  const dispatchFixer = typeof safeOpts.dispatchFixer === 'function'
    ? safeOpts.dispatchFixer
    : async () => {};
  const repoRoot = resolveRepoRoot(safeOpts.repoRoot);
  const commands = resolveCommands(safeOpts.commands, repoRoot);

  // Accumulate per-attempt failure info for the diagnostics bundle.
  const allFailures = [];
  let attempt = 0;
  let lastFailure = null;

  // Total loop budget = maxRetries + 1 (one initial run + up to maxRetries fixer-driven retries).
  const totalAttempts = maxRetries + 1;

  while (attempt < totalAttempts) {
    attempt += 1;
    let gateFailure = null;

    for (const gate of GATE_ORDER) {
      const cmd = commands[gate];
      const result = runGate(cmd, repoRoot);
      if (result.exitCode === 0) {
        process.stderr.write(`🔁 quality-gate attempt ${attempt}/${totalAttempts} (gate=${gate}): pass\n`);
        continue;
      }
      // Fail — capture and break out of the gate loop (fail-fast).
      process.stderr.write(`🔁 quality-gate attempt ${attempt}/${totalAttempts} (gate=${gate}): fail (exit ${result.exitCode})\n`);
      gateFailure = {
        gate,
        exitCode: result.exitCode,
        output: result.output,
        timedOut: result.timedOut,
        command: cmd,
        attempt,
      };
      break;
    }

    if (gateFailure === null) {
      // All gates passed this attempt.
      writeLastGreenSha(repoRoot);
      return { ok: true, attempts: attempt };
    }

    // Record the failure.
    allFailures.push(gateFailure);
    lastFailure = gateFailure;

    // If this was our last allowed attempt, stop without invoking the fixer.
    if (attempt >= totalAttempts) break;

    // Otherwise — dispatch the fixer with current context, then loop.
    const lastGreenSha = readLastGreenSha(repoRoot);
    const changedFiles = listChangedFiles(repoRoot, lastGreenSha);
    const correctiveContext = readCorrectiveContext(repoRoot);

    const ctxBytes = JSON.stringify(correctiveContext).length;
    process.stderr.write(
      `🔧 dispatching fixer-agent: gate=${gateFailure.gate}, ` +
      `files=${changedFiles.length}, context=${ctxBytes}\n`,
    );

    try {
      await dispatchFixer({
        failures: [...allFailures],
        correctiveContext,
        changedFiles,
        attempt,
        maxRetries,
      });
    } catch (err) {
      // Fixer threw — treat as fixer failure, continue to next attempt.
      // The next gate run will reveal whether the fixer made any progress
      // before throwing.
      process.stderr.write(
        `🔧 fixer-agent threw: ${err?.message ?? String(err)} — continuing to next attempt\n`,
      );
    }
    // Loop continues; next iteration re-runs the full gate.
  }

  // Exhausted retries — write diagnostics bundle and return failure.
  const lastGreenSha = readLastGreenSha(repoRoot);
  const finalChangedFiles = listChangedFiles(repoRoot, lastGreenSha);
  const correctiveContext = readCorrectiveContext(repoRoot);

  const bundle = {
    timestamp: new Date().toISOString(),
    wave: process.env.SO_WAVE_ID ?? null,
    gate: lastFailure?.gate ?? null,
    retryAttempts: attempt,
    maxRetries,
    failures: allFailures,
    finalError: lastFailure,
    changedFiles: finalChangedFiles,
    correctiveContext,
    commands,
    repoRoot,
  };

  const bundlePath = writeDiagnosticsBundle(repoRoot, bundle);
  process.stderr.write(
    `❌ quality-gate exhausted retries (${attempt}), writing diagnostics to ${bundlePath ?? '<unwritable>'}\n`,
  );

  const out = {
    ok: false,
    attempts: attempt,
  };
  if (lastFailure) {
    out.finalFailure = {
      gate: lastFailure.gate,
      exitCode: lastFailure.exitCode,
      output: lastFailure.output,
      changedFiles: finalChangedFiles,
    };
  }
  if (bundlePath) {
    out.diagnosticsBundlePath = bundlePath;
  }
  return out;
}

