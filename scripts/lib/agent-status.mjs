/**
 * agent-status.mjs — lean per-agent status push helper (issue #565).
 *
 * Wave-executor agents push lightweight progress/status telemetry that a later
 * tmux-layout / wave-executor integration renders in an operator side-channel.
 * Two files live under `.orchestrator/runtime/` (already gitignored):
 *
 *   - `agent-status.jsonl`         — append-only event log (one record per push).
 *   - `agent-status-current.json`  — last-write-wins (LWW) map keyed by agentId.
 *
 * Best-effort telemetry contract: a status push must NEVER crash or block a
 * wave. Every exported function is no-throw and returns a structured result:
 *
 *   { ok: true } | { ok: false, reason: 'invalid-input'|'timeout'|'fs-error', error? }
 *
 * Concurrency: the LWW-map read-modify-write is serialised through a
 * self-contained POSIX lock (`agent-status.lock`) using the same `linkSync`
 * create-or-fail idiom the repo uses elsewhere (session-lock.mjs). The lock is
 * intentionally local to this module — it is a fast, short-held write-mutex,
 * orthogonal to the session/state locks in session-lock.mjs.
 *
 * Reuse (do NOT reinvent):
 *   - appendJsonl(filePath, obj)        — scripts/lib/common.mjs (O_APPEND, PIPE_BUF-atomic)
 *   - writeJsonAtomicSync(filePath, ..) — scripts/lib/io.mjs     (tmp + renameSync)
 *   - isPidAliveOnHost(pid)             — scripts/lib/session-lock.mjs (signal-0 probe)
 *
 * No external dependencies — Node 20+ stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';

import { appendJsonl } from './common.mjs';
import { writeJsonAtomicSync } from './io.mjs';
import { tryAcquireFileLock, releaseFileLock } from './file-lock.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNTIME_DIR = '.orchestrator/runtime';
const JSONL_NAME = 'agent-status.jsonl';
const CURRENT_NAME = 'agent-status-current.json';
const LOCK_NAME = 'agent-status.lock';

const DEFAULT_TIMEOUT_MS = 10000;
const POLL_MS = 100;

// macOS PIPE_BUF floor is 512 bytes; keep each JSONL line comfortably under it
// by truncating free-text fields. 256 chars leaves headroom for the JSON
// envelope (keys, ts, numbers).
const MAX_TEXT_LEN = 256;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function runtimeDirFor(repoRoot) {
  return path.join(repoRoot ?? process.cwd(), RUNTIME_DIR);
}

function jsonlPathFor(repoRoot) {
  return path.join(runtimeDirFor(repoRoot), JSONL_NAME);
}

function currentPathFor(repoRoot) {
  return path.join(runtimeDirFor(repoRoot), CURRENT_NAME);
}

function lockPathFor(repoRoot) {
  return path.join(runtimeDirFor(repoRoot), LOCK_NAME);
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Truncate a free-text field to MAX_TEXT_LEN so a single JSONL line stays under
 * the PIPE_BUF floor. Non-strings pass through untouched.
 * @param {*} s
 * @returns {*}
 */
function truncate(s) {
  if (typeof s !== 'string') return s;
  return s.length > MAX_TEXT_LEN ? s.slice(0, MAX_TEXT_LEN) : s;
}

/**
 * Acquire the write-mutex. Polls every POLL_MS until acquired or the timeout
 * deadline. The first iteration is unconditional so timeoutMs:0 still tries
 * exactly once. On EEXIST, inspects the existing lock and atomically overrides
 * it ONLY when same-host AND its PID is dead, or its body is unparseable
 * (PSA-003: never auto-override a cross-host lock).
 *
 * Delegates to the shared file-lock primitive (issue #630). Behavior is
 * preserved exactly: compact body `{pid, host, acquiredAt}` (indent:null),
 * synchronous busy-wait poll (sync variant), PID staleCheck, console.warn
 * override channel with the original message, override tmp prefix
 * `.agent-status.lock.replace`, and the ENOENT-on-read race collapsed into a
 * retry (signalVanished:false).
 *
 * @param {string} lockFile
 * @param {number} timeoutMs
 * @returns {{ ok: true, body: object } | { ok: false, reason: 'timeout'|'fs-error', error?: string }}
 */
function acquireLock(lockFile, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let firstPass = true;

  while (firstPass || Date.now() < deadline) {
    firstPass = false;

    const attempt = tryAcquireFileLock(lockFile, {
      staleCheck: 'pid',
      indent: null,
      tmpPrefix: '.agent-status.lock.replace',
      warnMessage: (reason, lp) => `⚠ agent-status: overriding stale lock (${reason}) at ${lp}`,
    });
    if (attempt.acquired) return { ok: true, body: attempt.body };
    if (attempt.reason === 'fs-error') {
      return { ok: false, reason: 'fs-error', error: attempt.error };
    }

    // reason === 'held' (live holder, cross-host, or vanished-collapsed-to-held)
    // → poll until the deadline.
    if (Date.now() >= deadline) break;
    sleepMs(POLL_MS);
  }

  return { ok: false, reason: 'timeout' };
}

