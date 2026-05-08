/**
 * session-lock.mjs — distributed session-lock with TTL (issue #330).
 *
 * Provides atomic acquire/release/inspect for a per-repo session.lock file
 * stored at `.orchestrator/session.lock`. Prevents concurrent deep sessions
 * from stomping each other's metrics writes and wave executor state.
 *
 * Design principles:
 *  - No-throw: every exported function catches filesystem errors and returns a
 *    structured failure object instead of propagating exceptions.
 *  - Atomic writes: acquire() writes to a temp file then renames, giving a
 *    single syscall that is either visible or not on POSIX systems.
 *  - Cross-host aware: PID liveness checks are skipped when the lock came from
 *    a different hostname (can't signal a remote process).
 *  - Decision deferred: acquire() reports stale locks but does NOT auto-clear
 *    them. session-start handles the recovery AUQ flow (W3-C3).
 *
 * No external dependencies — Node 20+ stdlib only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TTL_HOURS = 4;
export const LOCK_PATH = '.orchestrator/session.lock';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a PID corresponds to a live process on this host.
 * Returns true when the process exists (even if we lack kill permission).
 * Returns false when the process does not exist (ESRCH).
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') return true; // process exists, we just lack permission
    return false;
  }
}

/**
 * Resolve the absolute path to the lock file.
 * @param {string|undefined} repoRoot
 * @returns {string}
 */
function lockPathFor(repoRoot) {
  return path.join(repoRoot ?? process.cwd(), LOCK_PATH);
}

/**
 * Return the current time as an ISO-8601 string.
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Determine whether a lock's TTL has expired.
 * @param {{ started_at: string, ttl_hours: number }} lock
 * @returns {boolean}
 */
function isTtlExpired(lock) {
  const age = Date.now() - Date.parse(lock.started_at);
  return age > lock.ttl_hours * 3600 * 1000;
}

/**
 * Compute the age of a lock in fractional hours.
 * Returns null if started_at is unparseable.
 * @param {{ started_at: string }} lock
 * @returns {number|null}
 */
function lockAgeHours(lock) {
  const ts = Date.parse(lock.started_at);
  if (Number.isNaN(ts)) return null;
  return (Date.now() - ts) / (3600 * 1000);
}

/**
 * Parse lock file contents into an object. Returns null on any parse error.
 * @param {string} raw
 * @returns {object|null}
 */
