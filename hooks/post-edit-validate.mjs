#!/usr/bin/env node
/**
 * post-edit-validate.mjs — PostToolUse hook for incremental validation after Edit/Write/MultiEdit.
 *
 * Node.js port of hooks/post-edit-validate.sh. Part of v3.0.0 Windows-native migration.
 * Issue: github.com/Kanevry/session-orchestrator/issues/139
 *
 * Runs incremental typecheck on the file that was just edited.
 * This is informational only — it NEVER blocks (always exits 0).
 *
 * Decision flow:
 *   G1  stdin null → silent exit 0
 *   G2  tool_name filter — only Edit/Write/MultiEdit trigger typecheck
 *   G3  file_path present
 *   G4  file extension filter — only .ts|.tsx|.js|.jsx|.mjs|.cjs
 *   G5  gate check — wave-scope.json.gates['post-edit-validate'] === false → exit 0
 *   G6  resolve typecheck command: Session Config → tsgo → tsc → local tsc → skip
 *   G7  run typecheck with 2s process-group timeout
 *   G8  emit JSONL result to stderr
 *
 * Output (stderr): {"check":"typecheck","status":"pass|fail|timeout|skip","file":"<rel>","duration_ms":<int>}
 * Exit codes: 0 — always (PostToolUse hooks are informational)
 *
 * SECURITY notes:
 *   REQ-01  top-level try/catch → silent exit 0 on unexpected error (never blocks)
 *   REQ-02  typecheck runs the intact shell command; timeout kills its process tree
 *   REQ-03  relative path computed via path.relative(projectRoot, absFilePath)
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnInGroup } from '../scripts/lib/process-group.mjs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';

import { readStdin } from '../scripts/lib/io.mjs';
import { resolveSessionRoot } from '../scripts/lib/platform.mjs';
import { gateEnabled } from '../scripts/lib/hardening.mjs';
import { findOwnScopeFile } from '../scripts/lib/scope-gate.mjs';
import {
  classifyManifestSession,
  readProcessLocalSessionIds,
} from '../scripts/lib/session-identity/own-session.mjs';
import { readConfigFile, parseSessionConfig } from '../scripts/lib/config.mjs';
import { spawnSync } from '../scripts/lib/native-command.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** File extensions that trigger typecheck. */
const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Emit the JSONL result line to stderr.
 * @param {string} file            - relative file path
 * @param {'pass'|'fail'|'timeout'|'skip'} status
 * @param {number} [duration_ms]   - omit for skip
 * @param {string} [reason]        - human-readable reason for skip, timeout or fail
 * @param {string} [remediation]   - actionable fix hint for fail status only
 */
function emitResult(file, status, duration_ms, reason, remediation) {
  const obj = { check: 'typecheck', status, file };
  if (typeof duration_ms === 'number') obj.duration_ms = duration_ms;
  if (reason !== undefined) obj.reason = reason;
  if (remediation !== undefined) obj.remediation = remediation;
  process.stderr.write(JSON.stringify(obj) + '\n');
}

/**
 * Try to resolve the typecheck command.
 * Order: Session Config typecheck-command → tsgo → tsc → local tsc → null
 *
 * @param {string} projectRoot
 * @returns {Promise<string|string[]|null>}
 */
async function resolveTypecheckCommand(projectRoot) {
  // 1. Session Config typecheck-command
  try {
    const md = await readConfigFile(projectRoot);
    const config = parseSessionConfig(md);
    const cmd = config['typecheck-command'];
    if (cmd && typeof cmd === 'string') {
      const command = cmd.trim();
      return command === 'skip' ? null : command || null;
    }
  } catch {
    // config unavailable — fall through
  }

  // 2. tsgo
  const tsgoParts = _tryWhich('tsgo');
  if (tsgoParts) return 'tsgo --noEmit';

  // 3. tsc
  const tscParts = _tryWhich('tsc');
  if (tscParts) return 'tsc --noEmit';

  // 4. Only an installed project compiler; npx may install the unrelated
  // npm package `tsc` in projects without TypeScript (#1612).
  const localTsc = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(localTsc)) return [process.execPath, localTsc, '--noEmit'];

  return null;
}

/**
 * Check whether an executable exists on PATH using `which` / `where` (sync).
 * Returns the executable name if found, null otherwise. Never throws.
 *
 * @param {string} name
 * @returns {string|null}
 */
