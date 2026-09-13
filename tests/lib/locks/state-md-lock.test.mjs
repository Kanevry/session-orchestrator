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
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
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

  // #1349: the release path delegates to the shared releaseFileLock owner guard.
  // Bug this catches: a non-owner release deleting a live holder's lock — the
  // hand-rolled sequence this replaced had the same owner check but took no
  // `.acquire` sibling guard, so restoring it is what the sweep must not undo.
  it('a NON-owner release leaves the lock in place and reports not-owner', async () => {
    const lockFile = join(repoRoot, STATE_LOCK_PATH);
    await acquireStateLock({ repoRoot, holder: 'owner-A' });

    const released = releaseStateLock({ repoRoot, holder: 'intruder-B' });
    expect(released).toEqual({ ok: false, reason: 'not-owner' });
    expect(existsSync(lockFile)).toBe(true);

    // The real owner can still release afterwards.
    expect(releaseStateLock({ repoRoot, holder: 'owner-A' })).toEqual({ ok: true });
    expect(existsSync(lockFile)).toBe(false);
  });

  // #1349 DISCRIMINATOR — the behaviour the shared `.acquire` guard adds, and
  // the only one the replaced inline sequence did NOT have: while a contender
  // holds the sibling guard, the release must leave the lock file alone and
  // answer `busy`. The old hand-rolled read → owner-match → unlinkSync ignored
  // the sibling and deleted the lock regardless.
  it('reports busy and keeps the lock when the `.acquire` guard is held', async () => {
    const lockFile = join(repoRoot, STATE_LOCK_PATH);
    await acquireStateLock({ repoRoot, holder: 'owner-A' });

    // Simulate a contender mid-pass: the guard exists and is never released.
    writeFileSync(`${lockFile}.acquire`, '{}');

    const released = releaseStateLock({ repoRoot, holder: 'owner-A' });
    expect(released).toEqual({ ok: false, reason: 'busy' });
    expect(existsSync(lockFile)).toBe(true);
  }, 15000);

  it('release leaves no `.acquire` sibling behind', async () => {
    const lockFile = join(repoRoot, STATE_LOCK_PATH);
    await acquireStateLock({ repoRoot, holder: 'owner-A' });
    expect(releaseStateLock({ repoRoot, holder: 'owner-A' })).toEqual({ ok: true });
    expect(existsSync(`${lockFile}.acquire`)).toBe(false);
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

  // #1349 fix-pass. Bug caught: a LEAKED state.lock that no process holds.
  // When the shared `.acquire` guard is taken while the wrapper's finally-block
  // runs, releaseFileLock answers `busy` and the lock file survives the call —
  // yet the wrapper still returns fn()'s value, so a clean run and a leaked lock
  // are indistinguishable to every caller. The WARN on stderr is the ONLY
  // evidence, and nothing pinned it: deleting the `busy` branch left
  // `npx vitest run tests/lib/locks/` at 16 passed. The next session then waits
  // out the full stale policy on a lock nobody holds.
  it('WARNs, still returns fn value, and leaves the lock behind when release is busy', async () => {
    const lockFile = join(repoRoot, STATE_LOCK_PATH);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await withStateMdLock(repoRoot, () => {
      // A contender takes the shared `.acquire` guard mid-pass and never gives
      // it back, so the wrapper's release cannot take it and answers `busy`.
      writeFileSync(`${lockFile}.acquire`, '{}');
      return 'fn-return-value';
    });

    expect(result).toBe('fn-return-value');
    expect(existsSync(lockFile)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'withStateMdLock: release failed (busy: acquire guard held) — state.lock left for its stale policy',
    );
  }, 20000);
});
