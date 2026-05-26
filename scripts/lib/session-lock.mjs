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
import { _parseStateMdLock } from './config/state-md-lock.mjs';
import { writeJsonAtomicSync } from './io.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TTL_HOURS = 4;
export const LOCK_PATH = '.orchestrator/session.lock';

// STATE.md write-lock (PRD 2026-05-22 § 4 — Pattern 1, issue #518).
// Orthogonal to the session-lock above:
//   - session.lock = "this repo working-copy is held by an active session"
//   - state.lock   = "STATE.md is being written right now"
// Two distinct lock files so a session can hold its session-lock for hours
// while still allowing fast acquire/release cycles around individual writes.
export const STATE_LOCK_PATH = '.orchestrator/state.lock';
export const DEFAULT_STATE_LOCK_TIMEOUT_MS = 10000;
export const STATE_LOCK_POLL_MS = 100;

// Staging-fence commit-mutex (PSA-004 sub-mode C, issue #552). Held only for
// the duration of the wave-scope-commit-guard's cross-agent fence check.
//   - state.lock          = "STATE.md is being written right now"
//   - staging-fence.lock  = "the cross-fence commit check is running right now"
// Distinct lockfile so the two locks never contend with each other.
export const STAGING_FENCE_LOCK_PATH = '.orchestrator/staging-fence/.commit.lock';
export const DEFAULT_STAGING_FENCE_LOCK_TIMEOUT_MS = 10000;
export const STAGING_FENCE_LOCK_POLL_MS = 100;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a PID corresponds to a live process on this host.
 * Returns true when the process exists (even if we lack kill permission).
 * Returns false when the process does not exist (ESRCH).
 *
 * @param {number} pid  Process ID to probe via the POSIX signal-0 trick.
 * @returns {boolean}   true when a process with the given PID exists; false
 *                      when no such process exists or the probe failed.
 *
 * @remarks
 * PID-recycle trade-off (#560 Q3 L2 — deep-2115 session-reviewer):
 *
 *  - On Unix, `process.kill(pid, 0)` returns true if ANY process exists with
 *    that PID, including a recycled one. The kernel does not distinguish the
 *    original lock-holder from a fresh process that happens to have inherited
 *    the same numeric PID after the lock-holder's death.
 *  - On a long session where the lock-holder died abnormally AND the OS reused
 *    its PID before TTL expiry, this function returns `true` even though the
 *    original lock-holder is gone. The lock is then perceived as held by a
 *    "live" process that is actually unrelated to the original writer.
 *  - Impact: a stale lock waits the full TTL (default 10s for the state-lock,
 *    DEFAULT_TTL_HOURS=4 for the session-lock) before being reclaimed by the
 *    timeout path. Fail-open posture means correctness is preserved — only
 *    operational latency is affected, and the missed race-detection is
 *    bounded to one incident per stale-lock event.
 *  - Trade-off accepted: the alternative would require recording a UUID or
 *    boot-nonce alongside the PID and comparing both fields on stale-detection
 *    (so a recycled PID with a mismatched nonce would be recognised as stale
 *    immediately). That adds complexity to the lock body, parse path, and
 *    every acquire/release branch for a single-missed-race-per-incident
 *    impact. Current trade-off is operationally sound at our scale.
 */
export function isPidAlive(pid) {
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

// ---------------------------------------------------------------------------
// STATE.md write-lock (PRD 2026-05-22 § 4 — Pattern 1, issue #518)
// ---------------------------------------------------------------------------
//
// Mechanical enforcement of PSA-004 for STATE.md writes. Whereas the
// session-lock above guards "this working-copy is held by one session", the
// state-lock guards "STATE.md is being written right now" — a short-lived
// lock acquired around every read-modify-write cycle.
//
// Design:
//  - Atomic create via tmp + rename, same pattern as writeLockAtomic above.
//  - Body: { pid, host, acquiredAt, holder } — host is included so cross-host
//    callers (rare but possible via shared filesystems) avoid spurious PID
//    liveness checks against unrelated PIDs.
//  - Stale detection: process.kill(pid, 0). When the holder is on the same
//    host and the PID is dead (ESRCH), the lock is overridden atomically and
//    a WARN is written to stderr. Cross-host stale locks are NOT auto-cleared
//    — they fall through to the timeout path.
//  - Poll cadence: 100 ms by default. Configurable via STATE_LOCK_POLL_MS but
//    no public override — tests inject via the optional `pollMs` parameter.
//
// Returns structured results, never throws (acquireStateLock / releaseStateLock).
// withStateMdLock re-throws caller errors after releasing.

/**
 * Resolve the absolute path to the state-lock file.
 * @param {string|undefined} repoRoot
 * @returns {string}
 */
function stateLockPathFor(repoRoot) {
  return path.join(repoRoot ?? process.cwd(), STATE_LOCK_PATH);
}

/**
 * Build a fresh state-lock body.
 * @param {{ holder?: string }} args
 * @returns {{ pid: number, host: string, acquiredAt: string, holder: string }}
 */
function buildStateLockBody({ holder }) {
  return {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: nowIso(),
    holder: typeof holder === 'string' && holder.length > 0 ? holder : `pid-${process.pid}`,
  };
}

/**
 * Parse a lock-file body shared by the state-lock and staging-fence-lock.
 * Both locks use identical { pid, host, acquiredAt, holder } shape so a single
 * parser serves both. Returns null on any malformed input.
 *
 * Renamed from parseStateLock in #558 M4 — the previous name encoded a single
 * lock identity, but the function is used by both state-lock acquire/release
 * and staging-fence-lock acquire/release.
 *
 * @param {string} raw
 * @returns {{ pid: number, host: string, acquiredAt: string, holder: string }|null}
 */
function parseLockBody(raw) {
  try {
    const obj = JSON.parse(raw);
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.pid === 'number' &&
      typeof obj.host === 'string' &&
      typeof obj.acquiredAt === 'string' &&
      typeof obj.holder === 'string'
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically create the state-lock file via tmp + hardlink (cross-process mutex).
 *
 * Pattern: write full content to a tmp file, then linkSync(tmp, lockFile).
 * linkSync is POSIX-atomic for create-or-fail: returns success when the link
 * is created, EEXIST when the target already exists. This avoids the
 * O_EXCL+writeSync race where an open-but-empty file is observable to
 * concurrent readers (which then see the file as "unparseable stale" and
 * override the legitimate lock).
 *
 * @param {string} lockFile  Absolute path to .orchestrator/state.lock.
 * @param {object} body      Lock body to serialize.
 * @returns {{ ok: true } | { ok: false, reason: 'exists' | 'fs-error', error?: string }}
 */
function createStateLockExclusive(lockFile, body) {
  const dir = path.dirname(lockFile);
  let tmpFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmpSuffix = crypto.randomBytes(8).toString('hex');
    tmpFile = path.join(dir, `.state.lock.tmp.${tmpSuffix}`);
    fs.writeFileSync(tmpFile, JSON.stringify(body, null, 2) + '\n', 'utf8');
  } catch (err) {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
    }
    return { ok: false, reason: 'fs-error', error: err.message };
  }

  try {
    fs.linkSync(tmpFile, lockFile);
    return { ok: true };
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { ok: false, reason: 'exists' };
    }
    return { ok: false, reason: 'fs-error', error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
  }
}

/**
 * Atomically replace an existing state-lock file via tmp + rename.
 *
 * Used only on the stale-override path, where we KNOW the existing lock is
 * dead (PID-liveness check failed) and we are deliberately overwriting it.
 *
 * Thin wrapper around {@link writeJsonAtomicSync} from scripts/lib/io.mjs
 * (extracted in #558 M1) — preserves the public function name so callers do
 * not change, while consolidating the three near-identical atomic-write
 * implementations onto a single helper. Uses the `.state.lock.tmp` prefix to
 * preserve the existing tmp-file naming convention.
 *
 * @param {string} lockFile  Absolute path to .orchestrator/state.lock.
 * @param {object} body      Lock body to serialize.
 * @returns {{ ok: true } | { ok: false, reason: 'fs-error', error: string }}
 */
function replaceStateLockAtomic(lockFile, body) {
  return writeJsonAtomicSync(lockFile, body, { tmpPrefix: '.state.lock.tmp' });
}

/**
 * Attempt one acquisition pass. Returns:
 *   { ok: true, lock }                          — lock written
 *   { ok: false, reason: 'held', existingLock } — held by a live holder
 *   { ok: false, reason: 'fs-error', error }    — filesystem failure
 *
 * Strategy:
 *   1. Try O_EXCL create (cross-process mutex). Success → return immediately.
 *   2. On EEXIST → read the existing lock, check PID liveness on same host.
 *      - Live PID → `held` (caller polls).
 *      - Dead PID (or unparseable contents) → stale, atomic override + WARN.
 *
 * Side-effect: stale-lock override writes a WARN to stderr. Cross-host locks
 * are never auto-overridden (can't signal a process on another machine).
 */
function tryAcquireStateLock(lockFile, body) {
  try {
    // Step 1: try exclusive create (mutex).
    const createResult = createStateLockExclusive(lockFile, body);
    if (createResult.ok) {
      return { ok: true, lock: body };
    }
    if (createResult.reason === 'fs-error') {
      return createResult;
    }

    // Step 2: EEXIST — inspect the existing lock.
    let existingRaw;
    try {
      existingRaw = fs.readFileSync(lockFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Lock vanished between create-fail and read — race-loser of a race.
        // Caller's poll loop will retry; report as 'held' to defer.
        return { ok: false, reason: 'held', existingLock: null };
      }
      return { ok: false, reason: 'fs-error', error: err.message };
    }

    const existing = parseLockBody(existingRaw);

    // Unparseable existing lock — treat as stale and override. We never
    // know which holder wrote it, so this is the only safe move.
    if (existing === null) {
      console.warn('stale state.lock (unparseable contents) overridden');
      const writeResult = replaceStateLockAtomic(lockFile, body);
      if (!writeResult.ok) return writeResult;
      return { ok: true, lock: body };
    }

    const sameHost = existing.host === os.hostname();
    // PID liveness is only meaningful on the same host.
    const pidAlive = sameHost ? isPidAlive(existing.pid) : true;

    if (pidAlive) {
      return { ok: false, reason: 'held', existingLock: existing };
    }

    // Same host, dead PID — stale lock. Override atomically + WARN.
    console.warn(`stale state.lock from PID ${existing.pid} overridden`);
    const writeResult = replaceStateLockAtomic(lockFile, body);
    if (!writeResult.ok) return writeResult;
    return { ok: true, lock: body };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

/**
 * Sleep helper for the acquire poll-loop. Promise-returning, so the loop is
 * async without blocking the event loop.
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the STATE.md write-lock. Polls every STATE_LOCK_POLL_MS until the
 * lock is acquired or the timeout expires.
 *
 * Returns:
 *   { ok: true, lock }                                    — lock acquired (possibly after waiting)
 *   { ok: false, reason: 'timeout', existingLock? }       — timed out waiting for live holder
 *   { ok: false, reason: 'fs-error', error: string }      — filesystem failure
 *
 * Stale-lock side-effects: when the existing lock points to a dead PID on
 * the same host, the helper overrides it atomically and writes a WARN to
 * stderr. The next poll iteration will then succeed.
 *
 * Never throws.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] — max wait in milliseconds.
 * @param {string} [opts.repoRoot] — defaults to process.cwd().
 * @param {string} [opts.holder] — human-readable holder string (default `pid-<pid>`).
 * @param {number} [opts.pollMs] — test-only override of poll cadence.
 */
export async function acquireStateLock({
  timeoutMs = DEFAULT_STATE_LOCK_TIMEOUT_MS,
  repoRoot,
  holder,
  pollMs = STATE_LOCK_POLL_MS,
} = {}) {
  const lockFile = stateLockPathFor(repoRoot);
  const body = buildStateLockBody({ holder });
  const deadline = Date.now() + (typeof timeoutMs === 'number' && timeoutMs >= 0 ? timeoutMs : DEFAULT_STATE_LOCK_TIMEOUT_MS);
  const effectivePollMs = typeof pollMs === 'number' && pollMs > 0 ? pollMs : STATE_LOCK_POLL_MS;

  // Loop until acquired or deadline reached. The first iteration runs
  // unconditionally so a timeoutMs of 0 still attempts one acquisition.
  for (;;) {
    const attempt = tryAcquireStateLock(lockFile, body);
    if (attempt.ok) return attempt;
    if (attempt.reason === 'fs-error') return attempt;

    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: 'timeout',
        existingLock: attempt.existingLock ?? null,
      };
    }
    await delay(effectivePollMs);
  }
}

/**
 * Release the STATE.md write-lock IFF the holder matches.
 *
 * Caller must pass the same identifier they used in acquireStateLock — either
 * `holder` (free-form string) OR `sessionId` (matched against the holder
 * field when holder follows the `<sessionId>` convention). If neither is
 * provided, the helper falls back to PID equality.
 *
 * Returns (per PRD § 4):
 *   { ok: true }                                 — lock unlinked
 *   { ok: false, reason: 'not-found' }           — no lock file exists
 *   { ok: false, reason: 'not-owner' }           — lock held by different holder/PID
 *   { ok: false, reason: 'fs-error', error }     — filesystem failure
 *
 * Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.sessionId]  — matched against the `holder` field.
 * @param {string} [opts.holder]     — matched against the `holder` field (overrides sessionId).
 */
export function releaseStateLock({ repoRoot, sessionId, holder } = {}) {
  const lockFile = stateLockPathFor(repoRoot);

  let raw;
  try {
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: false, reason: 'fs-error', error: err.message };
  }

  const lock = parseLockBody(raw);
  if (lock === null) {
    // Unparseable — refuse to delete; some other process may be writing now.
    return { ok: false, reason: 'not-owner' };
  }

  const expectedHolder = holder ?? sessionId ?? null;
  const ownerMatch = expectedHolder !== null
    ? lock.holder === expectedHolder
    : lock.pid === process.pid && lock.host === os.hostname();

  if (!ownerMatch) {
    return { ok: false, reason: 'not-owner' };
  }

  try {
    fs.unlinkSync(lockFile);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

/**
 * High-level wrapper: acquire the STATE.md write-lock, run `fn`, release on
 * completion or throw. Always releases the lock — even if `fn` throws —
 * before re-raising the original error.
 *
 * Short-circuit: when `state-md-lock.enabled: false` is set in CLAUDE.md
 * (or AGENTS.md on Codex CLI — the two are aliases per
 * `skills/_shared/instruction-file-resolution.md`) Session Config, the lock
 * is bypassed entirely and `fn` is called directly. A stderr WARN line is
 * emitted so operators can detect the bypass. This honours the config knob
 * documented in `.claude/rules/parallel-sessions.md` PSA-005 without
 * removing the lock infrastructure.
 *
 * Per-call override via `opts._stateMdLockEnabled` (boolean): when provided,
 * takes precedence over the config value. Useful for tests that need to
 * exercise the short-circuit without touching CLAUDE.md on disk.
 * The leading underscore marks this as a test-only seam — production callers
 * MUST omit this option.
 *
 * Fail-safe: if CLAUDE.md cannot be read or the config block is malformed,
 * `enabled` defaults to `true` — lock is always acquired on errors.
 *
 * Throws when:
 *   - acquireStateLock fails (timeout or fs-error) → throws a labelled Error
 *     so callers see the failure as an exception rather than a silent
 *     {ok:false} return. This is the contract that lets call sites use plain
 *     `await withStateMdLock(repoRoot, async () => …)` without branching.
 *   - `fn` throws → the original error is re-thrown after release.
 *
 * @param {string|undefined} repoRoot
 * @param {() => (T | Promise<T>)} fn
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.holder]
 * @param {number} [opts.pollMs]
 * @param {boolean} [opts._stateMdLockEnabled]  — test-only per-call override;
 *   takes precedence over the Session Config value when set. Production
 *   callers MUST omit this option.
 * @returns {Promise<T>}
 * @template T
 */
export async function withStateMdLock(repoRoot, fn, opts = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('withStateMdLock: fn must be a function');
  }

  // Short-circuit: respect state-md-lock.enabled: false from Session Config.
  // opts._stateMdLockEnabled (test-only per-call override) takes precedence when set.
  let enabled = opts._stateMdLockEnabled;
  if (enabled === undefined) {
    try {
      const claudeMdPath = path.join(repoRoot ?? process.cwd(), 'CLAUDE.md');
      const claudeMdContents = fs.readFileSync(claudeMdPath, 'utf8');
      const cfg = _parseStateMdLock(claudeMdContents);
      enabled = cfg.enabled;
    } catch {
      // Fail-safe: if CLAUDE.md is absent or unreadable, default to locked.
      enabled = true;
    }
  }

  if (enabled === false) {
    process.stderr.write('⚠ withStateMdLock: short-circuit (state-md-lock.enabled: false) — running fn without lock\n');
    return await fn();
  }

  const holder = typeof opts.holder === 'string' && opts.holder.length > 0
    ? opts.holder
    : `pid-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  const acquireResult = await acquireStateLock({
    repoRoot,
    timeoutMs: opts.timeoutMs,
    holder,
    pollMs: opts.pollMs,
  });

  if (!acquireResult.ok) {
    const reason = acquireResult.reason;
    const extra = reason === 'timeout' && acquireResult.existingLock
      ? ` (held by ${acquireResult.existingLock.holder}, pid=${acquireResult.existingLock.pid})`
      : reason === 'fs-error' && acquireResult.error
        ? `: ${acquireResult.error}`
        : '';
    const err = new Error(`withStateMdLock: acquire failed (${reason})${extra}`);
    err.code = `STATE_LOCK_${reason.toUpperCase().replace(/-/g, '_')}`;
    throw err;
  }

  let result;
  let caughtError = null;
  try {
    result = await fn();
  } catch (err) {
    caughtError = err;
  } finally {
    // Always release — even on fn() throw — so the lock does not leak.
    // Only WARN on fs-error: 'not-found' and 'not-owner' are recoverable race
    // conditions (someone else cleaned up our lock — already safe to proceed).
    const releaseResult = releaseStateLock({ repoRoot, holder });
    if (!releaseResult.ok && releaseResult.reason === 'fs-error') {
      console.warn(`withStateMdLock: release failed (fs-error: ${releaseResult.error ?? 'unknown'})`);
    }
  }

  if (caughtError !== null) throw caughtError;
  return result;
}

// ---------------------------------------------------------------------------
// Staging-fence commit-mutex (PSA-004 sub-mode C, issue #552)
// ---------------------------------------------------------------------------
//
// Held only around the wave-scope-commit-guard cross-fence check. Two sibling
// wave-agents that both pass through the per-agent guard race to acquire this
// lock; the winner inspects ALL fence files, the loser polls until the winner
// releases. Without the mutex the check is TOCTOU-vulnerable: agent A reads
// agent B's fence file BEFORE B writes agent B's last `git add` intent, and
// both proceed to `git commit` with overlapping staged paths.
//
// Implementation reuses the same tmp+linkSync cross-process pattern as the
// STATE.md lock above (createStateLockExclusive). The two lockfiles are
// distinct so STATE.md writes never contend with commit-guard checks.

/**
 * Resolve the absolute path to the staging-fence commit lock file.
 * @param {string|undefined} repoRoot
 * @returns {string}
 */
function stagingFenceLockPathFor(repoRoot) {
  return path.join(repoRoot ?? process.cwd(), STAGING_FENCE_LOCK_PATH);
}

/**
 * Build a fresh staging-fence lock body. Same shape as buildStateLockBody so
 * the parseLockBody parser works identically — there is no need for a
 * second parser.
 *
 * @param {{ holder?: string }} args
 * @returns {{ pid: number, host: string, acquiredAt: string, holder: string }}
 */
function buildStagingFenceLockBody({ holder }) {
  return {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: nowIso(),
    holder: typeof holder === 'string' && holder.length > 0 ? holder : `pid-${process.pid}`,
  };
}

/**
 * Atomically create the staging-fence commit-lock via tmp + linkSync.
 * Same pattern as createStateLockExclusive; only the tmp prefix differs.
 *
 * @param {string} lockFile  Absolute path to the staging-fence lockfile.
 * @param {object} body      Lock body to serialize.
 * @returns {{ ok: true } | { ok: false, reason: 'exists' | 'fs-error', error?: string }}
 */
function createStagingFenceLockExclusive(lockFile, body) {
  const dir = path.dirname(lockFile);
  let tmpFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmpSuffix = crypto.randomBytes(8).toString('hex');
    tmpFile = path.join(dir, `.staging-fence.lock.tmp.${tmpSuffix}`);
    fs.writeFileSync(tmpFile, JSON.stringify(body, null, 2) + '\n', 'utf8');
  } catch (err) {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
    }
    return { ok: false, reason: 'fs-error', error: err.message };
  }

  try {
    fs.linkSync(tmpFile, lockFile);
    return { ok: true };
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { ok: false, reason: 'exists' };
    }
    return { ok: false, reason: 'fs-error', error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
  }
}

/**
 * Atomically replace an existing staging-fence lock via tmp + rename. Used
 * only on the stale-override path where we KNOW the existing lock is dead.
 *
 * Thin wrapper around {@link writeJsonAtomicSync} from scripts/lib/io.mjs
 * (extracted in #558 M1). Uses the `.staging-fence.lock.tmp` prefix to
 * preserve the existing tmp-file naming convention.
 *
 * @param {string} lockFile  Absolute path to the staging-fence lockfile.
 * @param {object} body      Lock body to serialize.
 * @returns {{ ok: true } | { ok: false, reason: 'fs-error', error: string }}
 */
function replaceStagingFenceLockAtomic(lockFile, body) {
  return writeJsonAtomicSync(lockFile, body, { tmpPrefix: '.staging-fence.lock.tmp' });
}

/**
 * Single-pass acquire attempt for the staging-fence lock. Mirrors
 * tryAcquireStateLock — only the lockfile path + tmp prefix differ.
 *
 * Returns:
 *   { ok: true, lock }                          — acquired
 *   { ok: false, reason: 'held', existingLock } — live holder; caller polls
 *   { ok: false, reason: 'fs-error', error }    — filesystem failure
 */
function tryAcquireStagingFenceLock(lockFile, body) {
  try {
    const createResult = createStagingFenceLockExclusive(lockFile, body);
    if (createResult.ok) {
      return { ok: true, lock: body };
    }
    if (createResult.reason === 'fs-error') {
      return createResult;
    }

    let existingRaw;
    try {
      existingRaw = fs.readFileSync(lockFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { ok: false, reason: 'held', existingLock: null };
      }
      return { ok: false, reason: 'fs-error', error: err.message };
    }

    const existing = parseLockBody(existingRaw); // body shape is identical

    if (existing === null) {
      console.warn('stale staging-fence.lock (unparseable contents) overridden');
      const writeResult = replaceStagingFenceLockAtomic(lockFile, body);
      if (!writeResult.ok) return writeResult;
      return { ok: true, lock: body };
    }

    const sameHost = existing.host === os.hostname();
    const pidAlive = sameHost ? isPidAlive(existing.pid) : true;

    if (pidAlive) {
      return { ok: false, reason: 'held', existingLock: existing };
    }

    console.warn(`stale staging-fence.lock from PID ${existing.pid} overridden`);
    const writeResult = replaceStagingFenceLockAtomic(lockFile, body);
    if (!writeResult.ok) return writeResult;
    return { ok: true, lock: body };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

/**
 * Acquire the staging-fence commit-lock. Polls every STAGING_FENCE_LOCK_POLL_MS
 * until the lock is acquired or the timeout expires. Same semantics as
 * acquireStateLock above.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.holder]
 * @param {number} [opts.pollMs]
 */
export async function acquireStagingFenceLock({
  timeoutMs = DEFAULT_STAGING_FENCE_LOCK_TIMEOUT_MS,
  repoRoot,
  holder,
  pollMs = STAGING_FENCE_LOCK_POLL_MS,
} = {}) {
  const lockFile = stagingFenceLockPathFor(repoRoot);
  const body = buildStagingFenceLockBody({ holder });
  const deadline = Date.now() + (typeof timeoutMs === 'number' && timeoutMs >= 0
    ? timeoutMs
    : DEFAULT_STAGING_FENCE_LOCK_TIMEOUT_MS);
  const effectivePollMs = typeof pollMs === 'number' && pollMs > 0
    ? pollMs
    : STAGING_FENCE_LOCK_POLL_MS;

  for (;;) {
    const attempt = tryAcquireStagingFenceLock(lockFile, body);
    if (attempt.ok) return attempt;
    if (attempt.reason === 'fs-error') return attempt;

    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: 'timeout',
        existingLock: attempt.existingLock ?? null,
      };
    }
    await delay(effectivePollMs);
  }
}

/**
 * Release the staging-fence commit-lock IFF the holder matches.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.holder]
 * @returns {{ ok: true } | { ok: false, reason: 'not-found'|'not-owner'|'fs-error', error?: string }}
 */
export function releaseStagingFenceLock({ repoRoot, holder } = {}) {
  const lockFile = stagingFenceLockPathFor(repoRoot);

  let raw;
  try {
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: false, reason: 'fs-error', error: err.message };
  }

  const lock = parseLockBody(raw);
  if (lock === null) {
    return { ok: false, reason: 'not-owner' };
  }

  const ownerMatch = typeof holder === 'string' && holder.length > 0
    ? lock.holder === holder
    : lock.pid === process.pid && lock.host === os.hostname();

  if (!ownerMatch) {
    return { ok: false, reason: 'not-owner' };
  }

  try {
    fs.unlinkSync(lockFile);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

/**
 * High-level wrapper: acquire the staging-fence commit-lock, run `fn`,
 * release on completion or throw. Always releases — even if `fn` throws —
 * before re-raising.
 *
 * No Session Config short-circuit is provided. Unlike the STATE.md lock
 * (which is bypassed when `state-md-lock.enabled: false`), this lock guards
 * a single small read-modify-write on a hidden runtime directory and has
 * no performance cost worth opting out of. If the lock genuinely needs to
 * be disabled, callers can skip the wrapper entirely.
 *
 * Throws when:
 *   - acquireStagingFenceLock fails (timeout or fs-error) → labelled Error.
 *   - `fn` throws → the original error is re-thrown after release.
 *
 * @param {string|undefined} repoRoot
 * @param {() => (T | Promise<T>)} fn
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.holder]
 * @param {number} [opts.pollMs]
 * @returns {Promise<T>}
 * @template T
 */
export async function withStagingFenceLock(repoRoot, fn, opts = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('withStagingFenceLock: fn must be a function');
  }

  const holder = typeof opts.holder === 'string' && opts.holder.length > 0
    ? opts.holder
    : `pid-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  const acquireResult = await acquireStagingFenceLock({
    repoRoot,
    timeoutMs: opts.timeoutMs,
    holder,
    pollMs: opts.pollMs,
  });

  if (!acquireResult.ok) {
    const reason = acquireResult.reason;
    const extra = reason === 'timeout' && acquireResult.existingLock
      ? ` (held by ${acquireResult.existingLock.holder}, pid=${acquireResult.existingLock.pid})`
      : reason === 'fs-error' && acquireResult.error
        ? `: ${acquireResult.error}`
        : '';
    const err = new Error(`withStagingFenceLock: acquire failed (${reason})${extra}`);
    err.code = `STAGING_FENCE_LOCK_${reason.toUpperCase().replace(/-/g, '_')}`;
    throw err;
  }

  let result;
  let caughtError = null;
  try {
    result = await fn();
  } catch (err) {
    caughtError = err;
  } finally {
    const releaseResult = releaseStagingFenceLock({ repoRoot, holder });
    if (!releaseResult.ok && releaseResult.reason === 'fs-error') {
      console.warn(
        `withStagingFenceLock: release failed (fs-error: ${releaseResult.error ?? 'unknown'})`,
      );
    }
  }

  if (caughtError !== null) throw caughtError;
  return result;
}
