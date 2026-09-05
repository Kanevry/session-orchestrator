#!/usr/bin/env node
/**
 * post-edit-import-probe.mjs — PostToolUse hook that catches a BROKEN
 * hook-reachable module the moment it is saved (GitLab #1224).
 *
 * Incident 2026-09-04: `scripts/lib/session-identity/own-session.mjs` was saved
 * with a call to a function that was written two edits later. Three hook entry
 * files import that module on every tool call, so every Bash/Edit/Write call
 * across the host — including two foreign sessions — got "Internal hook error —
 * request blocked" for ~8 minutes. The defect was invisible to `node --check`
 * (syntactically valid) and to a plain `await import()` (module-level
 * evaluation succeeds; the ReferenceError is raised only when the exported
 * function is CALLED). ESLint `no-undef` catches it — that is the primary check
 * here; the import probe is the secondary net for load-time throws.
 *
 * Decision flow (each gate exits 0 silently):
 *   G1  profile gate — shouldRunHook('post-edit-import-probe')
 *   G2  stdin JSON (null-safe)
 *   G3  tool_name ∈ {Edit, Write, MultiEdit}
 *   G4  tool_input.file_path present
 *   G5  extension ∈ {.mjs, .js, .cjs}
 *   G6  membership in hooks/_lib/hook-import-set.json (the committed
 *       hook-reachable allowlist) — anything else is not this probe's business
 *   C1  PRIMARY: ESLint on the single file; only `no-undef` and fatal/parse
 *       errors count as a failure (other rules belong to `npm run lint`)
 *   C2  SECONDARY (scripts/lib/** only — NEVER hooks/*.mjs, half of which run
 *       main() at module bottom): `await import(file)` in a child process
 *
 * The PRIMARY check needs an ESLint install in EITHER the project's own
 * `node_modules` (tried first — an npm-installed consumer repo has no plugin
 * devDeps) or the plugin root's; with neither, C1 degrades to a silent no-op
 * and only C2 remains. `SO_IMPORT_PROBE_ESLINT` overrides that resolution.
 *
 * Output on failure: an `additionalContext` roll-up + a `systemMessage`.
 * Exit codes: 0 ALWAYS — a probe for hook breakage must never become one
 * (the probe's own internal faults go to stderr, never to the tool call).
 */

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('post-edit-import-probe')) process.exit(0);

import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { getProjectDir } from '../scripts/lib/platform.mjs';

/** Tool names whose payload carries an edited file path. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** Extensions this probe can reason about (Node ESM/CJS modules). */
const MODULE_EXTS = new Set(['.mjs', '.js', '.cjs']);

/**
 * Total wall-clock budget for BOTH checks. The hooks.json ceiling is 5 s; the
 * measured ESLint single-file run is 0.3–0.5 s, so 3 s leaves headroom for a
 * cold start without ever approaching the harness timeout.
 */
const BUDGET_MS = 3_000;

/** The plugin's own root (…/hooks/.. ), used to locate a vendored ESLint. */
const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on any failure.
 *
 * @returns {Promise<object|null>}
 */
function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.closed) { resolve(null); return; }
    const chunks = [];
    const timer = setTimeout(() => resolve(null), 5_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const raw = chunks.join('').trim();
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
    process.stdin.resume();
  });
}

/**
 * Load the committed hook-reachable allowlist.
 * Missing / unreadable / malformed → empty map (silent no-op, never a crash).
 *
 * @param {string} projectDir
 * @returns {Map<string, string[]>} repo-relative path → hook entry basenames
 */
