#!/usr/bin/env node
/**
 * post-tool-batch-wave-signal.mjs — PostToolBatch hook.
 *
 * Hook event: PostToolBatch (issue #342).
 * Fires after a batch of tool invocations completes within a single wave
 * turn. Writes a deterministic `last_batch` signal into
 * `.orchestrator/current-session.json` so skills and the coordinator can
 * observe batch-resolution boundaries without parsing the full event log.
 *
 * Decision flow:
 *   1. shouldRunHook gate — exit 0 immediately when the hook is disabled.
 *   2. Read JSON payload from stdin:
 *        { batch_id, batch_size, batch_completed_at, agent_id?, parent_session_id? }
 *   3. Atomic read-modify-write of .orchestrator/current-session.json:
 *        set `last_batch` to
 *        { batch_id, batch_size, completed_at, agent_id?, parent_session_id? }
 *        (always overwrites — last batch wins, one record per session file).
 *   4. Output: nothing on stdout. Diagnostic errors to stderr only.
 *
 * Exit codes: 0 always (informational, never blocking).
 *
 * hooks.json wiring is managed separately (W3-C4 scope).
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// Exit 0 immediately when disabled via SO_HOOK_PROFILE / SO_DISABLED_HOOKS.
if (!shouldRunHook('post-tool-batch-wave-signal')) process.exit(0);

import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';

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

/**
 * Atomic read-modify-write of a JSON file via temp + rename.
 * Reads the existing file (or starts with `defaultValue` when absent),
 * applies `mutate`, writes to a tmp file, then renames over the original.
 * Atomic on POSIX (same-filesystem rename). Best-effort on Windows.
 *
 * @param {string} filePath
 * @param {object} defaultValue — used when the file does not exist or is unparseable
 * @param {function(object): object} mutate — synchronous pure transformer
 */
async function atomicMutateJson(filePath, defaultValue, mutate) {
  let current = defaultValue;
  try {
    const raw = await readFile(filePath, 'utf8');
    current = JSON.parse(raw);
  } catch {
    // File absent or unparseable — start from defaultValue.
  }

  const updated = mutate(current);
  const tmp = `${filePath}.tmp-ptb-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  await rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();

  // Extract fields from the hook payload.
  const batchId = typeof input?.batch_id === 'string' ? input.batch_id : null;
  const batchSize =
    typeof input?.batch_size === 'number' ? input.batch_size : null;
  const completedAt =
    typeof input?.batch_completed_at === 'string'
      ? input.batch_completed_at
      : new Date().toISOString();
  const agentId =
    typeof input?.agent_id === 'string' ? input.agent_id : undefined;
  const parentSessionId =
    typeof input?.parent_session_id === 'string'
      ? input.parent_session_id
      : undefined;

  // Build the last_batch signal. Only include optional fields when present
  // to keep the session file lean.
  const lastBatch = {
    batch_id: batchId,
    batch_size: batchSize,
    completed_at: completedAt,
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
    ...(parentSessionId !== undefined ? { parent_session_id: parentSessionId } : {}),
  };

  const sessionFile = path.join(SO_PROJECT_DIR, '.orchestrator', 'current-session.json');

  await atomicMutateJson(sessionFile, {}, (current) => ({
    ...current,
    last_batch: lastBatch,
  }));
}

// Exit 0 always — informational hook must never block Claude.
main().catch(() => {}).finally(() => process.exit(0));
