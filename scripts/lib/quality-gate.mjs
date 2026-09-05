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
 *     and is updated atomically after every successful gate. `changedFiles` is
 *     the UNION of the diff against this file (falling back to `HEAD~1`) and
 *     the UNCOMMITTED working tree (#1058) — wave agents never commit, so the
 *     committed half alone reported nothing they did. Both halves are
 *     best-effort: a git failure in either degrades to an empty contribution
 *     rather than blocking the gate.
 *
 *   - `corrective_context` is read from `.orchestrator/current-session.json`
 *     (written by `hooks/post-tool-failure-corrective-context.mjs`). Missing
 *     file / parse failure → empty array; a file that provably belongs to a
 *     PEER session in the same working copy is treated as absent, with a stderr
 *     WARN (#1058). The most recent 5 entries are forwarded to the fixer (older
 *     noise is dropped to keep prompts lean).
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

import { emitEvent, sessionAttribution } from './events.mjs';
import { admitSuiteCounts, extractTestCounts } from './gates/gate-helpers.mjs';
import { redactDiagnosticsBundle } from './quality-gate/diagnostics.mjs';
import { readProcessLocalSessionIds } from './session-identity/own-session.mjs';

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
 * Closed set of `degraded` reasons for {@link loadCommandsFromSessionConfigDetailed}.
 *
 * Its own enum, deliberately not shared with `ci-status-banner.mjs`'s
 * `DEGRADED_REASONS`: the members below are exactly the three ways THIS
 * config-read can fail, and an enum whose members are not exhaustively
 * reachable cannot be switched on exhaustively.
 *
 *   - `script-missing` — `scripts/parse-config.mjs` is not on disk.
 *   - `spawn-failed`   — the subprocess exited non-zero, timed out, or wrote
 *                        nothing to stdout.
 *   - `parse-error`    — stdout was not parseable JSON (or the read threw).
 */
export const CONFIG_READ_DEGRADED_REASONS = Object.freeze([
  'script-missing',
  'spawn-failed',
  'parse-error',
]);

/**
 * Does `repoRoot` carry a Session Config file at all?
 *
 * Mirrors the file-name precedence `scripts/parse-config.mjs::resolveConfigFile`
 * uses (`SO_CONFIG_FILE` → `CLAUDE.md` → `AGENTS.md`) but NOT its upward
 * project-root walk — see the ceiling note at the call site.
 *
 * @param {string} repoRoot
 * @returns {boolean}
 */
function sessionConfigFileExists(repoRoot) {
  try {
    const soConfigFile = process.env.SO_CONFIG_FILE;
    if (soConfigFile && existsSync(join(repoRoot, soConfigFile))) return true;
    return existsSync(join(repoRoot, 'CLAUDE.md')) || existsSync(join(repoRoot, 'AGENTS.md'));
  } catch {
    return false;
  }
}

/**
 * Load default commands from Session Config via `scripts/parse-config.mjs`,
 * distinguishing "the config declares no `*-command` keys" from "the config
 * could not be read at all".
 *
 * Both cases yield `commands: {}` — that half is unchanged, and every command
 * resolution keeps falling through to DEFAULT_COMMANDS exactly as before. What
 * is new is the second channel: on failure the result also carries a
 * `degraded` reason from {@link CONFIG_READ_DEGRADED_REASONS}. Without it,
 * `checkQgCommandDrift` reported "no drift" for a config it never managed to
 * read — a silent all-clear derived from an absent measurement (#1031's
 * failure class, one consumer over).
 *
 * `degraded` is OMITTED, not set to null, on the success path, so a strict
 * `toEqual({commands: {…}})` pin holds for every readable config.
 *
 * Never throws.
 *
 * @param {string} repoRoot
 * @returns {{commands: {lint?: string, typecheck?: string, test?: string},
 *            degraded?: 'script-missing'|'spawn-failed'|'parse-error'}}
 */
export function loadCommandsFromSessionConfigDetailed(repoRoot) {
  try {
    const scriptPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'parse-config.mjs',
    );
    if (!existsSync(scriptPath)) return { commands: {}, degraded: 'script-missing' };
    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    if (result.status !== 0 || !result.stdout) {
      // `parse-config.mjs` exits 1 for EVERY failure, including the benign
      // "this repo has no CLAUDE.md / AGENTS.md at all" — measured 2026-09-05
      // in an empty tmp dir: stderr `CLAUDE.md or AGENTS.md required`, exit 1.
      // A repo with no Session Config has no `*-command` value that could
      // drift, so reporting that as a failed READ would fire a warning on every
      // such repo (`.claude/rules/host-resources.md` § HR-101 — a warning class
      // that is usually present is a broken instrument).
      //
      // Ceiling (BV-004): `parse-config.mjs` resolves its config via
      // `findProjectRoot(cwd)` walking UPWARD, this check looks only at
      // `repoRoot` itself. For a `repoRoot` nested below the project root the
      // two disagree — and the disagreement resolves toward SILENCE (no
      // `degraded`), i.e. the pre-#1031 behaviour, never toward a false alarm.
      // Revisit if a caller starts passing sub-directory roots.
      return sessionConfigFileExists(repoRoot)
        ? { commands: {}, degraded: 'spawn-failed' }
        : { commands: {} };
    }
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
    return { commands: out };
  } catch {
    return { commands: {}, degraded: 'parse-error' };
  }
}

