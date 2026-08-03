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
 *  - Owner-proof, not just id-match (#906-class fix): the semantic session id
 *    is NOT globally unique (the id-counter can hand out the same
 *    `<branch>-<date>-<mode>-<n>` to two different session processes on the
 *    same day). `buildLockOwnerProof()` / `isLockOwnedByProof()` verify
 *    ownership via a SECOND identity factor (pid + host + started_at)
 *    instead of trusting a session_id/semantic_session_id match alone. See
 *    their JSDoc for the fail-closed contract and factor-choice rationale.
 *
 * BARREL CONTRACT (#630 A1 barrel-preserving split):
 *   This module bundled THREE orthogonal lock protocols. Two of them — the
 *   STATE.md write-lock and the staging-fence commit-mutex — were moved into
 *   dedicated modules under `scripts/lib/locks/`. This file STAYS the canonical
 *   barrel: it keeps the session-lock CORE protocol AND re-exports every moved
 *   symbol, so the original 22-symbol import surface is preserved EXACTLY and
 *   all 17 importers keep working UNCHANGED. The moved modules import shared
 *   primitives from leaf modules (file-lock.mjs, locks/lock-body.mjs) and NEVER
 *   from this file, so the barrel ↔ protocol-module edge is one-directional
 *   (no import cycle).
 *     - STATE.md write-lock    → ./locks/state-md-lock.mjs
 *     - staging-fence mutex     → ./locks/staging-fence-lock.mjs
 *
 * No external dependencies — Node 20+ stdlib only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { classifyMode } from './exclusivity-matrix.mjs';
import { isPidAliveOnHost } from './file-lock.mjs';
import { writeJsonAtomicSync } from './io.mjs';

// isPidAliveOnHost moved into file-lock.mjs in #630 (the file-lock primitive
// owns it so the dependency edge points file-lock → io, never the reverse).
// Re-exported here so existing importers (agent-status historically,
// session-discovery's forensic note, memory-proposals historically, and any
// external caller) keep resolving `isPidAliveOnHost` from session-lock.mjs.
export { isPidAliveOnHost };

// ---------------------------------------------------------------------------
// Re-exports — STATE.md write-lock + staging-fence commit-mutex (#630 split).
// These two protocols live in dedicated modules now; the barrel re-exports
// their full public surface so importers of session-lock.mjs are unchanged.
// ---------------------------------------------------------------------------

export {
  STATE_LOCK_PATH,
  DEFAULT_STATE_LOCK_TIMEOUT_MS,
  STATE_LOCK_POLL_MS,
  acquireStateLock,
  releaseStateLock,
  withStateMdLock,
} from './locks/state-md-lock.mjs';

export {
  STAGING_FENCE_LOCK_PATH,
  DEFAULT_STAGING_FENCE_LOCK_TIMEOUT_MS,
  STAGING_FENCE_LOCK_POLL_MS,
  acquireStagingFenceLock,
  releaseStagingFenceLock,
  withStagingFenceLock,
} from './locks/staging-fence-lock.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TTL_HOURS = 4;
export const LOCK_PATH = '.orchestrator/session.lock';

/**
 * Where the durable lock-ownership proof lives, relative to the repo root
 * (#987 Part 1). `.orchestrator/runtime/` is machine-local, gitignored state —
 * the proof must survive across hook subprocesses of the SAME logical session
 * but never travel via VCS.
 */
export const OWNER_PROOF_RELPATH = '.orchestrator/runtime/lock-owner-proof.json';

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
 * the create, every other caller gets EEXIST. This is the same idiom used by
 * the file-lock primitive (tryAcquireFileLock) backing the state-lock and
 * staging-fence-lock modules.
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
 * BACK-COMPAT CONTRACT (load-bearing — grep-verified 2026-07-29):
 *   A bare `grep -rn "readLock("` over scripts/ + hooks/ reports 14 hits, but
 *   6 of those are comment/JSDoc mentions, not calls. Filtering them out —
 *   `grep -rn "readLock(" --include='*.mjs' scripts/ hooks/ | grep -v
 *   "scripts/lib/session-lock.mjs" | grep -vE ':\s*(\*|//)' | wc -l` → 8 real
 *   production call sites across 6 files (lock-reaper, peer-discovery,
 *   session-close-backfill, session-discovery, sessions-staleness-banner,
 *   vault-status/board-writer). The tests/ figure has the same caveat: of the
 *   45 raw hits, ~11 are comments and 3 are local same-named test doubles.
 *   Counting raw grep hits as call sites OVERSTATES the surface — the number
 *   is smaller than first briefed, but every one of those 8 relies on the
 *   "absent/unreadable/corrupt all collapse to null" contract below, so the
 *   conclusion is unchanged. This function's signature and null behaviour
 *   MUST stay byte-for-byte identical — the discriminated read that
 *   distinguishes those three cases is the NEW, additive `readLockDetailed()`
 *   below; `readLock()` is now a thin projection of it back onto the legacy
 *   contract (RCR-007: changing the 59-call-site contract itself would be a
 *   public-API break, not a same-scope fix).
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {{ session_id: string, started_at: string, mode: string, pid: number, host: string, ttl_hours: number } | null}
 */
export function readLock(opts = {}) {
  const detailed = readLockDetailed(opts);
  return detailed.status === 'ok' ? detailed.lock : null;
}

/**
 * Read the lock file and DISCRIMINATE why it might not yield a usable lock —
 * additive alongside `readLock()` (see its back-compat contract note above),
 * which collapses every non-ok case to `null`. That collapse is exactly how
 * a vanished/unreadable lock has read as "no lock" instead of "anomaly"
 * throughout this session's investigation (#906-class incident).
 *
 * Four discriminated outcomes:
 *   - `{ status: 'absent' }` — the file does not exist (ENOENT). This is the
 *     ONLY case that should be treated as "no lock, proceed as if free".
 *   - `{ status: 'unreadable', error }` — the file exists but could not be
 *     read (e.g. EACCES, EISDIR). Distinct from `absent` on purpose: an
 *     unreadable lock is an ANOMALY a caller may want to surface, not a
 *     green light to acquire.
 *   - `{ status: 'corrupt', raw }` — the file was read but its contents
 *     failed `parseLock()` (invalid JSON, or valid JSON missing the required
 *     shape). `raw` is included so a caller can log/diagnose without a
 *     second read.
 *   - `{ status: 'ok', lock }` — the file was read and parsed successfully.
 *
 * Never throws.
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {
 *   { status: 'absent' } |
 *   { status: 'unreadable', error: string } |
 *   { status: 'corrupt', raw: string } |
 *   { status: 'ok', lock: object }
 * }
 */
export function readLockDetailed(opts = {}) {
  const lockFile = lockPathFor(opts.repoRoot);
  let raw;
  try {
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { status: 'absent' };
    }
    return { status: 'unreadable', error: err.message };
  }

  const lock = parseLock(raw);
  if (lock === null) {
    return { status: 'corrupt', raw };
  }
  return { status: 'ok', lock };
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
      const sameHost = existing.host === os.hostname();
      // PID liveness is only meaningful on the same host.
      const pidAlive = sameHost ? isPidAliveOnHost(existing.pid) : null;

      // Heartbeat-first liveness (#744): isLockLive is the SOLE active gate.
      // A dead recorded PID must NOT veto a fresh last_heartbeat — the pid on
      // a session.lock is the ephemeral hook subprocess PID, not the semantic
      // session's own PID (Epic #583, W1-D1 + W1-D4 consensus). Likewise,
      // isTtlExpired measures age from started_at, which wrongly flags a
      // long-running-but-heartbeating session as expired. Both bugs together
      // produced the #744 incident: a live heartbeating session was
      // misclassified 'stale-pid-dead' mid-wave.
      if (isLockLive(existing)) {
        return { ok: false, reason: 'active', existingLock: existing, exclusivityClass: callerClass };
      }

      // Heartbeat expired — classify the stale variant. Cross-host locks never
      // have a confirmable dead PID (pidAlive stays null), so they always land
      // on 'stale-pid-alive' rather than 'stale-pid-dead'.
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
 * Extract an ownership-proof object from a lock — the field-name translation
 * layer `isLockOwnedByProof()` expects. Intended usage: a caller that just
 * created/observed a lock IT WROTE (the `lock` returned by
 * `acquire()`/`forceAcquire()`, or a `readLock()`/`readLockDetailed()` taken
 * immediately after) calls this ONCE at genesis time and persists the
 * RESULT — not the raw lock — as its durable "I own this" evidence. Later,
 * a different process invocation (e.g. a subsequent hook subprocess in the
 * same logical session) can present that persisted proof to
 * `isLockOwnedByProof()` against whatever lock is on disk AT THAT TIME.
 *
 * Pure, no-throw. Returns `null` (never a partial object) when any of the
 * three required fields is missing or the wrong type — a caller cannot
 * construct a proof from a lock it cannot fully observe.
 *
 * @param {object|null} lock
 * @returns {{ pid: number, host: string, startedAt: string } | null}
 */
export function buildLockOwnerProof(lock) {
  if (!lock || typeof lock !== 'object') return null;
  const { pid, host, started_at: startedAt } = lock;
  if (typeof pid !== 'number') return null;
  if (typeof host !== 'string' || host.length === 0) return null;
  if (typeof startedAt !== 'string' || startedAt.length === 0) return null;
  return { pid, host, startedAt };
}

/**
 * Verify that a caller genuinely owns a lock, using a SECOND identity factor
 * beyond the (non-unique) session_id / semantic_session_id.
 *
 * WHY THIS EXISTS (#906-class bug, this session's root-cause finding): the
 * semantic session id (`<branch>-<date>-<mode>-<n>`) is NOT globally unique
 * — the id-counter can hand out the SAME id to two different session
 * processes on the same day (live-observed collisions this session:
 * `main-2026-07-29-deep-1` and `main-2026-07-29-session-1`, each assigned
 * twice). `hooks/on-session-end.mjs`'s `ownBySemanticStrict` path currently
 * decides lock ownership from that colliding id alone and can delete a
 * LIVE, foreign session's lock as a result. `release()`'s pre-existing
 * `existing.session_id !== sessionId` check (below) is a TOCTOU re-read
 * guard — it re-derives the exact same potentially-colliding key, so it
 * catches "the lock changed between my two reads" but NOT "the lock I'm
 * looking at was never mine to begin with". This function is the missing
 * proof.
 *
 * FACTOR CHOICE — pid + host + started_at, never session_id:
 *   - `host` is required first: liveness/identity cannot be asserted across
 *     machines anyway (see `isPidAliveOnHost`), so a lock written on a
 *     DIFFERENT host is rejected outright, no further comparison needed.
 *   - `pid` alone is not unique on a long-lived host — the OS recycles PIDs
 *     once the original process exits — so it cannot carry the proof by
 *     itself.
 *   - `started_at` is the actual discriminator: its ISO-8601-with-
 *     milliseconds value is knowable ONLY to a caller that was PRESENT at
 *     lock-creation time (it wrote the lock itself, or read it back
 *     immediately after `acquire()`/`forceAcquire()` returned). A same-day
 *     semantic-id collision from an unrelated process has, with
 *     overwhelming probability, a DIFFERENT millisecond `started_at` — this
 *     is exactly the discriminator the id-collision case lacks.
 *   - Combined, `pid + host + started_at` is a proof of PRESENCE AT GENESIS,
 *     not a re-assertion of the same collidable name.
 *
 * FAIL-CLOSED CONTRACT: any missing/malformed field on EITHER side (the
 * live lock or the caller's proof) returns `false`. This function must
 * never answer "true" when it cannot actually confirm ownership — silently
 * defaulting to permissive on incomplete data is the exact fail-open shape
 * this session exists to close (see the `console.log + process.exit()`
 * stdout-truncation rule and the exit-code-to-JSON-migration rule in this
 * repo's reconciled learnings for the same failure class in other guards).
 *
 * @param {object|null} lock  The CURRENT on-disk lock (e.g. from `readLock()`).
 * @param {{ pid: number, host: string, startedAt: string }|null} proof
 *   Typically the return value of `buildLockOwnerProof()` captured at
 *   genesis time. NEVER re-derive this from `process.pid`/`os.hostname()`
 *   at check-time — the checking process is very likely a DIFFERENT
 *   subprocess (each hook invocation is its own process) than the one that
 *   originally wrote the lock.
 * @returns {boolean} true only when pid, host, AND started_at all match
 *   exactly between `lock` and `proof`.
 */
export function isLockOwnedByProof(lock, proof) {
  if (!lock || typeof lock !== 'object') return false;
  if (!proof || typeof proof !== 'object') return false;

  const { pid: lockPid, host: lockHost, started_at: lockStartedAt } = lock;
  const { pid: proofPid, host: proofHost, startedAt: proofStartedAt } = proof;

  if (typeof lockPid !== 'number' || typeof proofPid !== 'number') return false;
  if (typeof lockHost !== 'string' || lockHost.length === 0) return false;
  if (typeof proofHost !== 'string' || proofHost.length === 0) return false;
  if (typeof lockStartedAt !== 'string' || lockStartedAt.length === 0) return false;
  if (typeof proofStartedAt !== 'string' || proofStartedAt.length === 0) return false;

  return lockPid === proofPid && lockHost === proofHost && lockStartedAt === proofStartedAt;
}

/**
 * Persist the ownership proof of a just-written lock to
 * `.orchestrator/runtime/lock-owner-proof.json` (#987 Part 1 — proof
 * persistence at lock genesis; Part 2, the on-session-end consumption side,
 * is a separate change).
 *
 * Intended caller: `bootstrapLock()` (hooks/_lib/lock-bootstrap.mjs)
 * immediately after its enriched-lock write — the `lock` argument there is
 * byte-identical to the on-disk lock, so the proof it yields will verify via
 * `isLockOwnedByProof()` against any later re-read of that same lock.
 *
 * Envelope shape (schema_version 1):
 *   {
 *     schema_version: 1,
 *     proof: { pid, host, startedAt },   // the ONLY field ever compared
 *     lock_session_id,                   // forensic-only
 *     semantic_session_id,               // forensic-only
 *     repo_root,                         // forensic-only
 *     written_at,                        // forensic-only
 *   }
 *
 * INVARIANT: only `proof` may ever participate in an ownership comparison.
 * `lock_session_id` / `semantic_session_id` rotate per session and the
 * semantic form COLLIDES across same-day sessions — trusting them is exactly
 * the #906-class bug this proof exists to close. Consumers go through
 * `loadOwnerProof()`, which strips the envelope and returns the triple alone.
 *
 * No-throw. When the lock cannot yield a full proof (missing/mistyped
 * pid/host/started_at), this is a deliberate no-op: nothing is written and
 * `{ ok: false, reason: 'unproovable-lock' }` is returned — a partial proof
 * on disk would be a fail-open artifact.
 *
 * @param {{ repoRoot?: string, lock: object|null }} args
 * @returns {{ ok: true, path: string }
 *          |{ ok: false, reason: 'unproovable-lock' }
 *          |{ ok: false, reason: 'fs-error', error: string }}
 */
export function writeOwnerProof({ repoRoot, lock } = {}) {
  try {
    const proof = buildLockOwnerProof(lock);
    if (proof === null) {
      return { ok: false, reason: 'unproovable-lock' };
    }

    const root = repoRoot ?? process.cwd();
    const proofFile = path.join(root, OWNER_PROOF_RELPATH);
    const envelope = {
      schema_version: 1,
      proof,
      lock_session_id: typeof lock.session_id === 'string' ? lock.session_id : null,
      semantic_session_id:
        typeof lock.semantic_session_id === 'string' ? lock.semantic_session_id : null,
      repo_root: root,
      written_at: nowIso(),
    };

    const w = writeJsonAtomicSync(proofFile, envelope, { tmpPrefix: '.lock-owner-proof.tmp' });
    if (!w.ok) return w;
    return { ok: true, path: proofFile };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }
}

/**
 * Load the persisted ownership proof written by `writeOwnerProof()` and
 * return the inner `{ pid, host, startedAt }` triple — nothing else from the
 * envelope ever escapes (the forensic fields must not leak into comparisons,
 * see the INVARIANT on `writeOwnerProof()`).
 *
 * FAIL-CLOSED, never throws: a missing file, unreadable file, malformed
 * JSON, an envelope without a `proof` object, or a proof with any
 * missing/mistyped field all return `null`. A `null` proof presented to
 * `isLockOwnedByProof()` yields `false` — the consumer degrades to
 * "cannot prove ownership", never to "assume ownership".
 *
 * Note the proof carries no self-expiry: a stale proof from a PREVIOUS
 * session is harmless by construction, because the triple it holds (its
 * millisecond `started_at` above all) will not match any newer lock —
 * `isLockOwnedByProof()` rejects it. See the stale-proof test in
 * tests/lib/session-lock.test.mjs.
 *
 * @param {{ repoRoot?: string }} args
 * @returns {{ pid: number, host: string, startedAt: string } | null}
 */
export function loadOwnerProof({ repoRoot } = {}) {
  try {
    const proofFile = path.join(repoRoot ?? process.cwd(), OWNER_PROOF_RELPATH);
    const raw = fs.readFileSync(proofFile, 'utf8');
    const envelope = JSON.parse(raw);
    if (!envelope || typeof envelope !== 'object') return null;

    const p = envelope.proof;
    if (!p || typeof p !== 'object') return null;
    if (typeof p.pid !== 'number') return null;
    if (typeof p.host !== 'string' || p.host.length === 0) return null;
    if (typeof p.startedAt !== 'string' || p.startedAt.length === 0) return null;

    return { pid: p.pid, host: p.host, startedAt: p.startedAt };
  } catch {
    return null;
  }
}

/**
 * Release the lock IFF it belongs to the given session_id.
 * Silent no-op when the lock belongs to a different session or does not exist.
 * Never throws.
 *
 * Post-delete verify (#744 Fix 3, refined): after unlinking, re-reads the
 * lock path to confirm the delete was durable. The retry is **ownership-
 * scoped** — only OUR OWN lock reappearing (same `session_id`) warrants a
 * bounded retry unlink, which covers a transient unlink/stat race where our
 * just-deleted file is briefly still observable. A FOREIGN lock (a
 * different `session_id`) present at the re-read means a sibling session
 * legitimately `acquire()`d the path in the race window between our unlink
 * and this re-read — OUR lock is already gone (the delete succeeded), so
 * this is treated as verified and the foreign lock is left untouched. This
 * is load-bearing for PSA-005: a releaser must never unlink a lock it does
 * not own, even indirectly via a "still present, so retry-unlink" heuristic
 * that does not check who the present lock belongs to.
 *
 * `verified` is computed as "our lock is no longer present" — a foreign
 * lock present is fine (ours is gone); only our own lock still being
 * observable after the bounded retry sets `verified: false`.
 *
 * Optional proof-gated ownership (#906-class fix, additive): pass `proof`
 * (see `buildLockOwnerProof()` / `isLockOwnedByProof()`) to require a SECOND
 * identity factor beyond `session_id` before deleting — this is what makes
 * a same-day semantic-id collision safe to release against. When `proof` is
 * omitted (the default), behaviour is BYTE-IDENTICAL to before this change:
 * only the `session_id` match gates the delete. This keeps the ONE other
 * external caller (`scripts/lib/autopilot/worktree-pipeline.mjs`, which does
 * not pass `proof`) working unchanged — it stays on the weaker,
 * session_id-only path.
 *
 * @param {{ sessionId: string, repoRoot?: string, proof?: { pid: number, host: string, startedAt: string } }} args
 * @returns {{ ok: true, deleted: boolean, reason?: string, verified?: boolean }}
 */
export function release({ sessionId, repoRoot, proof } = {}) {
  const lockFile = lockPathFor(repoRoot);
  try {
    const existing = readLock({ repoRoot });

    if (existing === null) {
      return { ok: true, deleted: false, reason: 'no-lock' };
    }

    if (existing.session_id !== sessionId) {
      return { ok: true, deleted: false, reason: 'session-mismatch' };
    }

    // Proof-gated release (additive, #906-class fix): when the caller supplies
    // `proof`, the session_id match above is NOT sufficient by itself —
    // session_id collisions are the documented root cause behind this check.
    // Omitting `proof` leaves this branch dead code, preserving the exact
    // pre-existing behaviour for callers that don't pass it.
    if (proof !== undefined && !isLockOwnedByProof(existing, proof)) {
      return { ok: true, deleted: false, reason: 'proof-mismatch' };
    }

    fs.unlinkSync(lockFile);

    // Post-delete verify: only retry when OUR OWN lock is still observable.
    // A foreign lock here belongs to a sibling that re-acquired in the race
    // window — never touch it (PSA-005).
    let after = readLock({ repoRoot });
    if (after !== null && after.session_id === sessionId) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // best-effort retry — fall through to the final re-check regardless.
      }
      after = readLock({ repoRoot });
    }

    const verified = after === null || after.session_id !== sessionId;
    return { ok: true, deleted: true, verified };
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
 *   sameHost: boolean,
 *   isLive: boolean
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
      isLive: false,
    };
  }

  const ageHours = lockAgeHours(lock);
  const ttlExpired = isTtlExpired(lock);
  const sameHost = lock.host === os.hostname();
  // Only attempt PID check when the lock was written on this machine.
  const pidAlive = sameHost ? isPidAliveOnHost(lock.pid) : null;
  // Heartbeat-based liveness (#744) — additive field alongside the pre-existing
  // ttlExpired/pidAlive/sameHost fields (back-compat). This is the SAME check
  // acquire()'s classifyExisting now uses as its sole active gate, surfaced
  // here so callers of checkStale() (recovery-flow diagnostics) can observe
  // when isLive diverges from the legacy pidAlive/ttlExpired signals.
  const isLive = isLockLive(lock);

  return {
    exists: true,
    lock,
    ageHours,
    ttlExpired,
    pidAlive,
    host: lock.host,
    sameHost,
    isLive,
  };
}
