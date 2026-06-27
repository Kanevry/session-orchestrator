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
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
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
});