function parseLock(raw) {
  try {
    const obj = JSON.parse(raw);
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.session_id === 'string' &&
      typeof obj.started_at === 'string' &&
      typeof obj.mode === 'string' &&
      typeof obj.pid === 'number' &&
      typeof obj.host === 'string' &&
      typeof obj.ttl_hours === 'number'
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a fresh lock object from caller-supplied fields.
 * @param {{ sessionId: string, mode: string, ttlHours: number }} args
 * @returns {object}
 */
function buildLock({ sessionId, mode, ttlHours }) {
  return {
    session_id: sessionId,
    started_at: nowIso(),
    mode,
    pid: process.pid,
    host: os.hostname(),
    ttl_hours: ttlHours,
  };
}

/**
 * Atomically write a lock object to disk.
 * Uses a tmp file in a mkdtemp directory + rename to avoid a partial-write race.
 * @param {string} lockFile  Absolute path to the lock file.
 * @param {object} lock      Lock object to serialize.
 * @returns {{ ok: true } | { ok: false, reason: 'fs-error', error: string }}
 */
function writeLockAtomic(lockFile, lock) {
  try {
    const dir = path.dirname(lockFile);
    // Ensure .orchestrator/ directory exists.
    fs.mkdirSync(dir, { recursive: true });

    // Write to a uniquely-named temp file in the same directory so rename()
    // is guaranteed to be an atomic same-filesystem operation on POSIX.
    const tmpSuffix = crypto.randomBytes(6).toString('hex');
    const tmpFile = path.join(dir, `.session.lock.tmp.${tmpSuffix}`);

    fs.writeFileSync(tmpFile, JSON.stringify(lock, null, 2) + '\n', { encoding: 'utf8' });
    fs.renameSync(tmpFile, lockFile);

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Read the lock file without modifying it.
 * Returns the parsed lock object, or null if absent or unparseable.
 * Never throws.
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {{ session_id: string, started_at: string, mode: string, pid: number, host: string, ttl_hours: number } | null}
 */
export function readLock(opts = {}) {
  const lockFile = lockPathFor(opts.repoRoot);
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    return parseLock(raw);
  } catch {
    return null;
  }
}

/**
 * Atomically acquire the session lock.
 *
 * Returns:
 *   { ok: true, lock }                                              — lock created
 *   { ok: false, reason: 'active', existingLock }                  — live TTL, live PID
 *   { ok: false, reason: 'stale-pid-dead', existingLock }          — expired TTL or dead PID
 *   { ok: false, reason: 'stale-pid-alive', existingLock }         — expired TTL but PID still running
 *   { ok: false, reason: 'fs-error', error: string }               — filesystem failure
 *
 * The caller (session-start) decides whether to invoke forceAcquire() after
 * obtaining user consent.
 *
 * @param {{ sessionId: string, mode: string, ttlHours?: number, repoRoot?: string }} args
 */
export function acquire({ sessionId, mode, ttlHours = DEFAULT_TTL_HOURS, repoRoot } = {}) {
  const lockFile = lockPathFor(repoRoot);

  try {
    const existing = readLock({ repoRoot });

    if (existing !== null) {
      // A lock is present — classify it.
      const expired = isTtlExpired(existing);
      const sameHost = existing.host === os.hostname();
      // PID liveness is only meaningful on the same host.
      const pidAlive = sameHost ? isPidAlive(existing.pid) : null;

      if (!expired && pidAlive !== false) {
        // TTL still valid AND (PID is alive OR we can't check because cross-host).
        return { ok: false, reason: 'active', existingLock: existing };
      }

      // TTL expired or PID is confirmed dead — classify the stale variant.
      const reason = (pidAlive === false) ? 'stale-pid-dead' : 'stale-pid-alive';
      return { ok: false, reason, existingLock: existing };
    }

    // No existing lock — write a new one.
    const lock = buildLock({ sessionId, mode, ttlHours });
    const writeResult = writeLockAtomic(lockFile, lock);
    if (!writeResult.ok) return writeResult;

    return { ok: true, lock };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

/**
 * Force-acquire the lock, unconditionally replacing any existing lock.
 * Call only after the user has explicitly authorised stale-lock takeover.
 *
 * Returns:
 *   { ok: true, lock, replacedLock? }       — lock written (replacedLock present if one was overwritten)
 *   { ok: false, reason: 'fs-error', ... }  — filesystem failure
 *
 * @param {{ sessionId: string, mode: string, ttlHours?: number, repoRoot?: string }} args
 */
export function forceAcquire({ sessionId, mode, ttlHours = DEFAULT_TTL_HOURS, repoRoot } = {}) {
  try {
    const replacedLock = readLock({ repoRoot });
    const lock = buildLock({ sessionId, mode, ttlHours });
    const lockFile = lockPathFor(repoRoot);

    const writeResult = writeLockAtomic(lockFile, lock);
    if (!writeResult.ok) return writeResult;

    const result = { ok: true, lock };
    if (replacedLock !== null) result.replacedLock = replacedLock;
    return result;
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

/**
 * Release the lock IFF it belongs to the given session_id.
 * Silent no-op when the lock belongs to a different session or does not exist.
 * Never throws.
 *
 * @param {{ sessionId: string, repoRoot?: string }} args
 * @returns {{ ok: true, deleted: boolean, reason?: string }}
 */
export function release({ sessionId, repoRoot } = {}) {
  const lockFile = lockPathFor(repoRoot);
  try {
    const existing = readLock({ repoRoot });

    if (existing === null) {
      return { ok: true, deleted: false, reason: 'no-lock' };
    }

    if (existing.session_id !== sessionId) {
      return { ok: true, deleted: false, reason: 'session-mismatch' };
    }

    fs.unlinkSync(lockFile);
    return { ok: true, deleted: true };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

/**
 * Inspect the lock file and compute staleness metadata.
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {{
 *   exists: boolean,
 *   lock: object|null,
 *   ageHours: number|null,
 *   ttlExpired: boolean,
 *   pidAlive: boolean|null,
 *   host: string|null,
 *   sameHost: boolean
 * }}
 */
export function checkStale({ repoRoot } = {}) {
  const lock = readLock({ repoRoot });

  if (lock === null) {
    return {
      exists: false,
      lock: null,
      ageHours: null,
      ttlExpired: false,
      pidAlive: null,
      host: null,
      sameHost: false,
    };
  }

  const ageHours = lockAgeHours(lock);
  const ttlExpired = isTtlExpired(lock);
  const sameHost = lock.host === os.hostname();
  // Only attempt PID check when the lock was written on this machine.
  const pidAlive = sameHost ? isPidAlive(lock.pid) : null;

  return {
    exists: true,
    lock,
    ageHours,
    ttlExpired,
    pidAlive,
    host: lock.host,
    sameHost,
  };
}