/**
 * Load default commands from Session Config via `scripts/parse-config.mjs`.
 * Returns a partial object — keys that fail to resolve are simply absent
 * (the caller falls through to DEFAULT_COMMANDS for those).
 *
 * Thin wrapper over {@link loadCommandsFromSessionConfigDetailed}; byte-identical
 * return value for every input, including every failure path. Callers that need
 * to tell a failed read from an empty config use the detailed variant.
 *
 * Never throws.
 *
 * @param {string} repoRoot
 * @returns {{lint?: string, typecheck?: string, test?: string}}
 */
export function loadCommandsFromSessionConfig(repoRoot) {
  return loadCommandsFromSessionConfigDetailed(repoRoot).commands;
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
 * Parse `git status --porcelain -z` stdout into repo-root-relative paths.
 *
 * `-z` is not a convenience flag here — it is the only shape of this command
 * whose paths are unambiguous. Measured 2026-08-23 (git 2.53.0) on a fixture
 * carrying a space, a non-ASCII name, a literal `"` and a rename:
 *
 * ```
 *   git status --porcelain            git status --porcelain -z
 *   ------------------------------    ---------------------------------
 *    M "scripts/lib/old name.mjs"      M scripts/lib/old name.mjs
 *    M "scripts/lib/\303\274ml.mjs"    M scripts/lib/üml.mjs
 *   ?? "scripts/lib/quo\"te.mjs"      ?? scripts/lib/quo"te.mjs
 *   R  old.mjs -> new.mjs             R  new.mjs \0 old.mjs
 * ```
 *
 * The non-`-z` form C-quotes any path containing a space, a `"` or — under the
 * default `core.quotePath=true` — a non-ASCII byte. `-c core.quotePath=false`
 * repairs only the non-ASCII third of that (measured: the space and the `"`
 * stayed quoted). A field-splitting parser over the non-`-z` form fails three
 * separate ways on one input — measured `awk '{print $2}'` output for the four
 * lines above: `"scripts/lib/old` (truncated at the space), the undecoded
 * `\303\274` octal escape, and `old.mjs` (the PRE-rename path) for the `R`
 * line. `-z` emits every path verbatim, so there is no unquoting step to get
 * wrong.
 *
 * Rename/copy entries carry their ORIGINAL path as the NEXT NUL field, with NO
 * `XY ` prefix. Consuming that extra field is mandatory, not optional: a naive
 * per-field `slice(3)` would emit `.mjs`-suffixed garbage (`d.mjs` for
 * `old.mjs`) as if it were a real path. Both paths are kept — a file moved OUT
 * of `scripts/lib/` is as much a shared-lib touch as one moved in, and a fixer
 * needs the old path to make sense of the new one. `R`/`C` are checked in BOTH
 * status columns because git-status(1) documents `R `/`C ` (renamed/copied in
 * index) as well as ` R`/` C` (renamed/copied in work tree).
 *
 * Untracked DIRECTORIES are not a case this parser has to handle: the caller
 * passes `-uall`, which expands them to individual files (measured: `?? nd/`
 * became `?? nd/a.mjs` + `?? nd/b.mjs`).
 *
 * @param {string} raw — raw stdout of `git status --porcelain -z …`.
 * @returns {string[]} repo-root-relative paths, in git's emission order.
 */
function parsePorcelainZ(raw) {
  const fields = String(raw ?? '').split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    // `XY P` is the shortest well-formed entry. Anything shorter — including
    // the empty trailing field `split` always produces — is not an entry
    // header, and the `[2] === ' '` check rejects a stray original-path field
    // that a malformed stream could leave unconsumed.
    if (typeof entry !== 'string' || entry.length < 4 || entry[2] !== ' ') continue;
    const filePath = entry.slice(3);
    if (filePath) paths.push(filePath);
    const x = entry[0];
    const y = entry[1];
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1;
      const original = fields[i];
      if (typeof original === 'string' && original) paths.push(original);
    }
  }
  return paths;
}

