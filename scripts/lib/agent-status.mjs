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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { appendJsonl } from './common.mjs';
import { writeJsonAtomicSync } from './io.mjs';
import { isPidAliveOnHost } from './session-lock.mjs';

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
 * Parse a lock body. The repo's session-lock `parseLock` is not exported, so we
 * carry a tiny local parser per the issue's instruction. Returns null on any
 * parse failure or shape mismatch.
 * @param {string} raw
 * @returns {{ pid: number, host: string, acquiredAt: string } | null}
 */
function parseLockBody(raw) {
  try {
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj === 'object' &&
      typeof obj.pid === 'number' &&
      typeof obj.host === 'string'
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically create the lock via tmp + linkSync (POSIX create-or-fail). The
 * winner creates the hard link; every loser gets EEXIST. Mirrors the
 * createSessionLockExclusive idiom in session-lock.mjs.
 * @param {string} lockFile
 * @param {object} body
 * @returns {{ ok: true } | { ok: false, reason: 'exists' } | { ok: false, reason: 'fs-error', error: string }}
 */
function createLockExclusive(lockFile, body) {
  const dir = path.dirname(lockFile);
  let tmpFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const suffix = crypto.randomBytes(8).toString('hex');
    tmpFile = path.join(dir, `.agent-status.lock.create.tmp.${suffix}`);
    fs.writeFileSync(tmpFile, JSON.stringify(body) + '\n', { encoding: 'utf8' });
  } catch (err) {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
    }
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }

  try {
    fs.linkSync(tmpFile, lockFile);
    return { ok: true };
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: false, reason: 'exists' };
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
  }
}

/**
 * Acquire the write-mutex. Polls every POLL_MS until acquired or the timeout
 * deadline. The first iteration is unconditional so timeoutMs:0 still tries
 * exactly once. On EEXIST, inspects the existing lock and atomically overrides
 * it ONLY when same-host AND its PID is dead, or its body is unparseable
 * (PSA-003: never auto-override a cross-host lock).
 *
 * @param {string} lockFile
 * @param {number} timeoutMs
 * @returns {{ ok: true, body: object } | { ok: false, reason: 'timeout'|'fs-error', error?: string }}
 */
function acquireLock(lockFile, timeoutMs) {
  const host = os.hostname();
  const myBody = { pid: process.pid, host, acquiredAt: new Date().toISOString() };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let firstPass = true;

  while (firstPass || Date.now() < deadline) {
    firstPass = false;

    const created = createLockExclusive(lockFile, myBody);
    if (created.ok) return { ok: true, body: myBody };
    if (created.reason === 'fs-error') {
      return { ok: false, reason: 'fs-error', error: created.error };
    }

    // reason === 'exists' — inspect the holder.
    let raw;
    try {
      raw = fs.readFileSync(lockFile, 'utf8');
    } catch (err) {
      // The holder released between linkSync and read — retry immediately.
      if (err.code === 'ENOENT') continue;
      return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
    }

    const existing = parseLockBody(raw);
    const sameHost = existing && existing.host === host;
    const dead = existing && !isPidAliveOnHost(existing.pid);

    if (!existing || (sameHost && dead)) {
      // Stale (unparseable body, or same-host dead PID) → atomically replace.
      const reason = !existing ? 'unparseable body' : `dead pid ${existing.pid}`;
      console.warn(`⚠ agent-status: overriding stale lock (${reason}) at ${lockFile}`);
      const replaced = writeJsonAtomicSync(lockFile, myBody, { tmpPrefix: '.agent-status.lock.replace' });
      if (replaced.ok) {
        // Confirm we are the holder after the override (LWW replace is benign
        // here because only stale-override paths reach this branch).
        return { ok: true, body: myBody };
      }
      return { ok: false, reason: 'fs-error', error: replaced.error };
    }

    // Live holder (or cross-host) → poll until the deadline.
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
 * delete a lock another holder owns.
 * @param {string} lockFile
 * @param {object} myBody  The body returned by acquireLock.
 */
function releaseLock(lockFile, myBody) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    const existing = parseLockBody(raw);
    if (existing && existing.pid === myBody.pid && existing.host === myBody.host) {
      fs.unlinkSync(lockFile);
    }
    // If the holder is not us (a stale-override stole it, or it vanished), leave
    // it alone — releasing another holder's lock would be a PSA-003 violation.
  } catch {
    // ENOENT or read error → nothing to release. Best-effort.
  }
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
