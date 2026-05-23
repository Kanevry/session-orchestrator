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
 * Extended (#522 AC3 — test-writer W4):
 *   - Group A: cross-host lock detection — foreign-host lock not auto-overridden
 *   - Group B: unparseable lock JSON overridden with WARN
 *   - Group C: releaseStateLock holder mismatch (holder string, not PID)
 *   - Group D: withStateMdLock structured-error codes (STATE_LOCK_TIMEOUT, STATE_LOCK_FS_ERROR)
 *   - Group E: state-md-lock.enabled short-circuit (opts override + CLAUDE.md + default)
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
  chmodSync,
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

// ---------------------------------------------------------------------------
// Group A: cross-host lock detection (#522 AC3)
// ---------------------------------------------------------------------------

describe('acquireStateLock — Group A: cross-host lock detection', () => {
  it('does not auto-override a lock with a foreign host and the lock content is preserved', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    // Plant a lock from a different hostname — cannot signal a remote process.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99999,
        host: 'remote-macbook.local',
        acquiredAt: new Date().toISOString(),
        holder: 'foreign-session',
      }),
      'utf8',
    );

    // Short timeout so the test does not hang — foreign-host lock can't be
    // auto-overridden (pidAlive treated as true), so the loop times out.
    const result = await acquireStateLock({ repoRoot, timeoutMs: 50, pollMs: 10 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');

    // The lock file content must be unchanged — host still foreign.
    const raw = readFileSync(lockPath, 'utf8');
    const disk = JSON.parse(raw);
    expect(disk.host).toBe('remote-macbook.local');
  });

  it('does not write "stale state.lock" override warning for a foreign-host lock', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99999,
        host: 'remote-macbook.local',
        acquiredAt: new Date().toISOString(),
        holder: 'foreign-session',
      }),
      'utf8',
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await acquireStateLock({ repoRoot, timeoutMs: 50, pollMs: 10 });

    const warnCalls = warnSpy.mock.calls.map((args) => args.map(String).join(' '));
    const staleOverrideCall = warnCalls.find((msg) => msg.includes('stale state.lock'));
    // No stale-override message should appear for a cross-host lock.
    expect(staleOverrideCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group B: unparseable lock contents (#522 AC3)
// ---------------------------------------------------------------------------

describe('acquireStateLock — Group B: unparseable lock contents', () => {
  it('overrides a lock file with malformed JSON and returns ok=true', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    // Write truncated/malformed JSON — no closing brace.
    writeFileSync(lockPath, '{ "incomplete": "json"', 'utf8');

    const result = await acquireStateLock({ repoRoot, timeoutMs: 500, pollMs: 10 });

    expect(result.ok).toBe(true);
    // Lock on disk should now be valid and owned by us.
    const raw = readFileSync(lockPath, 'utf8');
    const disk = JSON.parse(raw);
    expect(disk.pid).toBe(process.pid);
  });

  it('emits "stale state.lock (unparseable contents) overridden" to console.warn on malformed JSON override', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    writeFileSync(lockPath, '{ "incomplete": "json"', 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await acquireStateLock({ repoRoot, timeoutMs: 500, pollMs: 10 });

    const warnCalls = warnSpy.mock.calls.map((args) => args.map(String).join(' '));
    const overrideCall = warnCalls.find((msg) =>
      msg.includes('stale state.lock') && msg.includes('unparseable contents'),
    );
    expect(overrideCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Group C: releaseStateLock holder mismatch (#522 AC3)
// ---------------------------------------------------------------------------

describe('releaseStateLock — Group C: holder string mismatch', () => {
  it('returns not-owner when the holder string does not match and leaves the lock file intact', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    // Plant a lock owned by session-A.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        holder: 'session-A',
      }),
      'utf8',
    );

    const result = releaseStateLock({ repoRoot, holder: 'session-B' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-owner');
    // The lock file must NOT have been deleted.
    expect(existsSync(lockPath)).toBe(true);
    // And it must still belong to session-A.
    const raw = readFileSync(lockPath, 'utf8');
    const disk = JSON.parse(raw);
    expect(disk.holder).toBe('session-A');
  });
});

// ---------------------------------------------------------------------------
// Group D: withStateMdLock structured-error codes (#522 AC3)
// ---------------------------------------------------------------------------

describe('withStateMdLock — Group D: structured error codes', () => {
  it('throws with err.code === "STATE_LOCK_TIMEOUT" when the lock is held by a live PID', async () => {
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    // Plant a lock with our own PID — definitely alive — and current host.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        holder: 'blocker',
      }),
      'utf8',
    );

    let caughtError = null;
    try {
      await withStateMdLock(repoRoot, async () => 'never reached', { timeoutMs: 50, pollMs: 10 });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError.code).toBe('STATE_LOCK_TIMEOUT');
    // The lock file must be unchanged — we never acquired it.
    const raw = readFileSync(lockPath, 'utf8');
    const disk = JSON.parse(raw);
    expect(disk.holder).toBe('blocker');
  });

  it('throws with err.code === "STATE_LOCK_FS_ERROR" when the .orchestrator/ dir is not writable', async () => {
    const orchDir = join(repoRoot, '.orchestrator');
    // Make the dir un-writable so the lock file cannot be created.
    chmodSync(orchDir, 0o444);

    let caughtError = null;
    try {
      await withStateMdLock(repoRoot, async () => 'never reached', { timeoutMs: 500 });
    } catch (err) {
      caughtError = err;
    } finally {
      // Restore permissions so afterEach cleanup can remove the dir.
      chmodSync(orchDir, 0o755);
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError.code).toBe('STATE_LOCK_FS_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Group E: state-md-lock.enabled short-circuit (W2-A2 addition, #522 AC3)
// ---------------------------------------------------------------------------

describe('withStateMdLock — Group E: state-md-lock.enabled short-circuit', () => {
  it('bypasses lock and returns fn result when opts._stateMdLockEnabled = false', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await withStateMdLock(undefined, async () => 'ok', { _stateMdLockEnabled: false });

    expect(result).toBe('ok');

    // A short-circuit message must be written to stderr.
    const allOutput = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(allOutput).toContain('short-circuit (state-md-lock.enabled: false)');

    // No lock file must have been created in any tmp dir for this test —
    // verify by checking our isolated repoRoot which the caller would use.
    const lockPath = join(repoRoot, '.orchestrator', 'state.lock');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('short-circuits when CLAUDE.md contains state-md-lock: enabled: false', async () => {
    // Write a CLAUDE.md with state-md-lock disabled in Session Config block.
    writeFileSync(
      join(repoRoot, 'CLAUDE.md'),
      [
        '## Session Config',
        '',
        'state-md-lock:',
        '  enabled: false',
        '  timeout-ms: 10000',
      ].join('\n'),
      'utf8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Pass repoRoot so the function reads our local CLAUDE.md, no per-call override.
    const result = await withStateMdLock(repoRoot, async () => 'ok');

    expect(result).toBe('ok');

    // Short-circuit message must appear in stderr.
    const allOutput = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(allOutput).toContain('short-circuit (state-md-lock.enabled: false)');
  });

  it('acquires the lock normally when no CLAUDE.md is present (defaults to enabled: true)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // No CLAUDE.md in repoRoot — config defaults to enabled: true.
    const result = await withStateMdLock(repoRoot, async () => 'ok');

    expect(result).toBe('ok');

    // No short-circuit message should appear.
    const allOutput = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(allOutput).not.toContain('short-circuit');
  });
});
