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
import { classifyMode } from './exclusivity-matrix.mjs';
import { isPidAliveOnHost, tryAcquireFileLock } from './file-lock.mjs';

// isPidAliveOnHost moved into file-lock.mjs in #630 (the file-lock primitive
// owns it so the dependency edge points file-lock → io, never the reverse).
// Re-exported here so existing importers (agent-status historically,
// session-discovery's forensic note, memory-proposals historically, and any
// external caller) keep resolving `isPidAliveOnHost` from session-lock.mjs.
export { isPidAliveOnHost };

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

// isPidAliveOnHost lives in file-lock.mjs (#630) and is re-exported at the top
// of this module. It is a SAME-HOST PID liveness probe (POSIX signal-0). It is
// NOT the discovery-path liveness check — since Epic #583 the discovery
// decision tree uses heartbeat-age via {@link isLockLive} instead, because the
// `pid` recorded on a session.lock is the *ephemeral hook subprocess* PID.
// Same-host callers (`acquire`, `checkStale`, and the state-lock /
// staging-fence stale-override paths, now via the file-lock primitive) use it
// only for the short-lived stale-override path where the recorded PID IS the
// live writer's PID. See file-lock.mjs for the full @forensic + PID-recycle
// trade-off note.

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
 *
 * Schema v2 (Epic #583, W2-I3): adds `last_heartbeat` (optional, populated by
 * `updateHeartbeat()`) + `semantic_session_id` (optional, populated when the
 * `session_id` field carries a UUID and the caller wants to preserve the
 * always-semantic id alongside it).
 *
 * Back-compat: v1 locks (no `last_heartbeat`) are normalised on read with
 * `last_heartbeat = started_at`. The optional `semantic_session_id` field is
 * left undefined when absent. This lets pre-#583 lockfiles flow through the
 * new liveness rule transparently — the v1 lock's `started_at` becomes its
 * effective heartbeat, so TTL freshness still rescues recent locks even when
 * the writer process is dead (the D2/D5 production case).
 *
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
      // Schema v1 → v2 normalisation: when `last_heartbeat` is absent or
      // non-string, treat the lock as if it heartbeat-ed once at started_at.
      const normalised = { ...obj };
      if (typeof normalised.last_heartbeat !== 'string' || normalised.last_heartbeat.length === 0) {
        normalised.last_heartbeat = normalised.started_at;
      }
      // semantic_session_id stays undefined when absent — callers that need it
      // should fall back to session_id.
      return normalised;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a fresh lock object from caller-supplied fields.
 *
 * Schema v2 (Epic #583, W2-I3): `last_heartbeat` is seeded equal to
 * `started_at`. Callers MUST call `updateHeartbeat()` on a known cadence
 * (session-start, inter-wave, session-end) to keep the lock alive past TTL.
 *
 * @param {{ sessionId: string, mode: string, ttlHours: number, semanticSessionId?: string }} args
 * @returns {object}
 */
function buildLock({ sessionId, mode, ttlHours, semanticSessionId }) {
  const startedAt = nowIso();
  const lock = {
    session_id: sessionId,
    started_at: startedAt,
    last_heartbeat: startedAt,
    mode,
    pid: process.pid,
    host: os.hostname(),
    ttl_hours: ttlHours,
  };
  if (typeof semanticSessionId === 'string' && semanticSessionId.length > 0) {
    lock.semantic_session_id = semanticSessionId;
  }
  return lock;
}

/**
 * Determine whether a lock is "live" based on its last_heartbeat freshness
 * relative to TTL. Replaces PID-liveness as the primary discovery-time
 * liveness check (Epic #583, W1-D1 + W1-D4 consensus): the writer-process
 * PID is the *hook* PID, not the session PID, so PID-liveness incorrectly
 * filtered out locks whose semantic owner (the Claude harness process) was
 * still alive.
 *
 * Liveness rule: a lock is live when (now - last_heartbeat) < ttl_hours.
 *
 * @param {{ last_heartbeat: string, started_at: string, ttl_hours?: number }} lock
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isLockLive(lock, nowMs = Date.now()) {
  if (!lock || typeof lock !== 'object') return false;
  // Back-compat: prefer last_heartbeat; fall back to started_at when absent.
  const hbStr = (typeof lock.last_heartbeat === 'string' && lock.last_heartbeat.length > 0)
    ? lock.last_heartbeat
    : lock.started_at;
  const heartbeatMs = Date.parse(hbStr);
  if (Number.isNaN(heartbeatMs)) return false;
  const ttlHours = typeof lock.ttl_hours === 'number' ? lock.ttl_hours : DEFAULT_TTL_HOURS;
  const ttlMs = ttlHours * 3600 * 1000;
  return (nowMs - heartbeatMs) < ttlMs;
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

/**
 * Atomically create the session-lock file via tmp + hardlink (create-or-fail).
 *
 * TOCTOU fix (#590 Item 2): the previous fresh-acquire path used
 * `writeLockAtomic` (tmp + renameSync), which is last-writer-wins — two
 * concurrent SessionStart hooks that BOTH observed `readLock() === null` would
 * BOTH rename their tmp file over the lock and BOTH believe they acquired it.
 * `linkSync` is POSIX-atomic create-or-fail: exactly one concurrent caller wins
 * the create, every other caller gets EEXIST. This is the same idiom already
 * used by {@link createStateLockExclusive} and
 * {@link createStagingFenceLockExclusive} in this file.
 *
 * Used ONLY by the no-existing-lock branch of {@link acquire}. The
 * intentional-overwrite paths (`forceAcquire`, `updateHeartbeat`) keep using
 * `writeLockAtomic` because they MUST replace an existing lock, not fail on it.
 *
 * @param {string} lockFile  Absolute path to .orchestrator/session.lock.
 * @param {object} lock      Lock object to serialize.
 * @returns {{ ok: true } | { ok: false, reason: 'exists' } | { ok: false, reason: 'fs-error', error: string }}
 */
function createSessionLockExclusive(lockFile, lock) {
  const dir = path.dirname(lockFile);
  let tmpFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmpSuffix = crypto.randomBytes(8).toString('hex');
    tmpFile = path.join(dir, `.session.lock.create.tmp.${tmpSuffix}`);
    fs.writeFileSync(tmpFile, JSON.stringify(lock, null, 2) + '\n', { encoding: 'utf8' });
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
 * Consults the P1.1 exclusivity-matrix when `activeSessions` is provided.
 * When omitted, falls back to the legacy local-lock-only logic (backward compat).
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} args.mode
 * @param {number} [args.ttlHours]
 * @param {string} [args.repoRoot]
 * @param {string} [args.semanticSessionId]
 *   Optional always-semantic session id (e.g., `<branch>-<date>-<mode>-<n>`).
 *   When `sessionId` is a UUID (Claude Code path) and a semantic id is also
 *   known, pass it here to be persisted alongside the UUID. Schema v2.
 * @param {boolean} [args.quiet=false]
 *   When true, the unknown-mode classify path SKIPS the `console.warn`-to-stderr
 *   while still defaulting the caller-class to 'parallel-ok'. Added for #592
 *   MED-2: the SessionStart hook (lock-bootstrap.mjs) must keep stderr empty,
 *   and previously pre-sanitised the mode locally to dodge this warn. This flag
 *   lets callers opt into silent unknown-mode handling without duplicating the
 *   mode-mapping logic. PURELY ADDITIVE — default (warn) behaviour is unchanged,
 *   and the raw `mode` is still persisted on the lock body either way.
 * @param {Array<{mode:string,pid:number,host:string,sessionId:string}>} [args.activeSessions]
 *   Optional pre-computed array from discoverActiveSessions(repoRoot). When omitted,
 *   matrix consultation is skipped (legacy behavior). Callers (worktree-pipeline.mjs,
 *   hooks/on-session-start.mjs) call discoverActiveSessions() themselves and pass the
 *   result — this keeps acquire() synchronous.
 *
 * Returns one of:
 *   { ok: true, lock, exclusivityClass? }
 *       — lock created
 *   { ok: false, reason: 'active', existingLock, exclusivityClass? }
 *       — local lock held (live TTL, live PID)
 *   { ok: false, reason: 'stale-pid-dead', existingLock, exclusivityClass? }
 *       — local lock stale (dead PID)
 *   { ok: false, reason: 'stale-pid-alive', existingLock, exclusivityClass? }
 *       — local lock stale (live PID, TTL expired)
 *   { ok: false, reason: 'fs-error', error, exclusivityClass? }
 *       — filesystem failure
 *   { ok: false, reason: 'active-incompatible-exclusive', allActiveSessions, blockingSession, exclusivityClass }
 *       — caller blocked by an active exclusive-class session (P1.2 #570)
 *   { ok: false, reason: 'active-compatible-parallel', allActiveSessions, exclusivityClass }
 *       — caller could create a parallel session; preamble offers Worktree-Auto-Promotion (P1.2 #570)
 *   { ok: false, reason: 'active-readonly-bypass', allActiveSessions, exclusivityClass: 'always-ok' }
 *       — caller is read-only-class; preamble passes through without AUQ (P1.2 #570).
 *       Callers for 'always-ok' modes SHOULD interpret this as "proceed without AUQ, no lock needed".
 *
 * The `exclusivityClass` field is optional (undefined when activeSessions is not passed)
 * and is added to ALL return shapes so callers can always observe the caller's class.
 *
 * The caller (session-start) decides whether to invoke forceAcquire() after
 * obtaining user consent.
 */
export function acquire({ sessionId, mode, ttlHours = DEFAULT_TTL_HOURS, repoRoot, activeSessions, semanticSessionId, quiet = false } = {}) {
  const lockFile = lockPathFor(repoRoot);

  // -------------------------------------------------------------------------
  // Safe classifyMode wrapper — unknown modes default to 'parallel-ok' (most
  // permissive) rather than propagating an exception into the try/catch below
  // where it would be silently turned into an 'fs-error'. A console.warn is
  // emitted for visibility UNLESS the caller passes `quiet: true` (#592 MED-2 —
  // lets lock-bootstrap.mjs keep stderr empty without pre-mapping the mode).
  // This call is intentionally OUTSIDE the main try/catch so that only
  // fs-errors reach the catch block.
  // -------------------------------------------------------------------------
  let callerClass;
  try {
    callerClass = classifyMode(mode);
  } catch {
    if (quiet !== true) {
      console.warn(
        `acquire: unknown mode "${mode}" — defaulting exclusivityClass to "parallel-ok". ` +
        'Add the mode to exclusivity-matrix.mjs if intentional.',
      );
    }
    callerClass = 'parallel-ok';
  }

  // -------------------------------------------------------------------------
  // P1.2 exclusivity-matrix consultation — only when activeSessions is provided.
  // Run BEFORE local-lock check so parallel-session conflicts surface first.
  // -------------------------------------------------------------------------
  if (Array.isArray(activeSessions) && activeSessions.length > 0) {
    let hasCompatibleParallel = false;

    for (const entry of activeSessions) {
      // Safe classify for each active session's mode.
      let entryClass;
      try {
        entryClass = classifyMode(entry.mode);
      } catch {
        // Unknown active session mode — treat as parallel-ok (most permissive default).
        entryClass = 'parallel-ok';
      }

      if (entryClass === 'exclusive' && callerClass !== 'always-ok') {
        // An exclusive active session blocks all non-always-ok callers.
        return {
          ok: false,
          reason: 'active-incompatible-exclusive',
          exclusivityClass: callerClass,
          allActiveSessions: activeSessions,
          blockingSession: entry,
        };
      }

      if (entryClass === 'parallel-ok' && callerClass === 'parallel-ok') {
        hasCompatibleParallel = true;
      }
    }

    // After loop: handle always-ok bypass (read-only caller).
    if (callerClass === 'always-ok') {
      return {
        ok: false,
        reason: 'active-readonly-bypass',
        exclusivityClass: 'always-ok',
        allActiveSessions: activeSessions,
      };
    }

    // Parallel-compatible situation: preamble should offer Worktree-Auto-Promotion.
    if (hasCompatibleParallel) {
      return {
        ok: false,
        reason: 'active-compatible-parallel',
        exclusivityClass: callerClass,
        allActiveSessions: activeSessions,
      };
    }

    // All active sessions are 'always-ok' and caller is non-always-ok, or
    // no blocking condition was found — fall through to local-lock check.
  }

  // -------------------------------------------------------------------------
  // Local lock check — unchanged logic from original acquire().
  // -------------------------------------------------------------------------
  try {
    // Classify an existing lock into the correct failure result. Shared by the
    // up-front readLock() check AND the create-race EEXIST-loser path below so
    // both report identical active / stale-pid-dead / stale-pid-alive reasons.
    const classifyExisting = (existing) => {
      const expired = isTtlExpired(existing);
      const sameHost = existing.host === os.hostname();
      // PID liveness is only meaningful on the same host.
      const pidAlive = sameHost ? isPidAliveOnHost(existing.pid) : null;

      if (!expired && pidAlive !== false) {
        // TTL still valid AND (PID is alive OR we can't check because cross-host).
        return { ok: false, reason: 'active', existingLock: existing, exclusivityClass: callerClass };
      }

      // TTL expired or PID is confirmed dead — classify the stale variant.
      const reason = (pidAlive === false) ? 'stale-pid-dead' : 'stale-pid-alive';
      return { ok: false, reason, existingLock: existing, exclusivityClass: callerClass };
    };

    const existing = readLock({ repoRoot });

    if (existing !== null) {
      // A lock is present — classify it.
      return classifyExisting(existing);
    }

    // No existing lock — create one with a TOCTOU-safe create-or-fail (#590).
    // Two concurrent SessionStart hooks can both reach this branch having each
    // observed readLock() === null; linkSync guarantees exactly one wins.
    const lock = buildLock({ sessionId, mode, ttlHours, semanticSessionId });
    const createResult = createSessionLockExclusive(lockFile, lock);

    if (createResult.ok) {
      return { ok: true, lock, exclusivityClass: callerClass };
    }
    if (createResult.reason === 'fs-error') {
      return { ok: false, reason: 'fs-error', error: createResult.error, exclusivityClass: callerClass };
    }

    // reason === 'exists' — we lost the create race. Re-read the now-present
    // lock and classify it exactly as if we had seen it on the up-front check.
    const raced = readLock({ repoRoot });
    if (raced === null) {
      // The EEXIST winner's lock vanished before we could re-read it (ENOENT /
      // unparseable). Defensive fallback: report 'active' so the caller defers
      // rather than racing again — mirrors tryAcquireStateLock's vanish-race
      // handling (a lost-then-vanished race resolves conservatively).
      return { ok: false, reason: 'active', existingLock: null, exclusivityClass: callerClass };
    }
    return classifyExisting(raced);
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message, exclusivityClass: callerClass };
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
 * @param {{ sessionId: string, mode: string, ttlHours?: number, repoRoot?: string, semanticSessionId?: string }} args
 */
export function forceAcquire({ sessionId, mode, ttlHours = DEFAULT_TTL_HOURS, repoRoot, semanticSessionId } = {}) {
  try {
    const replacedLock = readLock({ repoRoot });
    const lock = buildLock({ sessionId, mode, ttlHours, semanticSessionId });
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
 * Refresh the `last_heartbeat` field on an existing lock, atomically.
 *
 * Schema v2 (Epic #583, W2-I3): the lock's liveness is determined by
 * `(now - last_heartbeat) < ttl_hours`. Callers MUST invoke this on a known
 * cadence (session-start, inter-wave, session-end) to keep the lock alive
 * across long sessions.
 *
 * Same-session guard: refuses to update someone else's lock. Returns `false`
 * when the lock is absent, malformed, or held by a different session_id.
 * Returns `true` on a successful atomic update.
 *
 * Atomicity: same tmp + rename pattern as writeLockAtomic — single syscall
 * visibility on POSIX. Never throws.
 *
 * @param {{ repoRoot?: string, sessionId: string }} opts
 * @returns {boolean}
 */
export function updateHeartbeat({ repoRoot, sessionId } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  const existing = readLock({ repoRoot });
  if (existing === null) return false;
  if (existing.session_id !== sessionId) return false;
  const updated = { ...existing, last_heartbeat: nowIso() };
  const lockFile = lockPathFor(repoRoot);
  const writeResult = writeLockAtomic(lockFile, updated);
  return writeResult.ok === true;
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
  const pidAlive = sameHost ? isPidAliveOnHost(lock.pid) : null;

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

// createStateLockExclusive + replaceStateLockAtomic were inlined into the
// file-lock primitive in #630 — tryAcquireStateLock now delegates to
// tryAcquireFileLock (indent:2, tmpPrefix:'.state.lock.tmp'), which performs the
// tmp+linkSync create and the writeJsonAtomicSync stale-override internally.

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
  // Delegates to the shared file-lock primitive (issue #630). Behavior is
  // preserved EXACTLY: pretty-printed body `{pid, host, acquiredAt, holder}`
  // (indent 2), PID staleCheck, console.warn override channel with the original
  // messages, override tmp prefix `.state.lock.tmp`, and the ENOENT-on-read race
  // collapsed into `held`/existingLock:null (signalVanished:false).
  //
  // The primitive builds its own body (fresh acquiredAt per attempt) from the
  // pid/host of THIS process plus the holder carried on `body`. acquiredAt is
  // only meaningful on the written (winning) attempt, so reusing vs regenerating
  // it across poll passes is observationally identical.
  const attempt = tryAcquireFileLock(lockFile, {
    staleCheck: 'pid',
    holder: body.holder,
    indent: 2,
    tmpPrefix: '.state.lock.tmp',
    warnMessage: (reason, _lp, existing) =>
      existing === null
        ? 'stale state.lock (unparseable contents) overridden'
        : `stale state.lock from PID ${existing.pid} overridden`,
  });

  if (attempt.acquired) return { ok: true, lock: attempt.body };
  if (attempt.reason === 'fs-error') return { ok: false, reason: 'fs-error', error: attempt.error };
  // reason === 'held' (live holder, cross-host, or vanished-collapsed-to-held).
  return { ok: false, reason: 'held', existingLock: attempt.existing ?? null };
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

// createStagingFenceLockExclusive + replaceStagingFenceLockAtomic were inlined
// into the file-lock primitive in #630 — tryAcquireStagingFenceLock now
// delegates to tryAcquireFileLock (indent:2, tmpPrefix:'.staging-fence.lock.tmp').

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
  // Delegates to the shared file-lock primitive (issue #630). Structurally
  // identical to tryAcquireStateLock — only the tmp prefix + WARN messages
  // differ. Behavior preserved EXACTLY: pretty body (indent 2), PID staleCheck,
  // console.warn channel, override prefix `.staging-fence.lock.tmp`,
  // ENOENT-on-read collapsed into `held`/existingLock:null.
  const attempt = tryAcquireFileLock(lockFile, {
    staleCheck: 'pid',
    holder: body.holder,
    indent: 2,
    tmpPrefix: '.staging-fence.lock.tmp',
    warnMessage: (reason, _lp, existing) =>
      existing === null
        ? 'stale staging-fence.lock (unparseable contents) overridden'
        : `stale staging-fence.lock from PID ${existing.pid} overridden`,
  });

  if (attempt.acquired) return { ok: true, lock: attempt.body };
  if (attempt.reason === 'fs-error') return { ok: false, reason: 'fs-error', error: attempt.error };
  return { ok: false, reason: 'held', existingLock: attempt.existing ?? null };
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