/**
 * Files that differ between `baseRef` and `HEAD` — the COMMITTED half of the
 * change set. Best-effort: `[]` on any git failure.
 *
 * @param {string} repoRoot
 * @param {string} baseRef
 * @returns {string[]}
 */
function listCommittedChangedFiles(repoRoot, baseRef) {
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
 * Files modified, staged, or untracked in the WORKING TREE — the uncommitted
 * half of the change set. Best-effort: `[]` on any git failure.
 *
 * `-uall` lists untracked files individually instead of collapsing a new
 * directory to `dir/`; measured 2026-08-23 on this repo it costs nothing
 * (`-uall` 30-33 ms vs `-unormal` 30-32 ms over 3 runs each), because ignored
 * trees — `node_modules/`, `.orchestrator/runtime/` — are never walked.
 *
 * Ceiling (BV-004): the union below relies on `.gitignore` to keep the
 * orchestrator's OWN runtime artifacts out of the result. In this repo
 * `.orchestrator/runtime/`, `current-session.json` and `session.lock` are all
 * ignored (`git check-ignore -v`, measured 2026-08-23), so the gate's
 * `last-green-sha.txt` write cannot show up as a "changed file". A consumer
 * repo that does NOT ignore `.orchestrator/` will see those artifacts here.
 * Revisit if a caller needs a hard exclusion rather than a gitignore-derived
 * one.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
function listWorkingTreeChangedFiles(repoRoot) {
  try {
    const result = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return parsePorcelainZ(result.stdout);
  } catch {
    return [];
  }
}

/**
 * List files this wave touched since `ref` (or HEAD~1 if no ref) — the UNION of
 * the committed diff and the working tree.
 *
 * The union is the whole point (#1058). The committed half alone answered a
 * question nobody asks: wave agents never commit — `.claude/rules/parallel-sessions.md`
 * § PSA-007 forbids every git-write operation to a dispatched subagent, and the
 * auto-commit that would have closed the gap does not exist (`skills/wave-executor/wave-loop.md`
 * marks it "not yet implemented as of v3.10.0"; `scripts/lib/auto-commit.mjs` is
 * absent, verified 2026-08-23). So at the moment {@link detectSharedLibTouch}
 * runs, every file the wave produced is UNCOMMITTED, and a committed-only diff
 * reports the previous coordinator commit's files or nothing at all. The FL-3
 * auto-promotion to the Full Gate could therefore never fire on the wave's own
 * work — structurally, not occasionally.
 *
 * Each half is independently best-effort: a failure in one contributes nothing
 * and does not suppress the other. Both fail (no repo at all, unreadable index)
 * → `[]`, preserving the documented never-throw / never-block contract.
 *
 * @param {string} repoRoot
 * @param {string|null} ref
 * @returns {string[]} de-duplicated, lexicographically sorted.
 */
function listChangedFiles(repoRoot, ref) {
  const baseRef = ref ?? 'HEAD~1';
  const union = new Set([
    ...listCommittedChangedFiles(repoRoot, baseRef),
    ...listWorkingTreeChangedFiles(repoRoot),
  ]);
  return [...union].sort();
}

/**
 * The id-space THIS process belongs to, for comparison against a repo-global
 * file that any session in the working copy may have written.
 *
 * Process-local witnesses ONLY (`CLAUDE_CODE_SESSION_ID`, via
 * {@link readProcessLocalSessionIds}) — the `session.lock` fallback this
 * function used to carry is deliberately GONE, not merely deprioritised.
 * `session.lock` is a repo-GLOBAL artefact any session in the working copy
 * can hold; unioning or falling back to it made a shared resource stand in
 * for a process-local identity, which is exactly the #1194 hazard class
 * (`.claude/rules/host-resources.md` § HR-102 — "a better signal REPLACES a
 * worse one, it does not merely suppress it"). Concretely for this module
 * (#1205): without the env var, a process that is NOT the lock holder used to
 * silently adopt the lock holder's id as its own, so a `current-session.json`
 * written by that same holder passed the ownership check by construction.
 * `readProcessLocalSessionIds()` (`./session-identity/own-session.mjs`) is
 * the shared, already-hardened implementation of this exact question — see
 * its JSDoc for the full lock/STATE.md exclusion rationale.
 *
 * An empty result is not a mismatch: {@link classifyCurrentSessionOwnership}
 * treats an empty `ownIds` as `'unknown'`, never `'foreign'`, so
 * `corrective_context` is kept — the existing fail-open contract from #1058,
 * unchanged by this fix.
 *
 * @returns {Set<string>} possibly empty — an empty set means "identity
 *   unresolvable", which the classifier below treats as `unknown`, never as a
 *   mismatch.
 */
function readOwnSessionIds() {
  return new Set(readProcessLocalSessionIds({ env: process.env, hookInput: null }));
}

/**
 * Decide whether a parsed `current-session.json` belongs to THIS session.
 *
 * Three outcomes, and the middle one is load-bearing:
 *
 *   - `'foreign'` — the file names at least one session id, we know at least
 *     one of our own, and NONE of them match. This is the only verdict that
 *     discards data.
 *   - `'unknown'` — the file names no id, or we could not resolve our own.
 *     Ownership is unproven in BOTH directions, so the content is kept. A file
 *     without an id cannot be attributed to a peer either; discarding it would
 *     turn "cannot tell" into a silent feature-off on every harness that
 *     exports no session id.
 *   - `'own'` — an id matched.
 *
 * Rejecting only what is PROVABLY foreign is the point. The hazard being closed
 * (#1058 second finding) is a peer session's corrective hints briefing this
 * session's fixer agent, and that hazard always carries a concrete, mismatching
 * id — the live file in this repo carried `conflict_with_session_id` from a
 * genuine second session while it was measured.
 *
 * Residual gap this classifier CANNOT close, because it is a property of the
 * writer: `hooks/post-tool-failure-corrective-context.mjs` appends to whatever
 * `current-session.json` it finds without checking or stamping ownership, and
 * `hooks/on-session-start.mjs` rewrites the identity block on session start.
 * Two live sessions therefore interleave entries into ONE array under the
 * NEWER session's id. This check catches the older session reading the newer
 * session's file (verdict `foreign`); it cannot un-mix entries inside a file
 * that legitimately carries our own id. Per-entry attribution belongs to the
 * writer hook, not here.
 *
 * @param {unknown} parsed — parsed `current-session.json` content.
 * @param {Set<string>} ownIds
 * @returns {{ verdict: 'own'|'foreign'|'unknown', fileIds: string[] }}
 */
function classifyCurrentSessionOwnership(parsed, ownIds) {
  const fileIds = [];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const key of ['session_id', 'semantic_session_id']) {
      const value = typeof parsed[key] === 'string' ? parsed[key].trim() : '';
      if (value) fileIds.push(value);
    }
  }
  if (fileIds.length === 0 || ownIds.size === 0) return { verdict: 'unknown', fileIds };
  const matched = fileIds.some((id) => ownIds.has(id));
  return { verdict: matched ? 'own' : 'foreign', fileIds };
}

