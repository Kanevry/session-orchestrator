/**
 * locks/state-md-lock.mjs — STATE.md write-lock protocol
 * (PRD 2026-05-22 § 4 — Pattern 1, issue #518).
 *
 * Split out of session-lock.mjs in #630 (A1 barrel-preserving split). The
 * symbols below are re-exported UNCHANGED from session-lock.mjs so the original
 * import surface is preserved for all 17 importers.
 *
 * Mechanical enforcement of PSA-004 for STATE.md writes. Whereas the
 * session-lock (session-lock.mjs) guards "this working-copy is held by one
 * session", the state-lock guards "STATE.md is being written right now" — a
 * short-lived lock acquired around every read-modify-write cycle.
 *
 * Design:
 *  - Atomic create via tmp + linkSync, delegated to the shared file-lock
 *    primitive (tryAcquireFileLock).
 *  - Body: { pid, host, acquiredAt, holder } — host is included so cross-host
 *    callers (rare but possible via shared filesystems) avoid spurious PID
 *    liveness checks against unrelated PIDs.
 *  - Stale detection: process.kill(pid, 0). When the holder is on the same
 *    host and the PID is dead (ESRCH), the lock is overridden atomically and
 *    a WARN is written to stderr. Cross-host stale locks are NOT auto-cleared
 *    — they fall through to the timeout path.
 *  - Poll cadence: 100 ms by default. Configurable via STATE_LOCK_POLL_MS but
 *    no public override — tests inject via the optional `pollMs` parameter.
 *
 * Returns structured results, never throws (acquireStateLock / releaseStateLock).
 * withStateMdLock re-throws caller errors after releasing.
 *
 * Dependency edges point locks/state-md-lock → { file-lock, config/state-md-lock,
 * locks/lock-body }, NEVER → session-lock.mjs, so there is no import cycle.
 *
 * NAMING NOTE: scripts/lib/config/state-md-lock.mjs is a DIFFERENT file — it
 * parses the `state-md-lock:` Session Config key. This module is the lock IMPL.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { _parseStateMdLock } from '../config/state-md-lock.mjs';
import { tryAcquireFileLock } from '../file-lock.mjs';
import { nowIso, delay, parseLockBody } from './lock-body.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// STATE.md write-lock (PRD 2026-05-22 § 4 — Pattern 1, issue #518).
// Orthogonal to the session-lock:
//   - session.lock = "this repo working-copy is held by an active session"
//   - state.lock   = "STATE.md is being written right now"
// Two distinct lock files so a session can hold its session-lock for hours
// while still allowing fast acquire/release cycles around individual writes.
export const STATE_LOCK_PATH = '.orchestrator/state.lock';
export const DEFAULT_STATE_LOCK_TIMEOUT_MS = 10000;
export const STATE_LOCK_POLL_MS = 100;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

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