export function loadImportSet(projectDir) {
  const file = path.join(projectDir, 'hooks', '_lib', 'hook-import-set.json');
  try {
    if (!existsSync(file)) return new Map();
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const map = new Map();
    for (const e of entries) {
      if (e && typeof e.file === 'string') {
        map.set(e.file, Array.isArray(e.reachable_from) ? e.reachable_from : []);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Repo-relative POSIX path, or null when the file lives outside the project.
 *
 * @param {string} projectDir
 * @param {string} absFile
 * @returns {string|null}
 */
export function toRepoRelative(projectDir, absFile) {
  const rel = path.relative(projectDir, absFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Locate an ESLint entry script. The PROJECT's own install is tried first —
 * in an npm-installed consumer repo the plugin root has no devDependencies at
 * all, so a plugin-root-only lookup makes the primary check a silent no-op
 * there. Both the `.bin` shim and the package's own entry script are probed at
 * each root (a pnpm/npm layout may publish either).
 *
 * `SO_IMPORT_PROBE_ESLINT` overrides the search: an explicit path is used as
 * given, and an EMPTY value suppresses the check (test seam for the
 * eslint-unavailable path).
 *
 * Returns null when nothing is found → the check is skipped silently: a
 * consumer repo without ESLint installed is not a defect.
 *
 * @param {string} projectDir
 * @returns {string|null}
 */
export function resolveEslintBin(projectDir) {
  const override = process.env.SO_IMPORT_PROBE_ESLINT;
  if (typeof override === 'string') {
    if (!override) return null;
    try { return existsSync(override) ? override : null; } catch { return null; }
  }
  const candidates = [];
  for (const root of [projectDir, PLUGIN_ROOT]) {
    candidates.push(path.join(root, 'node_modules', '.bin', 'eslint'));
    candidates.push(path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'));
  }
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* unreadable → next candidate */ }
  }
  return null;
}

/**
 * PRIMARY check — run ESLint on the single file and keep only the message
 * classes that indicate a module which will THROW when a hook calls into it:
 * `no-undef` (the 2026-09-04 incident shape) and any fatal/parse error.
 *
 * @param {string} projectDir
 * @param {string} absFile
 * @param {number} timeoutMs
 * @returns {string|null} first offending message, or null when clean/skipped
 */
export function runEslintCheck(projectDir, absFile, timeoutMs) {
  const bin = resolveEslintBin(projectDir);
  if (!bin) {
    // ESLint unavailable → skip, never guess. Traced so a consumer repo can
    // tell "primary check found nothing" from "primary check never ran".
    if (process.env.SO_IMPORT_PROBE_TRACE) process.stderr.write('probe:eslint-unavailable\n');
    return null;
  }

  const res = spawnSync(
    process.execPath,
    [bin, '--no-warn-ignored', '--format', 'json', absFile],
    { cwd: projectDir, encoding: 'utf8', timeout: timeoutMs },
  );
  // A crashed/timed-out ESLint produces no parseable report — skip rather than
  // invent a finding. Same for a repo whose flat config cannot be resolved.
  let report;
  try { report = JSON.parse(res.stdout ?? ''); } catch { return null; }
  if (!Array.isArray(report)) return null;

  for (const fileResult of report) {
    for (const m of fileResult?.messages ?? []) {
      const isFatal = m.fatal === true;
      const isUndef = m.ruleId === 'no-undef';
      if (isFatal || isUndef) {
        return `L${m.line ?? '?'} ${m.ruleId ?? 'parse-error'}: ${m.message}`;
      }
    }
  }
  return null;
}

/**
 * SECONDARY check — actually import the module in a child process to catch a
 * load-time throw. Restricted to `scripts/lib/**`: roughly half the
 * `hooks/*.mjs` entry files call `main()` at module bottom, so importing one
 * would EXECUTE it.
 *
 * @param {string} absFile
 * @param {number} timeoutMs
 * @returns {string|null} first error line, or null when clean
 */
export function runImportCheck(absFile, timeoutMs) {
  const res = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { pathToFileURL } = await import('node:url');"
      + ' await import(pathToFileURL(process.env.SO_IMPORT_PROBE_TARGET).href);',
    ],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      // NO positional argument: a target passed as argv[1] satisfies the
      // `import.meta.url === file://${process.argv[1]}` main-guard that many
      // modules carry, so the probe would EXECUTE their CLI main() (measured:
      // scripts/lib/sunset/walker.mjs walks the repo for ~3.9 s and is then
      // SIGTERMed at the budget). The path travels in the environment instead.
      // The env is minimal and deliberately drops NODE_OPTIONS — an inherited
      // --require/--import would run foreign code inside the probe.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SO_HOOK_PROFILE: 'off',
        SO_IMPORT_PROBE_TARGET: absFile,
      },
    },
  );
  if (res.status === 0) return null;
  // A timeout (killed child, status null) is not evidence of breakage.
  if (res.status === null) return null;
  // Node echoes the offending SOURCE line before the diagnostic, and that echo
  // also contains the word "Error" — anchor on the diagnostic shape
  // ("ReferenceError: x is not defined") so the report names the fault, not the
  // source text that triggered it.
  const lines = String(res.stderr ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const diagnostic = lines.find((s) => /^[A-Za-z]*Error(:|\b)/.test(s));
  return diagnostic || lines.find((s) => /Error/.test(s)) || `import failed with exit ${res.status}`;
}

/**
 * Build the operator-facing warning. It names the blast radius explicitly —
 * the whole point of the probe is that a broken module here is not a local
 * defect.
 *
 * @param {string} relPath
 * @param {string} error
 * @param {string[]} reachableFrom
 * @returns {string}
 */
export function buildWarning(relPath, error, reachableFrom) {
  const hooks = reachableFrom.length > 0 ? reachableFrom.join(', ') : '(unknown)';
  return (
    `⚠ import-probe: ${relPath} — ${error}. ` +
    `This module is reached by hooks ${hooks} — every Edit/Write/Bash call may now be ` +
    `blocked host-wide. Fix before continuing.`
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const started = performance.now();
  const input = await readStdinJson();
  if (!input) return;                                                    // G2

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : null;
  if (!toolName || !EDIT_TOOLS.has(toolName)) return;                    // G3

  const toolInput = input.tool_input;
  const filePath = toolInput && typeof toolInput.file_path === 'string'
    ? toolInput.file_path : null;
  if (!filePath) return;                                                 // G4

  if (!MODULE_EXTS.has(path.extname(filePath).toLowerCase())) return;    // G5

  const projectDir = getProjectDir();
  const absFile = path.resolve(projectDir, filePath);
  const rel = toRepoRelative(projectDir, absFile);
  if (!rel) return;

  const importSet = loadImportSet(projectDir);
  if (!importSet.has(rel)) return;                                       // G6
  const reachableFrom = importSet.get(rel) ?? [];

  // Trace hook for tests: proves the gates above short-circuit BEFORE any spawn.
  if (process.env.SO_IMPORT_PROBE_TRACE) process.stderr.write('probe:checks-start\n');

  let error = runEslintCheck(projectDir, absFile, BUDGET_MS);            // C1
  let check = 'eslint';

  if (!error && rel.startsWith('scripts/lib/')) {                        // C2
    // spawnSync rejects a fractional timeout (RangeError) — round it.
    const remaining = Math.max(250, Math.round(BUDGET_MS - (performance.now() - started)));
    error = runImportCheck(absFile, remaining);
    if (error) check = 'import';
  }

  if (!error) return;

  const durationMs = Math.round(performance.now() - started);
  try {
    const { emitEvent } = await import('../scripts/lib/events.mjs');
    await emitEvent('orchestrator.hook.import_probe_failed', {
      file: rel,
      check,
      error,
      reachable_from: reachableFrom,
      duration_ms: durationMs,
    });
  } catch { /* best-effort telemetry — never blocks the hook */ }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: buildWarning(rel, error, reachableFrom),
    },
    systemMessage: `⚠ import-probe FAILED: ${rel}`,
  }));
}

// Exit 0 always — a hook that guards against hook breakage must never block.
// The catch stays silent towards the TOOL CALL but not towards the operator:
// a probe whose own breakage is invisible is a probe nobody can trust.
main()
  .catch((err) => {
    try {
      process.stderr.write(`post-edit-import-probe: ${err?.message ?? String(err)}\n`);
    } catch { /* stderr gone — nothing left to report to */ }
  })
  .finally(() => process.exit(0));