/**
 * Read `corrective_context` array from `.orchestrator/current-session.json`.
 * Returns the most-recent N entries. Empty array on missing file / parse failure
 * — and, since #1058, on a file that provably belongs to ANOTHER session.
 *
 * `current-session.json` is repo-global: every session sharing this working
 * copy writes to the same path. Without the ownership check below, a peer
 * session's tool-failure hints were forwarded verbatim into THIS session's
 * fixer-agent prompt, which is how a fixer gets briefed on a failure that never
 * happened in the tree it is editing.
 *
 * A foreign file is treated as ABSENT — and said out loud on stderr. A silent
 * discard and a silent misuse are the same error class: both leave the operator
 * unable to tell that two sessions are contending for this working copy. The
 * WARN is not de-duplicated; this function runs at most once per fixer dispatch
 * plus once at abort, and each line marks a distinct decision point.
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
    const ownIds = readOwnSessionIds();
    const { verdict, fileIds } = classifyCurrentSessionOwnership(parsed, ownIds);
    if (verdict === 'foreign') {
      process.stderr.write(
        `⚠️  quality-gate: .orchestrator/current-session.json belongs to another session ` +
        `(${fileIds.join(', ')}) — corrective context ignored. ` +
        'Another session is active in this working copy (PSA-001).\n',
      );
      return [];
    }
    // The fail-open half of `verdict === 'unknown'`: the file DOES name an id,
    // but this process has no process-local witness of its own (ownIds is
    // empty — no `CLAUDE_CODE_SESSION_ID`, e.g. Codex/Cursor). Ownership is
    // unprovable, so the content is kept per the #1058 contract — but silently
    // is the wrong word for that: make the fail-open visible on stderr rather
    // than indistinguishable from a verified 'own' match.
    if (verdict === 'unknown' && fileIds.length > 0 && ownIds.size === 0) {
      process.stderr.write(
        '⚠ quality-gate: cannot verify ownership of .orchestrator/current-session.json ' +
        '(no process-local session id — CLAUDE_CODE_SESSION_ID unset); keeping corrective_context ' +
        `from session ${fileIds.join(', ')} UNVERIFIED\n`,
      );
    }
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
 * Since #1058 the underlying change set is the UNION of the committed diff and
 * the UNCOMMITTED working tree. Without the second half this detector could
 * never fire on the wave's own work: PSA-007 forbids a dispatched subagent
 * every git-write, so at the moment this runs the wave's edits are uncommitted
 * by construction — see {@link listChangedFiles}.
 *
 * Safe-default: a git failure on one half (missing sinceRef, detached HEAD, no
 * commits) simply contributes nothing; both halves failing returns
 * `{ touched: false, paths: [] }` so the gate never blocks a session.
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
 * INPUT ADAPTER for this module's `counts` field (#954, #967 item 2).
 *
 * Holds NO admission policy of its own. Every verdict — including both
 * rejections this function used to make itself — is delegated to
 * {@link admitSuiteCounts}, the single policy shared with the CLI producer
 * `suiteCountsFromGateStdout` (`scripts/run-quality-gate.mjs`). Before that
 * convergence the two producers wrote the SAME event field under DIFFERENT
 * rules (this one admitted `passed > total` and a negative `passed`), so a
 * consumer had to know two policies to read one field.
 *
 * What stays here is the part the shared policy cannot see: the raw-text tail
 * parse. `extractTestCounts` has no "did it match?" channel — it returns
 * `0/0/0` both for "no `<N> passed` marker in the output" and for a genuinely
 * empty run — so a text-less input is handed to the policy as `null` rather
 * than as a zero triple, and the policy refuses it. The result is `null`, never
 * a zero triple: `counts.failed === 0` means "measured, zero failures"; an
 * ABSENT `counts` means "not measured".
 *
 * That null hand-over is ALSO how this adapter reports "the gate loop never
 * reached the test step" (#969 MED-2). A `null` output fails the string check on
 * the first line, so the positional evidence and the unparseable-text case land
 * on the SAME channel the policy already has to check. The policy previously
 * took a second `measured` boolean for the positional case; it was unreachable
 * with a non-null triple precisely because this line runs first, and two ways to
 * say "not measured" is one more than the field can be read with.
 *
 * @param {string|null} output — captured stdout+stderr tail from the test gate,
 *   or `null` when the gate loop never reached the test step.
 * @returns {{ passed: number, failed: number, total: number }|null}
 */
