/**
 * tests/lib/locks/state-md-lock.test.mjs
 *
 * Direct unit tests for the STATE.md write-lock protocol module that was split
 * out of session-lock.mjs in #630 (A1 barrel-preserving split). These tests
 * import from the NEW module path (`@lib/locks/state-md-lock.mjs`) rather than
 * via the session-lock barrel, so they verify the module works standalone and
 * its dependency edges (file-lock, config/state-md-lock, locks/lock-body)
 * resolve without a cycle.
 *
 * Smoke scope: acquire→release roundtrip + withStateMdLock wrapper.
 * The full behavioural suite (timeout, stale-PID override, holder mismatch,
 * fn-throws) lives in tests/lib/session-lock.test.mjs against the barrel.
 *
 * Issue: #630
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireStateLock,
  releaseStateLock,
  withStateMdLock,
  STATE_LOCK_PATH,
  DEFAULT_STATE_LOCK_TIMEOUT_MS,
  STATE_LOCK_POLL_MS,
} from '@lib/locks/state-md-lock.mjs';

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'state-md-lock-test-'));
  mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('locks/state-md-lock — module-level constants', () => {
  it('exposes the canonical lock path and timing defaults', () => {
    expect(STATE_LOCK_PATH).toBe('.orchestrator/state.lock');
    expect(DEFAULT_STATE_LOCK_TIMEOUT_MS).toBe(10000);
    expect(STATE_LOCK_POLL_MS).toBe(100);
  });
});

describe('locks/state-md-lock — acquire / release roundtrip', () => {
  it('acquires the lock, writes the lockfile, then releases it cleanly', async () => {
    const lockFile = join(repoRoot, STATE_LOCK_PATH);

    const acquired = await acquireStateLock({ repoRoot, holder: 'roundtrip-holder' });
    expect(acquired.ok).toBe(true);
    expect(acquired.lock).toMatchObject({ holder: 'roundtrip-holder', pid: process.pid });
    expect(existsSync(lockFile)).toBe(true);

    const released = releaseStateLock({ repoRoot, holder: 'roundtrip-holder' });
    expect(released).toEqual({ ok: true });
    expect(existsSync(lockFile)).toBe(false);
  });

  it('release on an absent lock reports not-found', () => {
    const released = releaseStateLock({ repoRoot, holder: 'nobody' });
    expect(released).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('locks/state-md-lock — withStateMdLock wrapper', () => {
  it('runs fn under the lock and releases afterward, returning fn result', async () => {
    const lockFile = join(repoRoot, STATE_LOCK_PATH);

    const result = await withStateMdLock(repoRoot, () => {
      // Lock must be held while fn runs.
      expect(existsSync(lockFile)).toBe(true);
      return 'fn-return-value';
    });

    expect(result).toBe('fn-return-value');
    // Lock released after fn completes.
    expect(existsSync(lockFile)).toBe(false);
  });

  it('rejects a non-function fn synchronously with a TypeError', async () => {
    await expect(withStateMdLock(repoRoot, /* not a fn */ 42)).rejects.toThrow(TypeError);
  });
});
