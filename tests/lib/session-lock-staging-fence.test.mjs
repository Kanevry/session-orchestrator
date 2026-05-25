/**
 * tests/lib/session-lock-staging-fence.test.mjs
 *
 * Tests for the staging-fence commit-lock API exported from
 * scripts/lib/session-lock.mjs (PSA-004 sub-mode C, issue #552).
 *
 * Covers:
 *   - withStagingFenceLock timeout when lock is held by a live PID
 *   - Stale-PID (dead PID) override path
 *   - releaseStagingFenceLock holder mismatch → not-owner
 *   - fn() throws → lock is always released + error re-thrown
 *   - withStagingFenceLock non-function fn → synchronous TypeError
 *
 * Issue: #557
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  acquireStagingFenceLock,
  releaseStagingFenceLock,
  withStagingFenceLock,
  STAGING_FENCE_LOCK_PATH,
} from '@lib/session-lock.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute path to the staging-fence lock file for a given repoRoot. */
function lockPath(repoRoot) {
  return join(repoRoot, STAGING_FENCE_LOCK_PATH);
}

/**
 * Write a pre-formed staging-fence lock body to disk, as if another
 * process already holds the lock.
 */
function writeLock(repoRoot, body) {
  const lp = lockPath(repoRoot);
  mkdirSync(join(repoRoot, '.orchestrator', 'staging-fence'), { recursive: true });
  writeFileSync(lp, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

/**
 * Build a valid staging-fence lock body that parseStateLock will accept.
 * The shape must have: pid, host, acquiredAt, holder.
 */
function buildLockBody({ pid = process.pid, hostOverride, holder = 'test-holder' } = {}) {
  return {
    pid,
    host: hostOverride ?? hostname(),
    acquiredAt: new Date().toISOString(),
    holder,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'staging-fence-lock-test-'));
  mkdirSync(join(repoRoot, '.orchestrator', 'staging-fence'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withStagingFenceLock — acquire / timeout / error paths', { timeout: 15000 }, () => {
  // 1. Timeout: lock held by a live PID → acquireStagingFenceLock returns timeout.
  it('times out when lock is held by the current live PID and throws with acquire-failed message', async () => {
    // Write a lock with our own PID so isPidAlive() returns true.
    writeLock(repoRoot, buildLockBody({ pid: process.pid, holder: 'live-holder' }));

    await expect(
      withStagingFenceLock(repoRoot, async () => 'should-not-run', {
        timeoutMs: 200,
        pollMs: 50,
      }),
    ).rejects.toThrow('acquire failed (timeout)');
  });

  // 2. Stale-PID override: dead PID → stale lock is overridden and fn() runs.
  it('overrides a stale lock from a dead PID and resolves with the fn return value', async () => {
    // PID 999999 is guaranteed dead on any machine the kernel would never assign it.
    writeLock(repoRoot, buildLockBody({ pid: 999999, holder: 'dead-holder' }));

    const stderrChunks = [];
    const origWarn = console.warn;
    console.warn = (...args) => stderrChunks.push(args.join(' '));

    let fnCalled = false;
    const result = await withStagingFenceLock(
      repoRoot,
      async () => {
        fnCalled = true;
        return 'result-after-stale-override';
      },
      { timeoutMs: 2000, pollMs: 50 },
    );

    console.warn = origWarn;

    expect(fnCalled).toBe(true);
    expect(result).toBe('result-after-stale-override');
    // The stale-override path emits a console.warn.
    expect(stderrChunks.some((msg) => msg.includes('stale') || msg.includes('999999'))).toBe(true);
  });

  // 3. Release with holder mismatch → not-owner.
  it('releaseStagingFenceLock returns not-owner when holder string does not match', async () => {
    // Acquire under holder='alice'.
    const acquireResult = await acquireStagingFenceLock({
      repoRoot,
      holder: 'alice',
      timeoutMs: 2000,
    });
    expect(acquireResult.ok).toBe(true);

    // Try to release as 'bob'.
    const releaseResult = releaseStagingFenceLock({ repoRoot, holder: 'bob' });
    expect(releaseResult.ok).toBe(false);
    expect(releaseResult.reason).toBe('not-owner');

    // Clean up.
    releaseStagingFenceLock({ repoRoot, holder: 'alice' });
  });

  // 4. fn() throws → lock file is deleted + original error re-thrown.
  it('releases the lock and re-throws when fn() throws', async () => {
    await expect(
      withStagingFenceLock(repoRoot, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Lock file must be gone after the throw.
    expect(existsSync(lockPath(repoRoot))).toBe(false);
  });

  // 5. TypeError on non-function fn → Promise rejects with TypeError.
  // withStagingFenceLock is async so the guard throws inside an async context;
  // the rejection carries the TypeError.
  it('rejects with TypeError when fn is not a function', async () => {
    await expect(withStagingFenceLock(repoRoot, 'not-a-fn')).rejects.toThrow(TypeError);
  });
});