function suiteCountsFromOutput(output) {
  if (typeof output !== 'string' || output.length === 0) {
    return admitSuiteCounts(null);
  }
  return admitSuiteCounts(extractTestCounts(output));
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
 * Emit exactly one `orchestrator.quality_gate.{passed,failed}` event per
 * `runQualityGateWithRetry` CALL (#928b).
 *
 * NO DOUBLE-COUNTING. The two gate paths never nest:
 *   - `scripts/run-quality-gate.mjs` spawns `scripts/lib/gates/gate-*.mjs`
 *     directly and does not import this module;
 *   - this module spawns the resolved gate COMMANDS (and `parse-config.mjs`)
 *     directly and does not invoke that wrapper.
 * A single run therefore passes through exactly one emitter.
 *
 * Granularity is the CALL, not the attempt: the retry loop may run the gates
 * up to `maxRetries + 1` times, but emitting per attempt would inflate every
 * rate computed over these events. `attempts` carries that detail instead.
 * `variant: 'auto-fix-loop'` distinguishes this path from the CLI's
 * baseline/incremental/full-gate/per-file variants.
 *
 * The destination is pinned to the `repoRoot` this gate actually ran against,
 * via the `opts.repoRoot` parameter (#941; formerly a hand-built `opts.filePath`
 * recipe, #611). `emitEvent`'s BARE default resolution goes through the
 * module-level `SO_PROJECT_DIR` constant, which ignores `repoRoot` entirely — so
 * a caller running the gate against another tree (every unit test does, using a
 * tmp `repoRoot`) would otherwise append synthetic records to the REAL repo's
 * telemetry. That is not a test-hygiene nicety: injected `quality_gate.failed`
 * records are exactly what `/eval`'s gate-health dimension reads, so the
 * instrument would be scored against its own test fixtures.
 *
 * `counts` (#954) carries the suite numbers this gate already had in hand. It
 * is OMITTED — never zero-filled — whenever the final attempt did not reach the
 * test gate (fail-fast on lint/typecheck) or its output carried no parseable
 * count. See {@link suiteCountsFromOutput}.
 *
 * IT DOES NOT YET REPLACE THE PROSE PATH (#957/F1 — the earlier wording here
 * claimed it did). `waves[].suite_passed` / `suite_failed` still travel as prose
 * through two LLM hops: `skills/wave-executor/wave-loop.md` step 7 hand-writes
 * them, `skills/session-end/metrics-collection.md` § 1.7 parses them back out of
 * the STATE.md Wave History header into sessions.jsonl. `counts` is a SECOND,
 * machine-measured emission of the same fact, and as of 2026-07-31 it has zero
 * readers (`grep -c '"counts"' .orchestrator/metrics/events.jsonl` → 0 across
 * 4404 `orchestrator.quality_gate.*` records).
 *
 * Retiring the prose path needs a producer change no docblock can make:
 * `waves[].*` is PER-WAVE, and gate events carry no `wave_number` (0 of those
 * 4404 records). A session-end reader could only attribute a gate event to a
 * wave by a wall-clock window whose own boundaries (`waves[].started_at` /
 * `completed_at`) are themselves LLM-written — one LLM hop traded for another,
 * against the posture `scripts/lib/eval/session-resolve.mjs` already documents
 * for window-attributed gate events ("a contaminated window means
 * gate-attribution is unsafe"). The concrete remaining work is named in
 * `skills/session-end/metrics-collection.md` § 1.7.
 *
 * Note also that THIS emitter only runs under `verification-auto-fix.enabled:
 * true` (default `false`, and `false` in this repo's Session Config). The gate
 * that actually fires between waves is the `scripts/run-quality-gate.mjs`
 * wrapper, which emits its own `counts` via `suiteCountsFromGateStdout` — under
 * the SAME admission policy since #967 item 2 (`admitSuiteCounts`), so a
 * consumer reads one field with one set of rules regardless of which producer
 * wrote it.
 *
 * Extraction margin: {@link suiteCountsFromOutput} sees only the
 * `OUTPUT_TAIL_LINES` (50) tail `runCheck` retains. Measured on `npm test`
 * (vitest 2026-07-31), the `Tests` summary line sits 5 lines from the end — 45
 * lines of headroom. A runner epilogue longer than that (coverage table, long
 * unhandled-error dump) pushes the summary out of the window; `counts` is then
 * omitted, which fails safe but is indistinguishable from "no test gate ran".
 *
 * Best-effort: never throws, never alters the gate verdict.
 *
 * @param {string} repoRoot
 * @param {boolean} ok
 * @param {number} attempts
 * @param {string|null} gate
 * @param {{passed: number, failed: number, total: number}|null} [counts]
 */
async function emitGateEvent(repoRoot, ok, attempts, gate, counts) {
  try {
    await emitEvent(
      `orchestrator.quality_gate.${ok ? 'passed' : 'failed'}`,
      {
        variant: 'auto-fix-loop',
        exit_code: ok ? 0 : 1,
        attempts,
        ...(gate ? { gate } : {}),
        ...(counts ? { counts } : {}),
        ...sessionAttribution(repoRoot),
      },
      { repoRoot },
    );
  } catch { /* best-effort telemetry — gate result is authoritative */ }
}

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
  /**
   * Suite counts observed in the CURRENT attempt only (#954). Re-assigned
   * unconditionally after every attempt's gate loop, so a failure that
   * fail-fasts on lint can never re-report a stale count from an earlier
   * attempt's test run.
   * @type {{passed: number, failed: number, total: number}|null}
   */
  let testCounts = null;

  // Total loop budget = maxRetries + 1 (one initial run + up to maxRetries fixer-driven retries).
  const totalAttempts = maxRetries + 1;

  while (attempt < totalAttempts) {
    attempt += 1;
    let gateFailure = null;
    /**
     * The test gate's captured output for THIS attempt — `null` until the
     * `test` branch below assigns it, which happens only if the gate loop
     * actually reaches the test step. A fail-fast on lint or typecheck leaves
     * it `null`.
     *
     * That null-ness is the positional evidence {@link admitSuiteCounts}
     * cannot observe for itself: the shared policy sees a candidate triple and
     * nothing else, never the control flow that produced it. It reaches the
     * policy AS the null triple {@link suiteCountsFromOutput} hands over, so an
     * unmeasured gate can never publish a zero triple attributed to a run that
     * never happened.
     * @type {string|null}
     */
    let testOutput = null;

    for (const gate of GATE_ORDER) {
      const cmd = commands[gate];
      const result = runGate(cmd, repoRoot);
      if (gate === 'test') {
        // The numbers are in hand right here — capture them at the seam rather
        // than letting them travel as prose (#954).
        testOutput = result.output;
      }
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

    // Non-fatal by construction: an unmeasured, unparseable or inconsistent
    // run yields null, which the emitter omits rather than zero-fills.
    testCounts = suiteCountsFromOutput(testOutput);

    if (gateFailure === null) {
      // All gates passed this attempt.
      writeLastGreenSha(repoRoot);
      await emitGateEvent(repoRoot, true, attempt, null, testCounts);
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

  await emitGateEvent(repoRoot, false, attempt, lastFailure?.gate ?? null, testCounts);

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

