/**
 * tests/unit/state-md-lock.test.mjs
 *
 * Vitest unit tests for the STATE.md-Lock helpers added to
 * scripts/lib/session-lock.mjs (Pattern 1, issue #518).
 *
 * Covers:
 *   - acquireStateLock: success, timeout on live PID, stale-lock override,
 *     WARN to stderr on override, atomic tmp+rename behaviour
 *   - releaseStateLock: matching PID releases, foreign PID rejected, no-lock
 *   - withStateMdLock: acquire-run-release, release on throw, error re-thrown,
 *     return value propagated
 *
 * Every test uses an isolated tmp dir — no writes to the real repo.
 * All assertions use hardcoded literals (no in-test computation mirrors).
 *
 * Design note: the functions under test do NOT exist yet when this file is
 * first committed (Agent A implements them in parallel). Tests will be RED
 * until Agent A's commit lands. This is expected per the wave plan.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  acquireStateLock,
  releaseStateLock,
  withStateMdLock,
} from '@lib/session-lock.mjs';

// ---------------------------------------------------------------------------
// A PID that is guaranteed never to be alive (exceeds Linux/macOS max PID).
// ---------------------------------------------------------------------------
const DEAD_PID = 999999;

// ---------------------------------------------------------------------------
// Per-test isolated tmp root
// ---------------------------------------------------------------------------

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'state-lock-unit-'));
  // Ensure .orchestrator/ exists — the implementation expects the parent dir
  mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
});

afterEach(() => {
  // Restore stderr spy if any test installed one
  vi.restoreAllMocks();
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// acquireStateLock
// ---------------------------------------------------------------------------

describe('acquireStateLock', () => {
  it('creates .orchestrator/state.lock with pid, acquiredAt, and holder fields', async () => {
    const result = await acquireStateLock({ repoRoot });

    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    expect(existsSync(lockPath)).toBe(true);

    const raw = readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(raw);
    expect(typeof lock.pid).toBe('number');
    expect(typeof lock.acquiredAt).toBe('string');
    expect(typeof lock.holder).toBe('string');
    // Suppress unused-result lint by checking ok separately
    expect(result.ok).toBe(true);
  });

  it('returns { ok: true, lock } on successful acquire with correct pid', async () => {
    const result = await acquireStateLock({ repoRoot });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        lock: expect.objectContaining({
          pid: process.pid,
          acquiredAt: expect.any(String),
          holder: expect.any(String),
        }),
      }),
    );
  });

  it('returns { ok: false, reason: "timeout" } when blocked by a live-PID lock for longer than timeoutMs', async () => {
    // Plant a lock with the current process's PID (guaranteed alive)
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(), holder: 'blocker' }),
      'utf8',
    );

    // timeoutMs: 200 — short enough to not make the test suite slow
    const result = await acquireStateLock({ repoRoot, timeoutMs: 200 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('overrides a stale lock when the holder PID is not alive', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: hostname(), acquiredAt: new Date().toISOString(), holder: 'dead-session' }),
      'utf8',
    );

    const result = await acquireStateLock({ repoRoot, timeoutMs: 500 });

    expect(result.ok).toBe(true);
    expect(result.lock.pid).toBe(process.pid);

    // The old lock must be overwritten — verify the pid on disk is ours
    const raw = readFileSync(lockPath, 'utf8');
    const disk = JSON.parse(raw);
    expect(disk.pid).toBe(process.pid);
  });

  it('emits a WARN to stderr containing "stale state.lock" and the old PID when overriding', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: hostname(), acquiredAt: new Date().toISOString(), holder: 'ghost' }),
      'utf8',
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await acquireStateLock({ repoRoot, timeoutMs: 500 });

    // At least one warn call must mention the stale lock and the dead PID
    const calls = warnSpy.mock.calls.map((args) => args.map(String).join(' '));
    const warnCall = calls.find(
      (msg) => msg.includes('stale state.lock') && msg.includes(String(DEAD_PID)),
    );
    expect(warnCall).toBeDefined();
  });

  it('leaves no .tmp.* file in .orchestrator/ after a clean acquire (atomic write hygiene)', async () => {
    await acquireStateLock({ repoRoot });

    const orchDir = join(repoRoot, '.orchestrator');
    const entries = readdirSync(orchDir);
    const tmpFiles = entries.filter((name) => name.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// releaseStateLock
// ---------------------------------------------------------------------------

describe('releaseStateLock', () => {
  it('removes .orchestrator/state.lock when the lock is owned by the current PID', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    // Acquire first so the lock is ours
    await acquireStateLock({ repoRoot });
    expect(existsSync(lockPath)).toBe(true);

    const result = await releaseStateLock({ repoRoot });

    expect(result.ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('returns { ok: false, reason: "not-owner" } when lock is held by a different PID', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: hostname(), acquiredAt: new Date().toISOString(), holder: 'other' }),
      'utf8',
    );

    const result = await releaseStateLock({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-owner');
    // Lock file must still be present — we did not remove foreign property
    expect(existsSync(lockPath)).toBe(true);
  });

  it('returns { ok: false, reason: "not-found" } when no lock file exists', async () => {
    const result = await releaseStateLock({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// withStateMdLock
// ---------------------------------------------------------------------------

describe('withStateMdLock', () => {
  it('acquires the lock, runs fn, and releases the lock on success', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    let lockExistedDuringFn = false;

    await withStateMdLock(
      repoRoot,
      () => {
        lockExistedDuringFn = existsSync(lockPath);
      },
    );

    // Lock existed while fn ran
    expect(lockExistedDuringFn).toBe(true);
    // Lock was released after fn returned
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock even when fn throws', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');

    try {
      await withStateMdLock(repoRoot, () => {
        throw new Error('intentional failure');
      });
    } catch {
      // expected — swallow
    }

    expect(existsSync(lockPath)).toBe(false);
  });

  it('re-throws the fn error after releasing the lock', async () => {
    await expect(
      withStateMdLock(repoRoot, () => {
        throw new Error('boom from fn');
      }),
    ).rejects.toThrow('boom from fn');
  });

  it('returns the return value of fn on success', async () => {
    const result = await withStateMdLock(repoRoot, () => 'state-written');

    expect(result).toBe('state-written');
  });

  it('returns an async fn return value on success', async () => {
    const result = await withStateMdLock(repoRoot, async () => {
      return 42;
    });

    expect(result).toBe(42);
  });
});
