/**
 * locks/staging-fence-lock.mjs — staging-fence commit-mutex protocol
 * (PSA-004 sub-mode C, issue #552).
 *
 * Split out of session-lock.mjs in #630 (A1 barrel-preserving split). The
 * symbols below are re-exported UNCHANGED from session-lock.mjs so the original
 * import surface is preserved for all 17 importers (incl.
 * hooks/wave-scope-commit-guard.mjs).
 *
 * Held only around the wave-scope-commit-guard cross-fence check. Two sibling
 * wave-agents that both pass through the per-agent guard race to acquire this
 * lock; the winner inspects ALL fence files, the loser polls until the winner
 * releases. Without the mutex the check is TOCTOU-vulnerable: agent A reads
 * agent B's fence file BEFORE B writes agent B's last `git add` intent, and
 * both proceed to `git commit` with overlapping staged paths.
 *
 * Implementation reuses the same tmp+linkSync cross-process pattern as the
 * STATE.md lock (delegated to the shared file-lock primitive). The two lockfiles
 * are distinct so STATE.md writes never contend with commit-guard checks.
 *
 * Dependency edges point locks/staging-fence-lock → { file-lock, locks/lock-body },
 * NEVER → session-lock.mjs, so there is no import cycle.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { tryAcquireFileLock } from '../file-lock.mjs';
import { nowIso, delay, parseLockBody } from './lock-body.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Acquire the staging-fence commit-lock. Polls every STAGING_FENCE_LOCK_POLL_MS
 * until the lock is acquired or the timeout expires. Same semantics as
 * acquireStateLock.
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
