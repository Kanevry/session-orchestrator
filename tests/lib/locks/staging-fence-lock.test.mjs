/**
 * tests/lib/locks/staging-fence-lock.test.mjs
 *
 * Direct unit tests for the staging-fence commit-mutex protocol module that was
 * split out of session-lock.mjs in #630 (A1 barrel-preserving split). These
 * tests import from the NEW module path (`@lib/locks/staging-fence-lock.mjs`)
 * rather than via the session-lock barrel, so they verify the module works
 * standalone and its dependency edges (file-lock, locks/lock-body) resolve
 * without a cycle.
 *
 * Smoke scope: acquire→release roundtrip + withStagingFenceLock wrapper.
 * The full behavioural suite (timeout, stale-PID override, holder mismatch,
 * fn-throws) lives in tests/lib/session-lock-staging-fence.test.mjs against
 * the barrel.
 *
 * Issue: #630
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireStagingFenceLock,
  releaseStagingFenceLock,
  withStagingFenceLock,
  STAGING_FENCE_LOCK_PATH,
  DEFAULT_STAGING_FENCE_LOCK_TIMEOUT_MS,
  STAGING_FENCE_LOCK_POLL_MS,
} from '@lib/locks/staging-fence-lock.mjs';

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'staging-fence-lock-test-'));
  mkdirSync(join(repoRoot, '.orchestrator', 'staging-fence'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('locks/staging-fence-lock — module-level constants', () => {
  it('exposes the canonical lock path and timing defaults', () => {
    expect(STAGING_FENCE_LOCK_PATH).toBe('.orchestrator/staging-fence/.commit.lock');
    expect(DEFAULT_STAGING_FENCE_LOCK_TIMEOUT_MS).toBe(10000);
    expect(STAGING_FENCE_LOCK_POLL_MS).toBe(100);
  });
});

describe('locks/staging-fence-lock — acquire / release roundtrip', () => {
  it('acquires the lock, writes the lockfile, then releases it cleanly', async () => {
    const lockFile = join(repoRoot, STAGING_FENCE_LOCK_PATH);

    const acquired = await acquireStagingFenceLock({ repoRoot, holder: 'roundtrip-holder' });
    expect(acquired.ok).toBe(true);
    expect(acquired.lock).toMatchObject({ holder: 'roundtrip-holder', pid: process.pid });
    expect(existsSync(lockFile)).toBe(true);

    const released = releaseStagingFenceLock({ repoRoot, holder: 'roundtrip-holder' });
    expect(released).toEqual({ ok: true });
    expect(existsSync(lockFile)).toBe(false);
  });

  it('release on an absent lock reports not-found', () => {
    const released = releaseStagingFenceLock({ repoRoot, holder: 'nobody' });
    expect(released).toEqual({ ok: false, reason: 'not-found' });
  });

  // #1349: same shared-guard delegation as the STATE.md lock.
  it('a NON-owner release leaves the lock in place and reports not-owner', async () => {
    const lockFile = join(repoRoot, STAGING_FENCE_LOCK_PATH);
    await acquireStagingFenceLock({ repoRoot, holder: 'owner-A' });

    const released = releaseStagingFenceLock({ repoRoot, holder: 'intruder-B' });
    expect(released).toEqual({ ok: false, reason: 'not-owner' });
    expect(existsSync(lockFile)).toBe(true);

    expect(releaseStagingFenceLock({ repoRoot, holder: 'owner-A' })).toEqual({ ok: true });
    expect(existsSync(lockFile)).toBe(false);
  });

  // #1349 DISCRIMINATOR — the behaviour the shared `.acquire` guard adds, and
  // the only one the replaced inline sequence did NOT have: while a contender
  // holds the sibling guard, the release must leave the lock file alone and
  // answer `busy`. The old hand-rolled read → owner-match → unlinkSync ignored
  // the sibling and deleted the lock regardless.
  it('reports busy and keeps the lock when the `.acquire` guard is held', async () => {
    const lockFile = join(repoRoot, STAGING_FENCE_LOCK_PATH);
    await acquireStagingFenceLock({ repoRoot, holder: 'owner-A' });

    // Simulate a contender mid-pass: the guard exists and is never released.
    writeFileSync(`${lockFile}.acquire`, '{}');

    const released = releaseStagingFenceLock({ repoRoot, holder: 'owner-A' });
    expect(released).toEqual({ ok: false, reason: 'busy' });
    expect(existsSync(lockFile)).toBe(true);
  }, 15000);

  it('release leaves no `.acquire` sibling behind', async () => {
    const lockFile = join(repoRoot, STAGING_FENCE_LOCK_PATH);
    await acquireStagingFenceLock({ repoRoot, holder: 'owner-A' });
    expect(releaseStagingFenceLock({ repoRoot, holder: 'owner-A' })).toEqual({ ok: true });
    expect(existsSync(`${lockFile}.acquire`)).toBe(false);
  });
});

describe('locks/staging-fence-lock — withStagingFenceLock wrapper', () => {
  it('runs fn under the lock and releases afterward, returning fn result', async () => {
    const lockFile = join(repoRoot, STAGING_FENCE_LOCK_PATH);

    const result = await withStagingFenceLock(repoRoot, () => {
      expect(existsSync(lockFile)).toBe(true);
      return 'fn-return-value';
    });

    expect(result).toBe('fn-return-value');
    expect(existsSync(lockFile)).toBe(false);
  });

  it('rejects a non-function fn synchronously with a TypeError', async () => {
    await expect(withStagingFenceLock(repoRoot, /* not a fn */ 42)).rejects.toThrow(TypeError);
  });

  // #1349 fix-pass — same bug class as the STATE.md wrapper, and worse here: a
  // leaked `.commit.lock` blocks the cross-agent fence check for every sibling
  // wave-agent until the stale policy expires. The wrapper returns fn()'s value
  // either way, so the WARN is the ONLY evidence the lock was left behind —
  // and deleting the `busy` branch left `npx vitest run tests/lib/locks/` at
  // 16 passed.
  it('WARNs, still returns fn value, and leaves the lock behind when release is busy', async () => {
    const lockFile = join(repoRoot, STAGING_FENCE_LOCK_PATH);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await withStagingFenceLock(repoRoot, () => {
      // Contender takes the shared `.acquire` guard mid-pass and never gives it
      // back, so the wrapper's release cannot take it and answers `busy`.
      writeFileSync(`${lockFile}.acquire`, '{}');
      return 'fn-return-value';
    });

    expect(result).toBe('fn-return-value');
    expect(existsSync(lockFile)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'withStagingFenceLock: release failed (busy: acquire guard held) — .commit.lock left for its stale policy',
    );
  }, 20000);
});
