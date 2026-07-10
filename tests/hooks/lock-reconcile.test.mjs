/**
 * tests/hooks/lock-reconcile.test.mjs
 *
 * Unit tests for hooks/_lib/lock-reconcile.mjs — the extracted, DI-testable
 * reconciliation seam for hooks/on-session-end.mjs (Issue #748).
 *
 * Strategy: import attemptLockReconciliation() directly and inject mock
 * reapRepoLock/emitEvent impls via the test-only `_reapRepoLockImpl` /
 * `_emitEventImpl` DI seams — mirrors tests/hooks/lock-bootstrap.test.mjs.
 * Prior to this extraction, the reconciliation branch was only reachable via
 * a subprocess spawn (tests/hooks/on-session-end.test.mjs), so its payload
 * shape and error-swallowing contract could only be asserted indirectly
 * through events.jsonl side effects.
 */

import { describe, it, expect, vi } from 'vitest';

import { attemptLockReconciliation } from '../../hooks/_lib/lock-reconcile.mjs';

// Fixture timestamps MUST be relative to the real clock: the SUT's liveness
// check (isLockLive) compares last_heartbeat against Date.now(). A pinned
// absolute NOW is a time bomb — liveLock() expires ttl_hours after the pinned
// instant and the suite goes red forever (observed 2026-07-10 16:00 UTC).
const NOW = Date.now();

/** A dead lock — heartbeat well past its TTL, eligible for reconciliation. */
function deadLock({ sessionId = 'ghost', semantic = 'sem-ghost', ttlHours = 4 } = {}) {
  return {
    session_id: sessionId,
    semantic_session_id: semantic,
    started_at: new Date(NOW - 10 * 3600_000).toISOString(),
    last_heartbeat: new Date(NOW - 10 * 3600_000).toISOString(),
    mode: 'deep',
    pid: 999999,
    host: 'some-host',
    ttl_hours: ttlHours,
  };
}

/** A live lock — heartbeat fresh, must never trigger reconciliation. */
function liveLock({ sessionId = 'live', semantic = 'sem-live', ttlHours = 4 } = {}) {
  return {
    session_id: sessionId,
    semantic_session_id: semantic,
    started_at: new Date(NOW).toISOString(),
    last_heartbeat: new Date(NOW).toISOString(),
    mode: 'deep',
    pid: 999999,
    host: 'some-host',
    ttl_hours: ttlHours,
  };
}

describe('attemptLockReconciliation', () => {
  it('resolves without throwing when _emitEventImpl throws (best-effort — load-bearing)', async () => {
    const reapImpl = vi.fn(async () => ({ action: 'reaped', reason: null }));
    const emitImpl = vi.fn(async () => { throw new Error('emit boom'); });

    await expect(attemptLockReconciliation({
      repoRoot: '/tmp/does-not-matter',
      sessionId: 'ending-session',
      lock: deadLock(),
      _reapRepoLockImpl: reapImpl,
      _emitEventImpl: emitImpl,
    })).resolves.toBeUndefined();

    expect(reapImpl).toHaveBeenCalledTimes(1);
    expect(emitImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when _reapRepoLockImpl throws, and never calls emit', async () => {
    const reapImpl = vi.fn(async () => { throw new Error('reap boom'); });
    const emitImpl = vi.fn(async () => {});

    await expect(attemptLockReconciliation({
      repoRoot: '/tmp/does-not-matter',
      sessionId: 'ending-session',
      lock: deadLock(),
      _reapRepoLockImpl: reapImpl,
      _emitEventImpl: emitImpl,
    })).resolves.toBeUndefined();

    expect(reapImpl).toHaveBeenCalledTimes(1);
    expect(emitImpl).not.toHaveBeenCalled();
  });

  it('happy path: calls reapRepoLock then emits reconcile_attempted with the reap-result payload', async () => {
    const reapImpl = vi.fn(async () => ({ action: 'reaped', reason: null }));
    const emitImpl = vi.fn(async () => {});

    await attemptLockReconciliation({
      repoRoot: '/tmp/repo',
      sessionId: 'ending-session',
      lock: deadLock(),
      _reapRepoLockImpl: reapImpl,
      _emitEventImpl: emitImpl,
    });

    expect(reapImpl).toHaveBeenCalledWith({
      repoRoot: '/tmp/repo',
      currentSessionId: 'ending-session',
      dryRun: false,
      reapMode: 'auto-session-end',
    });
    expect(emitImpl).toHaveBeenCalledWith('orchestrator.session.lock.reconcile_attempted', {
      session_id: 'ending-session',
      action: 'reaped',
      reason: null,
    });
  });

  it('emits reconcile_attempted with the skipped action/reason when reapRepoLock reports skipped', async () => {
    const reapImpl = vi.fn(async () => ({ action: 'skipped', reason: 'own-host-pid-alive' }));
    const emitImpl = vi.fn(async () => {});

    await attemptLockReconciliation({
      repoRoot: '/tmp/repo',
      sessionId: 'ending-session',
      lock: deadLock(),
      _reapRepoLockImpl: reapImpl,
      _emitEventImpl: emitImpl,
    });

    expect(emitImpl).toHaveBeenCalledWith('orchestrator.session.lock.reconcile_attempted', {
      session_id: 'ending-session',
      action: 'skipped',
      reason: 'own-host-pid-alive',
    });
  });

  it('emits reconcile_attempted with action "unknown" and reason null when reapRepoLock resolves undefined', async () => {
    const reapImpl = vi.fn(async () => undefined);
    const emitImpl = vi.fn(async () => {});

    await attemptLockReconciliation({
      repoRoot: '/tmp/repo',
      sessionId: 'ending-session',
      lock: deadLock(),
      _reapRepoLockImpl: reapImpl,
      _emitEventImpl: emitImpl,
    });

    expect(emitImpl).toHaveBeenCalledWith('orchestrator.session.lock.reconcile_attempted', {
      session_id: 'ending-session',
      action: 'unknown',
      reason: null,
    });
  });

  it('no-ops (never calls reapRepoLock or emitEvent) when the lock is still live', async () => {
    const reapImpl = vi.fn(async () => ({ action: 'reaped', reason: null }));
    const emitImpl = vi.fn(async () => {});

    await attemptLockReconciliation({
      repoRoot: '/tmp/repo',
      sessionId: 'ending-session',
      lock: liveLock(),
      _reapRepoLockImpl: reapImpl,
      _emitEventImpl: emitImpl,
    });

    expect(reapImpl).not.toHaveBeenCalled();
    expect(emitImpl).not.toHaveBeenCalled();
  });

  it('no-ops when lock is null/missing', async () => {
    const reapImpl = vi.fn(async () => ({ action: 'reaped', reason: null }));
    const emitImpl = vi.fn(async () => {});

    await attemptLockReconciliation({
      repoRoot: '/tmp/repo',
      sessionId: 'ending-session',
      lock: null,
      _reapRepoLockImpl: reapImpl,
      _emitEventImpl: emitImpl,
    });

    expect(reapImpl).not.toHaveBeenCalled();
    expect(emitImpl).not.toHaveBeenCalled();
  });
});
