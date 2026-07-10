/**
 * lock-reconcile.mjs — root-cause reconciliation fallback for the SessionEnd hook.
 *
 * Extracted (Issue #748) from the inline reconciliation branch that used to live
 * in `hooks/on-session-end.mjs`'s `main()` — that branch was only reachable via
 * a subprocess spawn in tests, so its behaviour could only be verified through
 * events.jsonl side effects, never asserted in-process. This module is the
 * importable, DI-testable seam; `on-session-end.mjs` now just calls it.
 *
 * Context (Epic #724 Wave 3 — "ended logged but lock survived"): neither the
 * UUID nor the semantic id matched the recorded lock (a rotated harness UUID
 * racing ahead of current-session.json's semantic bridge), but the lease is
 * already dead. Reconcile now via the same reaper the SessionStart hook uses
 * (Epic #724 C7), instead of leaving the orphaned lease for the next
 * session-start to discover. Safe by construction: reapRepoLock() never
 * touches a live lease, a cross-host lease, or a lease whose recorded PID is
 * still alive on this host.
 *
 * Best-effort by design, mirroring hooks/_lib/lock-bootstrap.mjs: every
 * internal failure is swallowed so the SessionEnd hook stays non-blocking (the
 * hook's contract is informational-only; a reconciliation failure here must
 * NEVER break session teardown).
 *
 * @module hooks/_lib/lock-reconcile
 */

import { isLockLive } from '../../scripts/lib/session-lock.mjs';

/**
 * Attempt a best-effort reconciliation of a dead, orphaned session.lock that
 * neither ownership check (UUID nor semantic id) matched. No-op when `lock`
 * is missing or still live (isLockLive) — mirrors the `else if (!isLockLive(lock))`
 * guard this function replaces at the call site.
 *
 * Never throws. Any failure resolving the DI defaults, calling reapRepoLock,
 * or emitting the breadcrumb event is swallowed.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot — absolute path to the repository root.
 * @param {string|null} opts.sessionId — the ending session's id (UUID or semantic).
 * @param {object} opts.lock — the recorded lock the caller already read via readLock().
 * @param {Function} [opts._reapRepoLockImpl] — DI for tests (defaults to importing
 *   reapRepoLock from scripts/lib/lock-reaper.mjs).
 * @param {Function} [opts._emitEventImpl] — DI for tests (defaults to importing
 *   emitEvent from scripts/lib/events.mjs).
 * @returns {Promise<void>}
 */
export async function attemptLockReconciliation({
  repoRoot,
  sessionId,
  lock,
  _reapRepoLockImpl,
  _emitEventImpl,
} = {}) {
  // Mirrors the caller's original `else if (!isLockLive(lock))` guard — a
  // missing or still-live lock is never reconciled.
  if (!lock || typeof lock !== 'object' || isLockLive(lock)) return;

  // Resolve DI shims at call time so test mocks can replace the imports.
  let reapFn = _reapRepoLockImpl;
  if (!reapFn) {
    try {
      const reaperMod = await import('../../scripts/lib/lock-reaper.mjs');
      reapFn = reaperMod.reapRepoLock;
    } catch {
      return;
    }
  }

  let emitFn = _emitEventImpl;
  if (!emitFn) {
    try {
      const eventsMod = await import('../../scripts/lib/events.mjs');
      emitFn = eventsMod.emitEvent;
    } catch {
      return;
    }
  }

  try {
    const reapResult = await reapFn({
      repoRoot,
      currentSessionId: sessionId,
      dryRun: false,
      reapMode: 'auto-session-end',
    });
    await emitFn('orchestrator.session.lock.reconcile_attempted', {
      session_id: sessionId,
      action: reapResult?.action ?? 'unknown',
      reason: reapResult?.reason ?? null,
    });
  } catch { /* best-effort — reconciliation must never block teardown */ }
}