function _tryWhich(name) {
  const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  // Two lookups get at most 1s total; revisit together with the outer
  // 5s hook budget if a host needs slower executable discovery.
  try {
    const result = spawnSync(whichCmd, [name], { encoding: 'utf8', timeout: 500 });
    if (result.status === 0 && result.stdout.trim()) return name;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Configured commands retain shell semantics; the local compiler uses Node argv.
 * Keep cleanup short for hooks.json's 5s budget; Windows skips CIM verification.
 * @param {string|string[]} cmd
 * @param {string} projectRoot
 * @returns {Promise<{status: 'pass'|'fail'|'timeout', duration_ms: number, reason?: string}>}
 */
async function runTypecheck(cmd, projectRoot) {
  const result = await spawnInGroup(cmd, {
    cwd: projectRoot,
    timeoutMs: 2000,
    // Hook-specific ceiling: escalate quickly so an uncooperative compiler
    // cannot consume the outer 5s hook budget. Revisit if compiler cleanup
    // needs more than 100ms; the hook's outer budget must change with it.
    killGraceMs: 100,
    verifyWaitMs: 100,
    // Two PowerShell startups would exceed the remaining hook budget (R1-04).
    verifyTree: false,
  });
  const duration_ms = Math.max(0, Math.round(result.durationMs));
  if (result.timedOut) {
    return { status: 'timeout', duration_ms, reason: 'typecheck timed out after 2s' };
  }
  if (result.exitCode !== 0) {
    const firstLine = result.fullOutput.split('\n').find((line) => line.trim()) ?? 'typecheck exited non-zero';
    return { status: 'fail', duration_ms, reason: firstLine.slice(0, 256) };
  }
  return { status: 'pass', duration_ms };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // G1: null stdin → silent exit 0
  let input;
  try {
    input = await readStdin();
  } catch {
    process.exit(0);
  }
  if (!input) process.exit(0);

  const toolName = input.tool_name;
  const filePath = input?.tool_input?.file_path;

  // G2: only Edit, Write, and MultiEdit trigger typecheck
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') process.exit(0);

  // G3: file_path must be present
  if (!filePath || typeof filePath !== 'string') process.exit(0);

  // G4: extension filter — only TS/JS variants
  const ext = path.extname(filePath).toLowerCase();
  if (!TS_EXTS.has(ext)) process.exit(0);

  // The SESSION root the scope guards use (#1492, #1504 point 4) — not the
  // launch dir, which stays put while a session works in an entered worktree.
  const projectRoot = resolveSessionRoot(input?.cwd);

  // Compute relative path (REQ-03)
  const absFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectRoot, filePath);
  const relPath = path.relative(projectRoot, absFilePath);

  // G5: per-gate toggle — skip if post-edit-validate gate is disabled. Only
  // THIS session's manifest may switch it off: a peer's manifest in the same
  // working copy is skipped, and a peer-only result means no toggle (#1504).
  const ownIds = new Set(readProcessLocalSessionIds({ hookInput: input }));
  const { path: scopeFile } = findOwnScopeFile(projectRoot, ownIds, classifyManifestSession);
  if (scopeFile && !gateEnabled(scopeFile, 'post-edit-validate')) {
    process.exit(0);
  }

  // G6: resolve typecheck command
  const tc = await resolveTypecheckCommand(projectRoot);
  if (!tc) {
    emitResult(relPath, 'skip', undefined, 'no typecheck command found');
    process.exit(0);
  }

  // G7: run typecheck with 2s timeout (REQ-02)
  const { status, duration_ms, reason } = await runTypecheck(tc, projectRoot);

  // G8: emit JSONL result to stderr
  const remediation =
    status === 'fail'
      ? 'Run `npm run typecheck` to see full error context, then fix the type at the cited location.'
      : undefined;
  emitResult(relPath, status, duration_ms, reason, remediation);

  process.exit(0);
}

// REQ-01: top-level catch — PostToolUse must never block; always exit 0
// Entry guard (#1393): run only when this file IS the script node was invoked
// with — every harness path execs it (`sh run-node.sh <this file>`). A bare
// `import()` (a probe, a test, a curious agent) must neither run main() nor
// tear the importing process down. The profile gate sits INSIDE the guard for
// that second reason: at module top level its `process.exit(0)` exited every
// process that merely imported this hook.
if (isMainModule(import.meta.url)) {
  if (!shouldRunHook('post-edit-validate')) process.exit(0);
  main().catch(() => {
    process.exit(0);
  });
}