/**
 * Synchronous busy-wait sleep. The lock is held only for a sub-millisecond
 * read-modify-write, so a short synchronous poll keeps the helper simple and
 * avoids leaking async timers into the best-effort no-throw contract.
 * @param {number} ms
 */
function sleepMs(ms) {
  const end = Date.now() + ms;
  // Atomics.wait on a throwaway buffer is a portable, CPU-cheap sleep.
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable (unlikely on Node 20+) → tight spin fallback.
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Release the lock — but ONLY if WE own it (pid + host match). PSA-003: never
 * delete a lock another holder owns. Delegates to releaseFileLock with the
 * default owner-guard (no holder label → falls back to pid+host equality,
 * exactly as the original did).
 * @param {string} lockFile
 * @param {object} _myBody  The body returned by acquireLock (unused — the
 *   primitive re-reads the on-disk body and matches pid+host of the current
 *   process, which is the same process that called acquireLock).
 */
function releaseLock(lockFile, _myBody) {
  // ownerGuard:true with no holder → unlink IFF on-disk pid+host match this
  // process. Result reasons (not-found/not-owner) are ignored: best-effort.
  releaseFileLock(lockFile, { ownerGuard: true });
}

/**
 * Read the current LWW map from disk. Returns {} on miss or parse error.
 * @param {string} currentFile
 * @returns {Record<string, object>}
 */
function readCurrentMap(currentFile) {
  try {
    const raw = fs.readFileSync(currentFile, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return {};
  } catch {
    return {};
  }
}

/**
 * Shared write path for both setters: append the JSONL record, then perform a
 * lock-serialised read-modify-write of the LWW map. No-throw.
 *
 * @param {object} record  Fully-built status record (already validated/truncated).
 * @param {{ repoRoot?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'timeout'|'fs-error', error?: string }>}
 */
async function pushRecord(record, opts) {
  const repoRoot = opts?.repoRoot;
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  const jsonlFile = jsonlPathFor(repoRoot);
  const currentFile = currentPathFor(repoRoot);
  const lockFile = lockPathFor(repoRoot);

  // (1) Append-only JSONL stream. appendJsonl mkdir -p's and is O_APPEND-atomic.
  try {
    await appendJsonl(jsonlFile, record);
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }

  // (2) Lock-serialised RMW of the LWW current-map.
  let acquired;
  try {
    acquired = acquireLock(lockFile, timeoutMs);
  } catch (err) {
    // acquireLock is internally no-throw, but belt-and-suspenders for the
    // best-effort contract.
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }
  if (!acquired.ok) return acquired;

  try {
    const map = readCurrentMap(currentFile);
    map[record.agentId] = record;
    const written = writeJsonAtomicSync(currentFile, map, { tmpPrefix: '.agent-status-current' });
    if (!written.ok) return { ok: false, reason: 'fs-error', error: written.error };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  } finally {
    releaseLock(lockFile, acquired.body);
  }
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Push a free-text status for an agent. No-throw, best-effort.
 *
 * @param {string} agentId  Non-empty agent identifier (LWW map key).
 * @param {string} text     Non-empty status text (truncated to ~256 chars).
 * @param {{ repoRoot?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'invalid-input'|'timeout'|'fs-error', error?: string }>}
 */
export async function setStatus(agentId, text, opts = {}) {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    return { ok: false, reason: 'invalid-input', error: 'agentId must be a non-empty string' };
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'invalid-input', error: 'text must be a non-empty string' };
  }

  const record = {
    agentId,
    kind: 'status',
    text: truncate(text),
    ts: new Date().toISOString(),
  };

  return pushRecord(record, opts);
}

/**
 * Push a structured progress update for an agent. No-throw, best-effort.
 *
 * @param {string} agentId  Non-empty agent identifier (LWW map key).
 * @param {{ step: number, total: number, label?: string }} progress
 * @param {{ repoRoot?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'invalid-input'|'timeout'|'fs-error', error?: string }>}
 */
export async function setProgress(agentId, progress = {}, opts = {}) {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    return { ok: false, reason: 'invalid-input', error: 'agentId must be a non-empty string' };
  }
  const { step, total, label } = progress ?? {};
  if (typeof step !== 'number' || !Number.isFinite(step)) {
    return { ok: false, reason: 'invalid-input', error: 'step must be a finite number' };
  }
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    return { ok: false, reason: 'invalid-input', error: 'total must be a finite number' };
  }

  const record = {
    agentId,
    kind: 'progress',
    step,
    total,
    ts: new Date().toISOString(),
  };
  if (typeof label === 'string' && label.length > 0) {
    record.label = truncate(label);
  }

  return pushRecord(record, opts);
}

/**
 * Read the current LWW status map. No-throw — returns {} on miss or parse error.
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Record<string, { agentId: string, kind: string, ts: string, text?: string, step?: number, total?: number, label?: string }>}
 */
export function readCurrentStatus(opts = {}) {
  return readCurrentMap(currentPathFor(opts?.repoRoot));
}
