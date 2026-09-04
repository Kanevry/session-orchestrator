#!/usr/bin/env node
/**
 * cwd-change-restore.mjs — CwdChanged hook handler.
 *
 * Hook event: CwdChanged (issue #342).
 * Fires when the coordinator's working directory changes unexpectedly.
 * Records the event in `.orchestrator/current-session.json` under the
 * `cwd_changes` array so the coordinator and downstream skills can
 * inspect recent directory changes without re-reading the full event log.
 *
 * Note: the actual CWD restoration is a harness-level concern; this
 * handler is informational only. It mirrors the pattern used by
 * post-tool-failure-corrective-context.mjs.
 *
 * Decision flow:
 *   1. shouldRunHook gate — exit 0 immediately when the hook is disabled.
 *   2. Read JSON payload from stdin: { previous_cwd, new_cwd }.
 *   3. Build a compact record: { timestamp, previous_cwd, new_cwd }.
 *   4. Atomic read-modify-write of .orchestrator/current-session.json:
 *      append to `cwd_changes` array (create if absent), keep last 20
 *      entries to bound file growth.
 *   5. Output: nothing on stdout. Diagnostic errors to stderr only.
 *
 * Exit codes: 0 always (informational, never blocking).
 */

import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('cwd-change-restore')) process.exit(0);

import { getProjectDir } from '../scripts/lib/platform.mjs';
import { atomicMutateJson } from './_lib/atomic-json.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of cwd_change entries retained per session. */
const MAX_ENTRIES = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on failure.
 * Uses a 5 s timeout consistent with Claude Code hook contract.
 *
 * @returns {Promise<object|null>}
 */
function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.closed) {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => { resolve(null); }, 5_000);
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();

  const previousCwd =
    typeof input?.previous_cwd === 'string' ? input.previous_cwd : null;
  const newCwd =
    typeof input?.new_cwd === 'string' ? input.new_cwd : null;

  const record = {
    timestamp: new Date().toISOString(),
    previous_cwd: previousCwd,
    new_cwd: newCwd,
  };

  const sessionFile = path.join(getProjectDir(), '.orchestrator', 'current-session.json');

  const result = await atomicMutateJson(sessionFile, {}, (current) => {
    const existing = Array.isArray(current.cwd_changes)
      ? current.cwd_changes
      : [];
    // Append the new record and cap at MAX_ENTRIES (keep most-recent).
    const updated = [...existing, record].slice(-MAX_ENTRIES);
    return { ...current, cwd_changes: updated };
  }, 'cwd');
  // Nothing else depends on this write — a non-ENOENT read/parse failure
  // just means the record is dropped this turn. Diagnostic only (stderr),
  // matches the hook's own "never blocking" contract.
  if (!result.ok) {
    console.error(`cwd-change-restore: atomicMutateJson skipped write (${result.reason})`);
  }
}

// Exit 0 always — informational hook must never block Claude.
main().catch(() => {}).finally(() => process.exit(0));
