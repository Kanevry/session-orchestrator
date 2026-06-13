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
 *   G6  resolve typecheck command: Session Config → tsgo → tsc → npx tsc → skip
 *   G7  run typecheck with 2s AbortController timeout
 *   G8  emit JSONL result to stderr
 *
 * Output (stderr): {"check":"typecheck","status":"pass|fail|skip","file":"<rel>","duration_ms":<int>}
 * Exit codes: 0 — always (PostToolUse hooks are informational)
 *
 * SECURITY notes:
 *   REQ-01  top-level try/catch → silent exit 0 on unexpected error (never blocks)
 *   REQ-02  typecheck process uses AbortController (not shell `timeout` — cross-platform)
 *   REQ-03  relative path computed via path.relative(projectRoot, absFilePath)
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('post-edit-validate')) process.exit(0);

import { readStdin } from '../scripts/lib/io.mjs';
import { resolveProjectDir } from '../scripts/lib/platform.mjs';
import { findScopeFile, gateEnabled } from '../scripts/lib/hardening.mjs';
import { readConfigFile, parseSessionConfig } from '../scripts/lib/config.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** File extensions that trigger typecheck. */
const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Emit the JSONL result line to stderr.
 * @param {string} file            - relative file path
 * @param {'pass'|'fail'|'skip'} status
 * @param {number} [duration_ms]   - omit for skip
 * @param {string} [reason]        - human-readable reason for skip or fail
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
 * Order: Session Config typecheck-command → tsgo → tsc → npx tsc → null
 *
 * @param {string} projectRoot
 * @returns {Promise<{cmd: string, args: string[]}|null>}
 */
async function resolveTypecheckCommand(projectRoot) {
  // 1. Session Config typecheck-command
  try {
    const md = await readConfigFile(projectRoot);
    const config = parseSessionConfig(md);
    const cmd = config['typecheck-command'];
    if (cmd && typeof cmd === 'string') {
      const parts = cmd.trim().split(/\s+/);
      return { cmd: parts[0], args: parts.slice(1) };
    }
  } catch {
    // config unavailable — fall through
  }

  // 2. tsgo
  const tsgoParts = _tryWhich('tsgo');
  if (tsgoParts) return { cmd: tsgoParts, args: ['--noEmit'] };

  // 3. tsc
  const tscParts = _tryWhich('tsc');
  if (tscParts) return { cmd: tscParts, args: ['--noEmit'] };

  // 4. npx tsc
  const npxParts = _tryWhich('npx');
  if (npxParts) return { cmd: npxParts, args: ['tsc', '--noEmit'] };

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
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(whichCmd, [name], { encoding: 'utf8', timeout: 2000 });
    if (result.status === 0 && result.stdout.trim()) return name;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Run the typecheck command with a 2s AbortController timeout.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{status: 'pass'|'fail', duration_ms: number, reason?: string}}
 */
function runTypecheck(cmd, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);

  const start = performance.now();
  let spawnResult;
  try {
    spawnResult = spawnSync(cmd, args, {
      signal: controller.signal,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    });
  } finally {
    clearTimeout(timer);
  }

  const duration_ms = Math.max(0, Math.round(performance.now() - start));

  // AbortError or SIGTERM from timeout
  if (spawnResult.error?.name === 'AbortError' || spawnResult.signal === 'SIGTERM') {
    return { status: 'fail', duration_ms, reason: 'typecheck timed out after 2s' };
  }

  if (spawnResult.status !== 0) {
    // Capture the first non-empty line of stderr/stdout as a compact reason.
    const combined = ((spawnResult.stderr ?? '') + (spawnResult.stdout ?? '')).trim();
    const firstLine = combined.split('\n').find((l) => l.trim()) ?? 'typecheck exited non-zero';
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

  const projectRoot = resolveProjectDir();

  // Compute relative path (REQ-03)
  const absFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectRoot, filePath);
  const relPath = path.relative(projectRoot, absFilePath);

  // G5: per-gate toggle — skip if post-edit-validate gate is disabled
  const scopeFile = findScopeFile(projectRoot);
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
  const { status, duration_ms, reason } = runTypecheck(tc.cmd, tc.args);

  // G8: emit JSONL result to stderr
  const remediation =
    status === 'fail'
      ? 'Run `npm run typecheck` to see full error context, then fix the type at the cited location.'
      : undefined;
  emitResult(relPath, status, duration_ms, reason, remediation);

  process.exit(0);
}

// REQ-01: top-level catch — PostToolUse must never block; always exit 0
main().catch(() => {
  process.exit(0);
});
