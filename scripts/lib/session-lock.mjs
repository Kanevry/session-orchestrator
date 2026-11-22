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
import { isLockShape, isValidLockTtlHours } from './session-lock-shape.mjs';
import { isPidAliveOnHost, tryAcquireFileLock, releaseFileLock } from './file-lock.mjs';
import { writeJsonAtomicSync } from './io.mjs';
import { hostnamesMatch, lockHostCandidate, recordHostAlias, stableHostname } from './host-identity.mjs';
import { isSafeSessionId } from './fleet-protocol.mjs';

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
 * Serialize every primary-lock mutation (#2073) using the existing file-lock
 * primitive. A same-host dead-PID `.write` mutex is recovered only after its
 * mtime is at least two seconds old, checked under file-lock's `.acquire`.
 * Live, foreign and malformed mutexes stay busy. Heartbeat/enrichment take one
 * attempt; acquire, force and release retry for at most 100ms in 5ms steps.
 *
 * BV-004: `.write.acquire` is NEVER stolen, even after a crash: the lower
 * primitive's never-steal boundary remains. That residue requires quiescing
 * ALL writers before explicitly removing the exact abandoned sibling. A
 * recycled PID conservatively keeps a dead writer's mutex busy. Revisit on a
 * persistent `busy` after a crash or cleanup failure on a supported filesystem.
 * Mixed-version writers which ignore this protocol are not serialized; all
 * processes sharing a checkout must be upgraded together.
 * `lock-reaper.mjs` remains an unguarded legacy deleter, already called by
 * on-session-start and lock-reconcile. Its exclusion is NOT an enforced
 * operational restriction: it can still race a heartbeat or any writer.
 * Revisit its archive/unlink migration before claiming checkout-wide safety,
 * or upon any concurrent reaper activity (separate approved scope required).
 *
 * @template T
 * @param {string|undefined} repoRoot
 * @param {() => T} mutate synchronous critical section; never calls this helper again
 * @param {number} [retryMs=0] bounded contention budget; heartbeat never waits
 * @returns {T|{ok: false, reason: string, error?: string}}
 */
function mutatePrimaryLock(repoRoot, mutate, retryMs = 0) {
  const guardPath = `${lockPathFor(repoRoot)}.write`;
  try {
    const deadline = Date.now() + retryMs;
    // An attempt count also bounds reentrant contention when the wall clock
    // is frozen or stepped backwards. No callback runs until we own .write.
    const attempts = Math.ceil(retryMs / PRIMARY_WRITE_POLL_MS) + 1;
    for (let attempt = 0; ; attempt += 1) {
      const guard = tryAcquireFileLock(guardPath, {
        staleCheck: 'pid',
        minStaleAgeMs: PRIMARY_WRITE_MIN_AGE_MS,
        tmpPrefix: '.session.lock.write.tmp',
      });
      if (guard.acquired) break;
      if (guard.reason === 'fs-error') return { ok: false, reason: 'fs-error', error: guard.error };
      const remaining = deadline - Date.now();
      if (remaining <= 0 || attempt + 1 >= attempts) return { ok: false, reason: 'busy' };
      sleepPrimaryWrite(Math.min(PRIMARY_WRITE_POLL_MS, remaining));
    }
    try {
      return mutate();
    } finally {
      // A conforming contender cannot replace this mutex while our PID is
      // alive (a paused process is alive too; a killed one cannot later run
      // this finally). Avoid taking .acquire again: even brief contention on
      // cleanup could otherwise strand our LIVE .write in a long-lived caller.
      releaseFileLock(guardPath, { ownerGuard: false });
    }
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

const PRIMARY_WRITE_MIN_AGE_MS = 2000;
const PRIMARY_WRITE_RETRY_MS = 100;
const PRIMARY_WRITE_POLL_MS = 5;

/** Same synchronous, CPU-cheap polling cadence as the underlying primitive. */
function sleepPrimaryWrite(ms) {
  const end = Date.now() + ms;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    while (Date.now() < end) { /* fallback for runtimes without Atomics.wait */ }
  }
}

/**
 * How far in the future a `last_heartbeat` may lie and still count as live
 * (#1494). Every heartbeat is stamped by `Date.now()` on the writing host, so
 * on one host it is never ahead of the clock unless that clock was stepped
 * backwards (NTP at boot, a manual change) — the tolerance absorbs such a step
 * and cross-host skew on a shared checkout. Ceiling (BV-004): a clock stepped
 * back by more than 5 minutes makes every live lock written just before it read
 * as stale, and the next SessionStart reclaims it. Revisit if a `reclaimed`
 * event follows a clock step on a host whose previous session was still running.
 *
 * Exported as the ONE copy of this tolerance (#1505.1/.2): the session registry
 * (`session-registry.mjs` `_ageMinutes`) and the lock reaper (`lock-reaper.mjs`
 * `ageHoursOf`, `currentSessionAgeHours`) apply the same future-stamp rule.
 */
export const FUTURE_HEARTBEAT_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The lock manager's own transient files beside `session.lock` (#1505.3): the
 * `writeLockAtomic()` tmp (6 random bytes), the `createSessionLockExclusive()`
 * tmp and the `reclaimIfNotLive()` tombstone (8 random bytes each). The primary
 * mutex is `session.lock.write` (no leading dot); its legacy dot-prefixed
 * spelling is recognized too. File-lock's exact tmpPrefix-generated siblings
 * are `.session.lock.write.tmp.create.tmp.<16hex>`,
 * `.session.lock.write.tmp.acquire.create.tmp.<16hex>` and, on takeover,
 * `.session.lock.write.tmp.<12hex>`. `.write.acquire` is recognized but kept.
 * Anchored and exact so `session.lock` itself — or any foreign file — can
 * never match.
 */
const LOCK_LEFTOVER_RE = /^(?:\.session\.lock\.(?:tmp\.[0-9a-f]{12}|create\.tmp\.[0-9a-f]{16}|reclaim\.[0-9a-f]{16}|write\.tmp\.(?:[0-9a-f]{12}|(?:acquire\.)?create\.tmp\.[0-9a-f]{16}))|\.?session\.lock\.write(?:\.acquire)?)$/;

/**
 * Minimum age for the legacy primary tmp/reclaim family in
 * {@link sweepLockLeftovers}; the .write family has its own two-second,
 * dead-PID rule. Each lives inside ONE synchronous call (write → rename/link → unlink),
 * milliseconds long. Ceiling (BV-004): the age is taken from the later of
 * mtime and ctime, because a tombstone is a RENAMED lock whose mtime is the
 * old lock's last write; rename updates ctime (measured 2026-10-03 on APFS;
 * ext4/xfs do too). On a filesystem whose rename touches neither, a tombstone
 * could look old mid-reclaim — the tombstone content check below still keeps
 * every live one. Revisit if a `reclaimed` event is followed by a lost
 * link-back on such a filesystem.
 */
export const LOCK_LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Where the durable lock-ownership proof lives, relative to the repo root
 * (#987 Part 1). `.orchestrator/runtime/` is machine-local, gitignored state —
 * the proof must survive across hook subprocesses of the SAME logical session
 * but never travel via VCS.
 */
export const OWNER_PROOF_RELPATH = '.orchestrator/runtime/lock-owner-proof.json';

/**
 * Directory of the "released on purpose" markers (#1651), relative to the repo
 * root — one `<raw session_id>.json` per session that gave its lock back via
 * `scripts/release-session-lock.mjs`. Gitignored like the owner proof beside it.
 */
export const RELEASE_MARKER_RELDIR = '.orchestrator/runtime/lock-released';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// isPidAliveOnHost lives in file-lock.mjs (#630) and is re-exported at the top
// of this module. It is a SAME-HOST PID liveness probe (POSIX signal-0). It is
// NOT the discovery-path liveness check — since Epic #583 the discovery
// decision tree uses heartbeat-age via {@link isLockLive} instead, because the
// `pid` recorded on a session.lock is the *ephemeral hook subprocess* PID.
// Primary-session liveness never consults it: `acquire()` stopped doing so in
// #744/#1137 and `checkStale()` in #1151. The leftover sweep does use it for
// the short-lived .write mutex/tmp bodies, whose PID IS the actual writer.
// File-lock's stale-override path and lock-reaper.mjs also use it; see
// file-lock.mjs for the full @forensic + PID-recycle trade-off note.

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
 * Compute the age of a lock's heartbeat in fractional minutes.
 *
 * This is the diagnostic counterpart to `isLockLive()` — the SAME quantity the
 * liveness rule thresholds against, surfaced as a number so callers (the
 * Phase-1.2 stale-lock AUQ, recovery diagnostics) can report WHY a lock was
 * classified stale instead of asserting a PID verdict the lock cannot support
 * (#1137). Reads `last_heartbeat` only, like `isLockLive()`: a lock without one
 * has no heartbeat age, so this returns `null` rather than an age invented from
 * `started_at` (#595, 2026-10-02 — the v1 fallback is gone).
 *
 * @param {{ last_heartbeat?: string }} lock
 * @returns {number|null} minutes since the last heartbeat, or null when the lock
 *   carries no parseable `last_heartbeat`.
 */
function heartbeatAgeMinutes(lock) {
  if (!lock || typeof lock !== 'object') return null;
  if (typeof lock.last_heartbeat !== 'string' || lock.last_heartbeat.length === 0) return null;
  const ts = Date.parse(lock.last_heartbeat);
  if (Number.isNaN(ts)) return null;
  return (Date.now() - ts) / (60 * 1000);
}

/**
 * Parse lock file contents into an object. Returns null on any parse error.
 *
 * Schema v2 (Epic #583, W2-I3): adds `last_heartbeat` (optional, populated by
 * `updateHeartbeat()`) + `semantic_session_id` (optional, populated when the
 * `session_id` field carries a UUID and the caller wants to preserve the
 * always-semantic id alongside it).
 *
 * A lock WITHOUT `last_heartbeat` (#595 sunset, 2026-10-02) is returned as-is:
 * its heartbeat is no longer filled in from `started_at`, and it is deliberately not
 * rejected either. It stays VISIBLE — `readLockDetailed()` reports `ok` and
 * `acquire()` classifies it `stale-heartbeat` (heartbeat age `null`), which
 * lets the SessionStart bootstrap reclaim it — while `isLockLive()` reads it
 * as not live. Rejecting it here would make it `corrupt`: still reclaimable
 * (`acquire()` reports `corrupt` since 2026-10-02 — until then the
 * create-or-fail hit EEXIST and the vanished-race branch answered `active`
 * with `existingLock: null` on every attempt, wedging the repo), but invisible
 * to every `readLock()` caller, which would lose its session_id, host and
 * started_at. No writer has produced such a lock since Epic #583:
 * `buildLock()`, the hook bootstrap and `updateHeartbeat()` all set
 * `last_heartbeat`.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function parseLock(raw) {
  try {
    const obj = JSON.parse(raw);
    // The six-field predicate lives in ONE place (#1153 P7) — see
    // `./session-lock-shape.mjs` for the other consumer and the fail-open
    // drift this sharing prevents.
    // semantic_session_id stays undefined when absent — callers that need it
    // should fall back to session_id.
    return isLockShape(obj) ? obj : null;
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
  // Writing a session lock is the one moment we KNOW the current os.hostname()
  // belongs to this machine — record it so a later reading under a different
  // spelling can still be recognised as the same host (#1072). Best-effort:
  // recordHostAlias never throws, and a failed write only costs the alias.
  recordHostAlias();
  const lock = {
    session_id: sessionId,
    started_at: startedAt,
    last_heartbeat: startedAt,
    ...lockMetadata(mode, ttlHours, semanticSessionId),
    pid: process.pid,
    // `host` stays the RAW hostname — it is an on-the-wire event field
    // (orchestrator.session.lock.acquired) and feeds the privacy-hash contract.
    // `host_id` is the additive normalised twin every comparison reads (#1072).
    host: os.hostname(),
    host_id: stableHostname(),
  };
  if (lock.semantic_session_id === undefined) delete lock.semantic_session_id;
  return lock;
}

function lockMetadata(mode, ttlHours, semanticSessionId) {
  return {
    // mode and ttl_hours are coerced here because acquire()/forceAcquire() take
    // them from hand-written callers (dispatcher claimRepo, the phase-1.2 prose)
    // unchecked: `mode: undefined` vanished from the JSON and `ttlHours: null`
    // or "4" had the wrong type, so the lock failed isLockShape() — and a lock
    // that fails the shape is reclaimed as 'corrupt' by the next session even
    // while its heartbeat is fresh. 'unknown' classifies like any unknown mode
    // (parallel-ok, see the acquire() wrapper).
    mode: typeof mode === 'string' && mode.trim().length > 0 ? mode : 'unknown',
    ttl_hours: isValidLockTtlHours(ttlHours) ? ttlHours : DEFAULT_TTL_HOURS,
    semantic_session_id: typeof semanticSessionId === 'string' && semanticSessionId.length > 0
      ? semanticSessionId : undefined,
  };
}

function refreshTombstoneLock(lock, mode, ttlHours, semanticSessionId) {
  return { ...lock, ...lockMetadata(mode, ttlHours, semanticSessionId), last_heartbeat: nowIso() };
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
 * No `started_at` fallback (#595 sunset, 2026-10-02): a lock with no
 * `last_heartbeat` is NOT live — nothing is heartbeating it, so it must not
 * hold the repo for a TTL window counted from its start. The rule is mirrored
 * in `scripts/lib/harness-audit/categories/category4.mjs` `lockIsLive()`, and
 * `tests/lib/lock-ttl-parity.test.mjs` holds the two to identical verdicts.
 * See `skills/_shared/state-ownership.md` § Schema v1 Sunset.
 *
 * A heartbeat stamped more than {@link FUTURE_HEARTBEAT_TOLERANCE_MS} in the
 * future is NOT live either (#1494): `now - heartbeat` went negative, stayed
 * below every TTL, and such a lock — a hand edit, a clock stepped backwards —
 * held the repo until the wall clock caught up, a year for a year-ahead stamp.
 * Same rule as the orphan-reaper's throttle marker (#1487,
 * `orphan-reaper/scan-throttle.mjs` `shouldScanNow`), plus a tolerance: a
 * marker in the future only costs one extra scan, a lock misread as dead is
 * taken over while its owner still runs.
 *
 * @param {{ last_heartbeat: string, ttl_hours?: number }} lock
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isLockLive(lock, nowMs = Date.now()) {
  if (!lock || typeof lock !== 'object') return false;
  if (typeof lock.last_heartbeat !== 'string' || lock.last_heartbeat.length === 0) return false;
  const heartbeatMs = Date.parse(lock.last_heartbeat);
  if (Number.isNaN(heartbeatMs)) return false;
  if (heartbeatMs > nowMs + FUTURE_HEARTBEAT_TOLERANCE_MS) return false;
  const ttlHours = typeof lock.ttl_hours === 'number' ? lock.ttl_hours : DEFAULT_TTL_HOURS;
  if (!isValidLockTtlHours(ttlHours)) return false;
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
  // Shared writer (#1865): same `<dir>/.session.lock.tmp.<12 hex>` sibling tmp,
  // plus the win32 rename retry and tmp cleanup on failure. Envelope is a
  // superset of the old one (adds `code`).
  return writeJsonAtomicSync(lockFile, lock, { tmpPrefix: '.session.lock.tmp' });
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
 * Used by the no-existing-lock branch of {@link acquire} and by the
 * single-winner reclaim (`forceAcquire({ onlyIfNotLive: true })` →
 * `reclaimIfNotLive()`), which moves the old lock aside first and then needs
 * exactly this create-or-fail. All these operations hold the primary mutation
 * mutex (#2073). The overwrite paths (a plain `forceAcquire`, `updateHeartbeat()`)
 * keep using `writeLockAtomic` because they MUST replace an existing lock, not
 * fail on it.
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
 *   { ok: true, lock, exclusivityClass?, ownerProof }
 *       — lock created or restored from the caller's live reclaim tombstone.
 *         `ownerProof` reports the owner-proof rewrite that
 *         follows every successful lock write (#1541, see withOwnerProof()):
 *         `{ ok: true }` or `{ ok: false, reason }` — never thrown.
 *   { ok: false, reason: 'active', existingLock, ageHours, exclusivityClass? }
 *       — local lock held: its last_heartbeat is within ttl_hours. A readable
 *         live reclaim tombstone can supply `existingLock` if the primary is
 *         absent, corrupt or expired (#2141, #2145). `ageHours`
 *         is the age from `started_at` (null when unparseable). `existingLock`
 *         is null, `ageHours` null, only when a lost create race found the
 *         winner's lock already gone.
 *   { ok: false, reason: 'stale-heartbeat', existingLock, ageHours, heartbeatAgeMinutes, exclusivityClass? }
 *       — local lock stale: its last_heartbeat is older than ttl_hours. This is
 *         the ONLY stale reason (#1137). It replaced the `stale-pid-dead` /
 *         `stale-pid-alive` pair, which claimed a PID verdict the lock cannot
 *         support: the recorded `pid` is the ephemeral hook / `node -e`
 *         subprocess, dead within ~1s of genesis (measured 2026-08-23: 7 of 7
 *         recorded pids dead, INCLUDING the currently heartbeating session's
 *         own lock), so `stale-pid-alive` was unreachable same-host and every
 *         stale lock rendered as "confirmed dead" in the recovery AUQ.
 *   { ok: false, reason: 'corrupt', existingLock: null, exclusivityClass? }
 *       — a lock file is present but fails parseLock() (invalid JSON, or not
 *         the six-field lock shape), with no live reclaim tombstone.
 *         The SessionStart bootstrap reclaims it
 *         with one stderr WARN. Before 2026-10-02 this case answered 'active'
 *         with `existingLock: null` on every attempt and wedged the repo.
 *   { ok: false, reason: 'unreadable', existingLock: null, error, exclusivityClass? }
 *       — the lock path exists but cannot be read (EACCES, or a directory at
 *         the path: EISDIR). Nothing was written and the path is left as it
 *         is; the SessionStart bootstrap reports it (stderr WARN + a
 *         `orchestrator.session.lock.read_anomaly` event) instead of reclaiming
 *         it. Until #1494 this answered 'active' / existingLock:null silently.
 *   { ok: false, reason: 'missing-session-id' }
 *       — no usable `sessionId` given; NOTHING was written. Same reason string
 *         and same predicate as forceAcquire() (see its docblock for why an
 *         ownerless lock is worse than no lock). No `exclusivityClass`: the
 *         call never reached classification.
 *   { ok: false, reason: 'fs-error', error, exclusivityClass? }
 *       — filesystem failure
 *   { ok: false, reason: 'busy' }
 *       — session.lock.write or its .acquire guard stayed held for the bounded
 *         retry budget; no primary owner/liveness conclusion can be drawn
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
export function acquire(opts = {}) {
  if (!hasUsableSessionId(opts.sessionId)) return { ok: false, reason: 'missing-session-id' };
  return mutatePrimaryLock(opts.repoRoot, () => acquireGuarded(opts), PRIMARY_WRITE_RETRY_MS);
}

/** Caller holds the primary mutation mutex; also used by reclaim's fallback. */
function acquireGuarded({ sessionId, mode, ttlHours = DEFAULT_TTL_HOURS, repoRoot, activeSessions, semanticSessionId, quiet = false } = {}) {
  // -------------------------------------------------------------------------
  // Ownerless-lock guard. Measured 2026-09-11 in a tmp repoRoot:
  //   acquire({sessionId: undefined}) -> {ok:true}, lockfile written with NO
  //   `session_id` key at all; acquire({sessionId: ''}) -> {ok:true}, lockfile
  //   written with `"session_id": ""`. Both are the exact "present but owned by
  //   nobody" state forceAcquire()'s docblock below describes: every reader
  //   compares such a lock against its own id, finds no match, classifies it
  //   FOREIGN — and foreign is the classification that SKIPS enforcement.
  //   The guard lived only on forceAcquire(), the rare path (explicit
  //   stale-lock takeover); acquire() is the primary one. The production
  //   caller hooks/_lib/lock-bootstrap.mjs gates empty ids upstream, but the
  //   prose path skills/session-start/references/phase-1-2-session-lock.md
  //   calls acquire() straight from the coordinator LLM with no gate at all.
  // Placed FIRST, before classifyMode and before any fs work: nothing is
  // written. `exclusivityClass` is deliberately absent from this shape — the
  // caller's class is a property of a call that got far enough to be
  // classified, and this one did not.
  // -------------------------------------------------------------------------
  if (!hasUsableSessionId(sessionId)) {
    return { ok: false, reason: 'missing-session-id' };
  }

  // #1505.3: remove what a SIGKILLed writer or reclaimer left beside the lock.
  // Result-neutral and best-effort: it never reads or touches `session.lock`.
  try { sweepLockLeftovers({ repoRoot }); } catch { /* never blocks acquire */ }

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
    // both report identical active / stale-heartbeat reasons.
    const classifyExisting = (existing) => {
      // Heartbeat-first liveness (#744): isLockLive is the SOLE active gate.
      // A dead recorded PID must NOT veto a fresh last_heartbeat — the pid on
      // a session.lock is the ephemeral hook subprocess PID, not the semantic
      // session's own PID (Epic #583, W1-D1 + W1-D4 consensus). Likewise,
      // isTtlExpired measures age from started_at, which wrongly flags a
      // long-running-but-heartbeating session as expired. Both bugs together
      // produced the #744 incident: a live heartbeating session was
      // misclassified 'stale-pid-dead' mid-wave.
      if (isLockLive(existing)) {
        // ageHours is the figure the Phase-1.2 "active" prompt renders
        // ("started <ageHours>h ago"); it was missing from this shape, so the
        // prompt printed a value nothing had computed (#1494).
        return {
          ok: false,
          reason: 'active',
          existingLock: existing,
          ageHours: lockAgeHours(existing),
          exclusivityClass: callerClass,
        };
      }

      // Heartbeat expired — ONE stale reason, derived from the same signal the
      // active gate above used (#1137). The former two-way split asked
      // isPidAliveOnHost(existing.pid) and reported 'stale-pid-dead' /
      // 'stale-pid-alive'; that question has no answer the lock can give,
      // because `pid` is the short-lived writer subprocess, not the session.
      // Same-host it was therefore ~always 'dead' (7/7 measured, live sessions
      // included) and 'stale-pid-alive' was structurally unreachable. The
      // ageHours + heartbeatAgeMinutes fields carry the evidence instead, so a
      // recovery prompt can state the measured heartbeat age rather than a
      // liveness verdict.
      return {
        ok: false,
        reason: 'stale-heartbeat',
        existingLock: existing,
        ageHours: lockAgeHours(existing),
        heartbeatAgeMinutes: heartbeatAgeMinutes(existing),
        exclusivityClass: callerClass,
      };
    };

    // A file that is present but fails parseLock() — invalid JSON, or JSON
    // without the six-field lock shape — gets its OWN reason instead of
    // collapsing into the vanished-race branch below. It used to: readLock()
    // returned null, the create-or-fail hit EEXIST on the file still there,
    // the re-read was null again, and every attempt answered
    // `active` / `existingLock: null` — which the bootstrap cannot reclaim, so
    // one damaged file blocked every new session in the repo for good.
    // Primary writers normally publish a complete body via tmp+link or
    // tmp+rename. The #2141 exclusive write fallback can leave a partial
    // primary, with the live body still in the tombstone. Check that before
    // reporting a reclaimable 'corrupt' result. The caller decides what to
    // do with a corrupt primary (see the decision-deferred module header).
    // Ceiling (BV-004): a future writer emitting a body that fails
    // isLockShape() would be classified corrupt too. Revisit if the lock
    // schema ever changes a required field's type or name.
    const corrupt = () => ({ ok: false, reason: 'corrupt', existingLock: null, exclusivityClass: callerClass });

    // A lock path that exists but cannot be read — EACCES, or a DIRECTORY at
    // the path (EISDIR) — gets its own reason too (#1494, #599). It used to
    // fall through to the create-or-fail, hit EEXIST and answer
    // 'active' / existingLock:null, which nobody reports: the bootstrap
    // neither forced nor warned, and every session ran without a lock, with
    // no trace. Never reclaimed — what sits there was not written by a lock
    // writer, and a directory may hold content nobody here created (PSA-003).
    const unreadable = (error) => ({ ok: false, reason: 'unreadable', existingLock: null, error, exclusivityClass: callerClass });

    const existing = readLockDetailed({ repoRoot });

    if (existing.status === 'ok' && isLockLive(existing.lock)) return classifyExisting(existing.lock);
    if (existing.status === 'unreadable') return unreadable(existing.error);
    const tombstone = readLiveReclaimTombstone(lockFile);
    if (tombstone !== null) {
      if (tombstone.lock.session_id !== sessionId) {
        return classifyExisting(tombstone.lock);
      }
      const lock = refreshTombstoneLock(tombstone.lock, mode, ttlHours, semanticSessionId);
      const restored = restoreOwnedReclaimTombstone(tombstone, lock, lockFile, repoRoot, existing);
      if (restored.ok) return withOwnerProof({ ...restored, exclusivityClass: callerClass }, repoRoot);
      if (restored.reason === 'active') return classifyExisting(restored.existingLock);
      return { ...restored, exclusivityClass: callerClass };
    }
    if (existing.status === 'ok') return classifyExisting(existing.lock);
    if (existing.status === 'corrupt') return corrupt();
    // 'absent' → create below.

    // No existing lock — create one with a TOCTOU-safe create-or-fail (#590).
    // Two concurrent SessionStart hooks can both reach this branch having each
    // observed readLock() === null; linkSync guarantees exactly one wins.
    const lock = buildLock({ sessionId, mode, ttlHours, semanticSessionId });
    const createResult = createSessionLockExclusive(lockFile, lock);

    if (createResult.ok) {
      return withOwnerProof({ ok: true, lock, exclusivityClass: callerClass }, repoRoot);
    }
    if (createResult.reason === 'fs-error') {
      return { ok: false, reason: 'fs-error', error: createResult.error, exclusivityClass: callerClass };
    }

    // reason === 'exists' — we lost the create race. Re-read the now-present
    // lock and classify it exactly as if we had seen it on the up-front check.
    const raced = readLockDetailed({ repoRoot });
    if (raced.status === 'ok') return classifyExisting(raced.lock);
    if (raced.status === 'corrupt') return corrupt();
    if (raced.status === 'unreadable') return unreadable(raced.error);
    // The EEXIST winner's lock vanished before we could re-read it (ENOENT).
    // Defensive fallback: report 'active' so the caller defers rather than
    // racing again — mirrors tryAcquireStateLock's vanish-race handling (a
    // lost-then-vanished race resolves conservatively).
    return { ok: false, reason: 'active', existingLock: null, ageHours: null, exclusivityClass: callerClass };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message, exclusivityClass: callerClass };
  }
}

/**
 * Force-acquire the lock, unconditionally replacing any existing lock.
 * Call only after the user has explicitly authorised stale-lock takeover.
 *
 * Returns:
 *   { ok: true, lock, replacedLock?, ownerProof }   — lock written (replacedLock present if one was overwritten;
 *                                                     ownerProof as on acquire(), #1541)
 *   { ok: false, reason: 'missing-session-id' }     — no usable `sessionId` given; NOTHING was written
 *   { ok: false, reason: 'fs-error', ... }          — filesystem failure
 *   { ok: false, reason: 'busy' }                   — mutation mutex held; retry later
 *
 * Optional expectedLock binds an automatic live refresh to the observed
 * session_id + pid/host/started_at generation; mismatch returns active without
 * writing. Omit it only for an explicitly authorized unconditional force-take.
 *
 * The `missing-session-id` guard is not cosmetic. `buildLock` assigns
 * `session_id: sessionId` verbatim, and `JSON.stringify` DROPS an `undefined`
 * value — so a `forceAcquire()` without a sessionId used to write a lock file
 * carrying no `session_id` key at all. Such a lock is present but owned by
 * nobody: every reader compares it against its own id, finds no match, and
 * classifies it as FOREIGN — and foreign is precisely the classification that
 * skips enforcement. The same failure class is why the wave scope manifest
 * forbids `"session_id": ""` and requires the key be omitted instead.
 *
 * The result SHAPE (not a throw) is deliberate and matches the callers: the
 * only production call site, `hooks/_lib/lock-bootstrap.mjs`, branches on
 * `acquireResult.ok !== true` and bails non-blocking; a throw there would be
 * swallowed by its `catch` and reported as the same `null`, i.e. it would add
 * no information while breaking the direct `forceAcquire()` calls documented in
 * `skills/session-start/references/phase-1-2-session-lock.md`.
 *
 * `onlyIfNotLive: true` (#1494) turns the unconditional overwrite into a
 * single-winner takeover of a stale or corrupt lock: a lock that is live when
 * it is moved aside is put back, and every lost race returns a fresh
 * `acquire()` result instead of `ok: true` — see `reclaimIfNotLive()`. The
 * SessionStart bootstrap passes it for its `stale-heartbeat` / `corrupt`
 * reclaims; the operator-approved force-take of a LIVE lock (Phase 1.2) omits it.
 *
 * @param {{ sessionId: string, mode: string, ttlHours?: number, repoRoot?: string, semanticSessionId?: string, onlyIfNotLive?: boolean, expectedLock?: object }} args
 */
/**
 * Rewrite `.orchestrator/runtime/lock-owner-proof.json` for a lock this module
 * has JUST written, and report the outcome on the result (#1541).
 *
 * Invariant: proof = current lock. Before #1541 only the SessionStart bootstrap
 * wrote the proof, so a lock taken on the prose path (Phase 1.2 `acquire()`
 * after a `/close` in the same conversation, or a force-take / reclaim) left
 * the PREVIOUS lock's proof on disk — and `release()` answered
 * `proof-mismatch` for the session's own lock at its next `/close`.
 *
 * Called only on the `ok: true` paths, directly after the lock write, with the
 * same `repoRoot` the lock path was resolved from (both fall back to
 * `process.cwd()`), so the proof lands beside the lock it describes. The
 * bootstrap's own later writeOwnerProof() on the enriched lock yields the same
 * triple (enrichment never touches pid/host/started_at) — idempotent.
 *
 * Never throws and never turns `ok: true` into a failure: the lock IS held, and
 * a missing proof only degrades `/close` to the session_id-only release.
 *
 * The primary mutation mutex encloses lock AND proof writes, including
 * bootstrap enrichment, so conforming force-takes cannot interleave proofs.
 * BV-004: legacy writers which ignore the mutex may still leave a stale proof;
 * a mismatched proof refuses release, never grants it. Revisit when migrating
 * legacy writers or after a release-proof-mismatch following reaper activity.
 *
 * Known limit: the proof is one file per repo and identifies the process that
 * last wrote the lock, never the conversation. Twins sharing one raw
 * session_id (two terminals resuming the same conversation) are therefore
 * indistinguishable to it — either can release after the other force-took.
 *
 * @param {{ ok: true, lock: object }} result
 * @param {string|undefined} repoRoot
 * @returns {object} the same result object, with `ownerProof` set
 */
function withOwnerProof(result, repoRoot) {
  const w = writeOwnerProof({ repoRoot, lock: result.lock });
  result.ownerProof = w.ok ? { ok: true } : { ok: false, reason: w.reason };
  // #1651: the session holds a lock again, so its earlier "released on
  // purpose" marker no longer describes it. This is the one junction every
  // ok:true write of acquire()/forceAcquire() passes. Never throws.
  clearReleaseMarker({ repoRoot, sessionId: result.lock?.session_id });
  return result;
}

/**
 * A `sessionId` is usable only when it is a non-blank string. ONE predicate,
 * shared by acquire() and forceAcquire(), so the two entry points cannot drift
 * apart again — they did: the guard existed on forceAcquire() alone until
 * 2026-09-11, leaving the primary path able to write an ownerless lock.
 *
 * @param {unknown} sessionId
 * @returns {boolean}
 */
function hasUsableSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim().length > 0;
}

export function forceAcquire(opts = {}) {
  if (!hasUsableSessionId(opts.sessionId)) return { ok: false, reason: 'missing-session-id' };
  return mutatePrimaryLock(opts.repoRoot, () => forceAcquireGuarded(opts), PRIMARY_WRITE_RETRY_MS);
}

/** Caller holds the primary mutation mutex. */
function forceAcquireGuarded({ sessionId, mode, ttlHours = DEFAULT_TTL_HOURS, repoRoot, semanticSessionId, onlyIfNotLive = false, expectedLock } = {}) {
  if (!hasUsableSessionId(sessionId)) {
    return { ok: false, reason: 'missing-session-id' };
  }
  if (onlyIfNotLive === true) {
    return reclaimIfNotLive({ sessionId, mode, ttlHours, repoRoot, semanticSessionId });
  }
  try {
    const lockFile = lockPathFor(repoRoot);
    const primary = readLockDetailed({ repoRoot });
    const canRestore = primary.status === 'absent' || primary.status === 'corrupt';
    const tombstone = expectedLock !== undefined && canRestore
      ? readLiveReclaimTombstone(lockFile)
      : null;
    const replacedLock = primary.lock ?? tombstone?.lock ?? null;
    // Bootstrap's live same-session/predecessor decision was made before an
    // await. Require that exact owner generation under the mutex; explicit
    // operator force-takes omit expectedLock and stay unconditional.
    if (expectedLock !== undefined && (
      !isSameLockGeneration(expectedLock, replacedLock) ||
      (tombstone !== null && replacedLock.session_id !== sessionId)
    )) {
      return { ok: false, reason: 'active', existingLock: replacedLock };
    }
    const lock = tombstone === null
      ? buildLock({ sessionId, mode, ttlHours, semanticSessionId })
      : refreshTombstoneLock(tombstone.lock, mode, ttlHours, semanticSessionId);
    const writeResult = tombstone === null
      ? writeLockAtomic(lockFile, lock)
      : restoreOwnedReclaimTombstone(tombstone, lock, lockFile, repoRoot, primary);
    if (!writeResult.ok) return writeResult;

    const result = { ok: true, lock: writeResult.lock ?? lock };
    if (replacedLock !== null) result.replacedLock = replacedLock;
    return withOwnerProof(result, repoRoot);
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

/**
 * Unique tombstone name beside the lock — matches {@link LOCK_LEFTOVER_RE}, so a
 * tombstone a killed process leaves behind is swept by `sweepLockLeftovers()`.
 * Used by stale reclaim and repair of a corrupt primary.
 * @param {string} lockFile
 * @returns {string}
 */
function tombstonePathFor(lockFile) {
  return path.join(path.dirname(lockFile), `.session.lock.reclaim.${crypto.randomBytes(8).toString('hex')}`);
}

/**
 * Find a live owner whose primary may have been lost during reclaim (#2141).
 * For mutation decisions, call under the primary mutation mutex. Use the same
 * exact names and regular-file rule as sweepLockLeftovers(), without its age floor.
 */
function readLiveReclaimTombstone(lockFile) {
  return liveReclaimTombstones(lockFile).next().value ?? null;
}

function* liveReclaimTombstones(lockFile) {
  const dir = path.dirname(lockFile);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('.session.lock.reclaim.') ||
        !LOCK_LEFTOVER_RE.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lock = parseLock(raw);
    if (isLockLive(lock)) yield { file, lock };
  }
}

/** Publish a restored primary under .write. Readers can see a partial body during wx. */
function writeReclaimPrimaryExclusive(lockFile, raw) {
  try {
    fs.writeFileSync(lockFile, raw, { flag: 'wx' });
    return { ok: true };
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: false, reason: 'exists' };
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

function isSameLockGeneration(expected, actual) {
  return actual?.session_id === expected?.session_id &&
    isLockOwnedByProof(actual, buildLockOwnerProof(expected));
}

/**
 * Move the observed corrupt or expired primary aside under .write before
 * create-or-fail. Recheck the displaced file: a legacy writer may have
 * replaced or revived it. Link it back only if the primary path is empty.
 */
function retirePrimaryForRestore(lockFile, observed) {
  const displaced = tombstonePathFor(lockFile);
  try {
    if (!fs.lstatSync(lockFile).isFile()) {
      return { ok: false, reason: 'fs-error', error: 'Session lock is not a regular file' };
    }
    // direct-rename:ok move to a unique tombstone before revalidation, never a write
    fs.renameSync(lockFile, displaced);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true };
    throw err;
  }
  const raw = fs.lstatSync(displaced).isFile() ? fs.readFileSync(displaced, 'utf8') : null;
  const moved = observed.status === 'ok' && raw !== null ? parseLock(raw) : null;
  const canRetire = observed.status === 'corrupt'
    ? raw === observed.raw
    : isSameLockGeneration(observed.lock, moved) && !isLockLive(moved);
  if (canRetire) {
    try { fs.unlinkSync(displaced); } catch { /* safe for the leftover sweep */ }
    return { ok: true };
  }
  try {
    fs.linkSync(displaced, lockFile);
    // Keep the displaced file for the sweep or the restored owner's release.
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return { ok: false, reason: 'exists' };
}

/** The caller has checked ownership under .write and supplied the refreshed lock. */
function restoreOwnedReclaimTombstone(tombstone, lock, lockFile, repoRoot, observed) {
  const ready = observed.status === 'absent' ? { ok: true } : retirePrimaryForRestore(lockFile, observed);
  const written = ready.ok
    ? writeReclaimPrimaryExclusive(lockFile, JSON.stringify(lock, null, 2) + '\n')
    : ready;
  if (written.reason === 'fs-error') return written;

  const primary = readLock({ repoRoot });
  if (primary === null) {
    return { ok: false, reason: 'fs-error', error: 'Could not verify restored session lock' };
  }
  if (!written.ok || !isSameLockGeneration(lock, primary)) {
    return { ok: false, reason: 'active', existingLock: primary };
  }
  try {
    // A name from readdir of the lock directory, never caller input.
    const tombFile = tombstone.file;
    if (fs.lstatSync(tombFile).isFile() &&
        isSameLockGeneration(tombstone.lock, parseLock(fs.readFileSync(tombFile, 'utf8')))) {
      fs.unlinkSync(tombFile);
    }
  } catch { /* the owner can clean it on release */ }
  return { ok: true, lock: primary };
}

/**
 * Put an unreadable tombstone back at the lock path (a directory cannot be
 * hard-linked, and renaming a directory never replaces a file). If the path is
 * taken by then, it stays under the tombstone name.
 * @param {string} tomb
 * @param {string} lockFile
 * @returns {boolean} `true` when the tombstone name must be KEPT (not unlinked).
 */
function restoreUnjudgeableTombstone(tomb, lockFile) {
  let keepTomb = true;
  try {
    // Kept raw (#1865): best-effort put-back of a directory, never a write.
    // direct-rename:ok best-effort put-back of a directory, never a write
    if (fs.lstatSync(tomb).isDirectory()) fs.renameSync(tomb, lockFile);
    else { fs.linkSync(tomb, lockFile); keepTomb = false; }
  } catch { /* stays at the tombstone name */ }
  return keepTomb;
}

/**
 * Single-winner takeover of a stale or corrupt lock — `forceAcquire({
 * onlyIfNotLive: true })` (#1494).
 *
 * Under the primary mutation mutex, liveness is checked BEFORE any move.
 * A stale or corrupt regular lock is moved to a unique tombstone and judged
 * there, then replaced create-or-fail. Missing, unreadable or LIVE primaries
 * are classified by acquireGuarded() without moving them. Fallbacks stay in
 * the same critical section instead of recursively acquiring the mutex.
 *
 * BV-004: read-only observers can briefly see an absent stale/corrupt primary
 * between its move and create; conforming writers cannot enter that window.
 * A killed reclaimer leaves an abandoned mutex and the old stale tombstone;
 * .write can be recovered after its writer dies and the two-second floor;
 * .write.acquire requires quiescing writers as documented by mutatePrimaryLock.
 * Legacy writers/reaper ignore the mutex and can still interfere with the
 * move/link-back fallback. Revisit on mixed-version starts or reaper activity;
 * neither is claimed safe by #2073's migrated protocol.
 *
 * @param {{ sessionId: string, mode: string, ttlHours: number, repoRoot?: string, semanticSessionId?: string }} args
 * @returns {object} forceAcquire()'s `{ ok: true, lock, replacedLock? }` or
 *   `fs-error` shape, or — on a lost race — the result of a fresh `acquire()`.
 */
function reclaimIfNotLive({ sessionId, mode, ttlHours, repoRoot, semanticSessionId }) {
  const lockFile = lockPathFor(repoRoot);
  const reacquire = () => acquireGuarded({ sessionId, mode, ttlHours, repoRoot, semanticSessionId, quiet: true });
  // Check liveness under the mutex before any move: a heartbeat may have
  // revived this lock since bootstrap's earlier stale decision. A conforming
  // reclaimer must never put a fresh LIVE primary into a tombstone. A corrupt
  // primary can be the partial result of a failed #2141 restore.
  const current = readLockDetailed({ repoRoot });
  if (current.status === 'absent' || current.status === 'unreadable' ||
      (current.status === 'ok' && isLockLive(current.lock)) ||
      readLiveReclaimTombstone(lockFile) !== null) return reacquire();
  const tomb = tombstonePathFor(lockFile);

  try {
    // Kept raw (#1865): a tombstone MOVE of a stale/corrupt lock, not a tmp+rename write;
    // ENOENT means "lost the race" and must not be retried or masked.
    // direct-rename:ok tombstone move of a stale/corrupt lock, not a tmp+rename write
    fs.renameSync(lockFile, tomb);
  } catch (err) {
    if (err && err.code === 'ENOENT') return reacquire();
    return { ok: false, reason: 'fs-error', error: err.message };
  }

  let keepTomb = false;
  try {
    let raw;
    try {
      raw = fs.readFileSync(tomb);
    } catch {
      // Unjudgeable — something unreadable replaced the stale file after
      // acquire() read it. Not ours to drop: put it back.
      keepTomb = restoreUnjudgeableTombstone(tomb, lockFile);
      return reacquire();
    }

    const moved = parseLock(raw.toString('utf8'));
    if (moved !== null && isLockLive(moved)) {
      keepTomb = true;
      let deferredRestore = false;
      try {
        fs.linkSync(tomb, lockFile);
      } catch (err) {
        // EEXIST can outlive the successor that caused it. Try wx if the
        // primary cannot be read as a lock, just as after other relink errors.
        if (err.code !== 'EEXIST' || readLock({ repoRoot }) === null) {
          const restored = writeReclaimPrimaryExclusive(lockFile, raw);
          if (restored.reason === 'fs-error') return restored;
        } else {
          deferredRestore = true;
        }
      }
      let result = reacquire();
      let primary = readLock({ repoRoot });
      // A successor seen after EEXIST can still disappear during classification.
      if (deferredRestore && primary === null) {
        const restored = writeReclaimPrimaryExclusive(lockFile, raw);
        if (restored.reason === 'fs-error') return restored;
        result = reacquire();
        primary = readLock({ repoRoot });
      }
      keepTomb = !(isSameLockGeneration(moved, primary) || isLockLive(primary));
      return result;
    }

    const lock = buildLock({ sessionId, mode, ttlHours, semanticSessionId });
    const created = createSessionLockExclusive(lockFile, lock);
    if (created.ok) {
      const result = { ok: true, lock };
      if (moved !== null) result.replacedLock = moved;
      return withOwnerProof(result, repoRoot);
    }
    if (created.reason === 'exists') return reacquire();
    return created;
  } finally {
    if (!keepTomb) {
      try { fs.unlinkSync(tomb); } catch { /* best-effort */ }
    }
  }
}

/**
 * Remove the lock manager's own leftovers beside `session.lock` (#1505.3) —
 * files named exactly like {@link LOCK_LEFTOVER_RE}, regular files only (lstat:
 * a symlink, directory or anything else is never followed nor removed), last
 * touched more than {@link LOCK_LEFTOVER_MIN_AGE_MS} ago. A tombstone is
 * removed only on the decision its killed reclaimer would have taken itself:
 * readable and not a live lock. An unreadable one is kept, as
 * `reclaimIfNotLive()` keeps it. Unlinking a tombstone removes only that NAME —
 * when it is still a hard link to the primary lock's inode (killed between
 * link-back and unlink), `session.lock` keeps its content.
 *
 * The `.write` mutex and its exact tmp siblings instead require a readable
 * same-host dead-PID body and mtime >=2s; age alone never suffices. Mutex
 * recovery goes through file-lock's .acquire, with the age rechecked there,
 * so a young successor and the currently held mutation guard are kept.
 * `.write.acquire` itself is NEVER removed, whatever its owner or age.
 *
 * Never throws; a file that vanished or cannot be removed is skipped.
 *
 * @param {{ repoRoot?: string, nowMs?: number }} [opts]
 * @returns {{ removed: string[] }} basenames removed
 */
export function sweepLockLeftovers({ repoRoot, nowMs = Date.now() } = {}) {
  const removed = [];
  let dir;
  let names;
  try {
    dir = path.dirname(lockPathFor(repoRoot));
    names = fs.readdirSync(dir);
  } catch {
    return { removed };
  }
  for (const name of names) {
    if (!LOCK_LEFTOVER_RE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile()) continue;
      if (/^\.?session\.lock\.write\.acquire$/.test(name)) continue;
      const writeMutex = /^\.?session\.lock\.write$/.test(name);
      if (writeMutex || name.startsWith('.session.lock.write.tmp.')) {
        if (!(nowMs - st.mtimeMs >= PRIMARY_WRITE_MIN_AGE_MS)) continue;
        let body;
        try { body = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
        if (!body || !Number.isSafeInteger(body.pid) || body.pid <= 0 || body.pid > 0x7fffffff ||
            !hostnamesMatch(lockHostCandidate(body), os.hostname()) || isPidAliveOnHost(body.pid)) continue;
        if (writeMutex) {
          const recovered = tryAcquireFileLock(full, {
            staleCheck: 'pid', minStaleAgeMs: PRIMARY_WRITE_MIN_AGE_MS,
            tmpPrefix: '.session.lock.write.tmp',
          });
          if (!recovered.acquired) continue;
          // The recovered body now names this live PID, so a conforming
          // writer cannot replace it before this immediate cleanup.
          if (!releaseFileLock(full, { ownerGuard: false }).ok) continue;
        } else {
          // Tmp names are unique and immutable once written. Check identity
          // again so an observed replacement is never unlinked by the sweep.
          const current = fs.lstatSync(full);
          if (!current.isFile() || current.ino !== st.ino || current.dev !== st.dev ||
              current.mtimeMs !== st.mtimeMs) continue;
          fs.unlinkSync(full);
        }
        removed.push(name);
        continue;
      }
      // A future mtime/ctime (clock stepped back) yields a negative age: kept.
      if (!(nowMs - Math.max(st.mtimeMs, st.ctimeMs) > LOCK_LEFTOVER_MIN_AGE_MS)) continue;
      if (name.startsWith('.session.lock.reclaim.')) {
        let raw;
        try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const moved = parseLock(raw);
        if (moved !== null && isLockLive(moved, nowMs)) continue;
      }
      fs.unlinkSync(full);
      removed.push(name);
    } catch { /* vanished or unremovable — best-effort */ }
  }
  return { removed };
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
 * Callers: `acquire()` / `forceAcquire()` on every `ok: true` lock write
 * (#1541, via withOwnerProof()), `updateHeartbeat()` after a tombstone
 * restore, and `bootstrapLock()` (hooks/_lib/lock-bootstrap.mjs) again
 * immediately after its enriched-lock write. In every case the `lock`
 * argument describes the on-disk lock, so the proof it yields will verify
 * via `isLockOwnedByProof()` against any later re-read of that same lock.
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
 * Absolute path of the release marker for `sessionId`, or null when the id is
 * not a safe single file-name component (#1651). The id comes from a lock file
 * or a CLI flag, so it is validated before it reaches a path: no separator, no
 * `.`/`..`, at most 128 chars of `[A-Za-z0-9._-]`.
 *
 * @param {string|undefined} repoRoot
 * @param {unknown} sessionId
 * @returns {string|null}
 */
function releaseMarkerPath(repoRoot, sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  return path.join(repoRoot ?? process.cwd(), RELEASE_MARKER_RELDIR, `${sessionId}.json`);
}

/**
 * Record that `sessionId` deliberately released its own lock (#1651), so the
 * SessionStart bootstrap does not re-create it on a `compact` or `resume` of
 * that same raw session — a headless run may be using the slot. Atomic
 * (tmp+rename). Never throws.
 *
 * Ceiling (BV-004): markers are never pruned — one small file per released
 * session id. Revisit if `.orchestrator/runtime/lock-released/` grows past a
 * few hundred entries.
 *
 * `reason` (optional, #1747) records why the lock was given back; the
 * SessionStart bootstrap writes `'lead-yield'` and honours such a marker only
 * while a fleet lead's lease is active. Absent = an explicit release.
 *
 * @param {{ repoRoot?: string, sessionId: string, reason?: string }} args
 * @returns {{ ok: true, path: string } | { ok: false, reason: string, error?: string }}
 */
export function writeReleaseMarker({ repoRoot, sessionId, reason } = {}) {
  try {
    const file = releaseMarkerPath(repoRoot, sessionId);
    if (file === null) return { ok: false, reason: 'unsafe-session-id' };
    const w = writeJsonAtomicSync(
      file,
      {
        schema_version: 1,
        session_id: sessionId,
        released_at: nowIso(),
        host: stableHostname(),
        ...(typeof reason === 'string' ? { reason } : {}),
      },
      { tmpPrefix: '.lock-released.tmp' },
    );
    if (!w.ok) return { ok: false, reason: 'fs-error', error: w.error };
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }
}

/**
 * True when a release marker for `sessionId` exists (#1651). Never throws; an
 * unsafe id or any fs error reads as "no marker", i.e. the pre-#1651 behaviour.
 *
 * @param {{ repoRoot?: string, sessionId: string }} args
 * @returns {boolean}
 */
export function hasReleaseMarker({ repoRoot, sessionId } = {}) {
  try {
    const file = releaseMarkerPath(repoRoot, sessionId);
    return file !== null && fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The release marker body for `sessionId`, or null when it is absent, unsafe,
 * not a regular file or not a JSON object (#1747). Never throws. Existence
 * alone is {@link hasReleaseMarker}; this reader only adds the `reason`.
 *
 * @param {{ repoRoot?: string, sessionId: string }} args
 * @returns {{ reason?: unknown } & Record<string, unknown> | null}
 */
export function readReleaseMarker({ repoRoot, sessionId } = {}) {
  try {
    const file = releaseMarkerPath(repoRoot, sessionId);
    if (file === null || !fs.lstatSync(file).isFile()) return null;
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Remove the release marker for `sessionId` (#1651). Best-effort, never throws.
 *
 * @param {{ repoRoot?: string, sessionId: string }} args
 * @returns {void}
 */
export function clearReleaseMarker({ repoRoot, sessionId } = {}) {
  try {
    const file = releaseMarkerPath(repoRoot, sessionId);
    if (file !== null) fs.rmSync(file, { force: true });
  } catch { /* best-effort */ }
}

/**
 * Release the primary and live reclaim tombstones owned by the caller.
 * When a proof is supplied, only that generation (raw ID, PID, host and start
 * time) is eligible. An omitted or null proof retains raw-ID-only ownership.
 *
 * Tombstones are removed before the primary under .write, so a failed cleanup
 * can be retried while the owner still holds its primary. Post-delete
 * verification retries the primary unlink at most once, only for the same
 * generation, and checks for any remaining eligible live tombstones.
 *
 * @param {{ sessionId: string, repoRoot?: string, proof?: { pid: number, host: string, startedAt: string }|null }} args
 * @returns {{ ok: true, deleted: boolean, reason?: string, verified?: boolean }
 *   | { ok: false, reason: 'busy' }
 *   | { ok: false, reason: 'fs-error', error: string }}
 */
export function release(opts = {}) {
  // A read-only rejection avoids taking .write when there is nothing to release.
  try {
    const observed = readReleaseTargets(opts);
    if (!observed.primary && observed.tombstones.length === 0) {
      return { ok: true, deleted: false, reason: observed.reason };
    }
    return mutatePrimaryLock(opts.repoRoot, () => releaseGuarded(opts), PRIMARY_WRITE_RETRY_MS);
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err.message };
  }
}

function matchesReleaseOwner(lock, sessionId, proof) {
  return lock !== null && lock.session_id === sessionId &&
    (proof === undefined || proof === null || isLockOwnedByProof(lock, proof));
}

function readReleaseTargets({ sessionId, repoRoot, proof }) {
  const lock = readLock({ repoRoot });
  const primary = matchesReleaseOwner(lock, sessionId, proof) ? lock : null;
  const tombstones = [];
  let ownIdPresent = lock?.session_id === sessionId;
  for (const tombstone of liveReclaimTombstones(lockPathFor(repoRoot))) {
    if (tombstone.lock.session_id !== sessionId) continue;
    ownIdPresent = true;
    if (matchesReleaseOwner(tombstone.lock, sessionId, proof)) tombstones.push(tombstone.file);
  }
  const reason = ownIdPresent ? 'proof-mismatch' : (lock === null ? 'no-lock' : 'session-mismatch');
  return { primary, tombstones, reason };
}

/** Caller holds the primary mutation mutex. */
function releaseGuarded({ sessionId, repoRoot, proof }) {
  const lockFile = lockPathFor(repoRoot);
  const { primary, tombstones, reason } = readReleaseTargets({ sessionId, repoRoot, proof });
  if (primary === null && tombstones.length === 0) return { ok: true, deleted: false, reason };

  let deleted = false;
  for (const file of tombstones) {
    try {
      fs.unlinkSync(file);
      deleted = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  // If tombstone cleanup took place, double-check the primary again before
  // unlinking it. Legacy writers do not hold our .write mutex.
  const deletePrimary = primary !== null &&
    (tombstones.length === 0 || isSameLockGeneration(primary, readLock({ repoRoot })));
  if (deletePrimary) {
    fs.unlinkSync(lockFile);
    deleted = true;
  }
  let after = readLock({ repoRoot });
  if (deletePrimary && isSameLockGeneration(primary, after)) {
    try { fs.unlinkSync(lockFile); } catch { /* verify after the bounded retry */ }
    after = readLock({ repoRoot });
  }

  const verified = !matchesReleaseOwner(after, sessionId, proof) &&
    !liveReclaimTombstones(lockFile).some(({ lock }) => matchesReleaseOwner(lock, sessionId, proof));
  return { ok: true, deleted, verified };
}

/**
 * Refresh the owner's heartbeat under the shared primary mutation mutex.
 * Primary refresh and revival use tmp+rename after their owner check inside
 * the mutex. A live owned reclaim tombstone can restore a missing, corrupt
 * or expired primary. Returns false on contention, lack of a recoverable
 * owner record, or I/O failure. Never throws.
 *
 * #2073's former gaps among protocol participants:
 * (a) force-take cannot interleave with a heartbeat's read/write;
 * (b) revival never moves a lock out of the primary path;
 * (c) a killed reviver leaves the old primary intact (atomic tmp+rename);
 * (d) expiry crossing the TTL boundary cannot enable a concurrent takeover;
 * (e) hard-link errors return fs-error without changing the primary: this is
 * an I/O boundary, not a closed concurrency claim on no-hardlink filesystems.
 * On filesystems without hard links every mutation fails with fs-error.
 * A crash can leave .write.acquire behind: see mutatePrimaryLock's recovery
 * boundary. Legacy/mixed-version writers and automatically invoked
 * lock-reaper remain outside this guarantee; concurrent reaper execution is
 * not blocked. Revisit that migration before claiming checkout-wide safety.
 *
 * Stale-guard path: a surviving `.write.acquire` (see mutatePrimaryLock, B6)
 * makes every heartbeat return false. All callers discard the result, so
 * `last_heartbeat` freezes silently while the owner lives; once the TTL
 * passes, lock-reaper.mjs (unguarded) can archive the live owner's lock.
 * No double ownership arises: every later acquire reports `busy`. #2127
 * covers the warning/event on this path and the reaper guard.
 *
 * @param {{ repoRoot?: string, sessionId: string }} opts
 * @returns {boolean}
 */
export function updateHeartbeat({ repoRoot, sessionId } = {}) {
  if (!hasUsableSessionId(sessionId)) return false;
  const lockFile = lockPathFor(repoRoot);
  const readTarget = () => {
    const primary = readLockDetailed({ repoRoot });
    if (primary.status === 'unreadable') return null;
    const tombstone = isLockLive(primary.lock) ? null : readLiveReclaimTombstone(lockFile);
    const lock = tombstone?.lock ?? primary.lock;
    return lock?.session_id === sessionId ? { lock, primary, tombstone } : null;
  };
  try {
    // Avoid creating a guard or directory when no owned record is recoverable.
    const observed = readTarget();
    if (observed === null) return false;
    return mutatePrimaryLock(repoRoot, () => {
      const current = readTarget();
      if (current === null) return false;
      if ((observed.tombstone || current.tombstone) && !isSameLockGeneration(observed.lock, current.lock)) {
        return false;
      }
      const lock = { ...current.lock, last_heartbeat: nowIso() };
      if (current.tombstone === null) return writeLockAtomic(lockFile, lock).ok;
      const restored = restoreOwnedReclaimTombstone(current.tombstone, lock, lockFile, repoRoot, current.primary);
      if (restored.ok) writeOwnerProof({ repoRoot, lock: restored.lock });
      return restored.ok;
    }) === true;
  } catch {
    return false;
  }
}

/**
 * Enrich the owner's primary lock and persist its proof in the same mutation
 * pass (#2073). The bootstrap must not carry an earlier read across an await
 * and then overwrite a successor. No callback is exposed to callers, so this
 * helper cannot recursively acquire the mutex or run asynchronous work in it.
 *
 * @param {{ repoRoot?: string, sessionId: string, semanticSessionId?: string, claudePid?: number }} opts
 * @returns {object} success carries the actual written lock and proof result
 */
export function enrichOwnedSessionLock({ repoRoot, sessionId, semanticSessionId, claudePid } = {}) {
  if (!hasUsableSessionId(sessionId)) return { ok: false, reason: 'missing-session-id' };
  return mutatePrimaryLock(repoRoot, () => {
    const baseLock = readLock({ repoRoot });
    if (baseLock === null) return { ok: false, reason: 'no-lock' };
    if (baseLock.session_id !== sessionId) return { ok: false, reason: 'session-mismatch' };
    const lock = {
      ...baseLock,
      // Keep a concurrent prior heartbeat; enrichment must never age it back
      // to started_at after the session has already refreshed its lease.
      last_heartbeat: baseLock.last_heartbeat ?? baseLock.started_at,
      semantic_session_id: typeof semanticSessionId === 'string' && semanticSessionId.length > 0
        ? semanticSessionId : baseLock.session_id,
      ...(typeof claudePid === 'number' ? { claude_pid: claudePid } : {}),
    };
    const written = writeLockAtomic(lockPathFor(repoRoot), lock);
    if (!written.ok) return written;
    const proof = writeOwnerProof({ repoRoot, lock });
    return { ok: true, lock, ownerProof: proof };
  });
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
 *   heartbeatAgeMinutes: number|null,
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
      heartbeatAgeMinutes: null,
      host: null,
      sameHost: false,
      isLive: false,
    };
  }

  const ageHours = lockAgeHours(lock);
  const ttlExpired = isTtlExpired(lock);
  // #1072: alias-aware, not a raw os.hostname() comparison — this machine's
  // hostname flips spelling, which made `sameHost` false for its own lock.
  const sameHost = hostnamesMatch(lockHostCandidate(lock), os.hostname());
  // NO `pidAlive` FIELD (#1151). #1137 kept it as an always-null shape stub;
  // nothing ever read it — measured @ f0766e1, zero production readers
  // repo-wide. Probing isPidAliveOnHost(lock.pid) answered a question about the
  // ephemeral writer subprocess, not the session: 2026-08-23, 7 of 7 recorded
  // pids were dead, including the lock of the session that was heartbeating at
  // that very moment, so a `false` here read as "the session is dead" and was
  // wrong every time. `isLive` is the verdict and `heartbeatAgeMinutes` the
  // magnitude behind it. `isPidAliveOnHost` itself stays exported —
  // file-lock.mjs and lock-reaper.mjs are legitimate callers, where the pid IS
  // the process being asked about.
  // Heartbeat-based liveness (#744) — the SAME check acquire()'s
  // classifyExisting uses as its sole active gate, surfaced here so callers of
  // checkStale() (recovery-flow diagnostics) can observe it directly.
  const isLive = isLockLive(lock);

  return {
    exists: true,
    lock,
    ageHours,
    ttlExpired,
    heartbeatAgeMinutes: heartbeatAgeMinutes(lock),
    host: lock.host,
    sameHost,
    isLive,
  };
}
