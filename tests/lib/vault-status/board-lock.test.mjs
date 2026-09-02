/**
 * board-lock.test.mjs — coverage for scripts/lib/vault-status/board-lock.mjs
 * (issue #1180). The board is ONE file shared by every repo on the host; this
 * lock is what turns its read-modify-write into a critical section.
 *
 * Portable + hermetic: every lock lives under a `mkdtempSync(tmpdir())` vault
 * stand-in. Nothing here resolves `vault-integration.vault-dir`, so the
 * operator's real vault is never a possible target.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, utimesSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boardLockPathFor, withBoardLock } from '../../../scripts/lib/vault-status/board-lock.mjs';
import { tryAcquireFileLock, releaseFileLock } from '../../../scripts/lib/file-lock.mjs';

let vaultDir;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'board-lock-test-'));
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('boardLockPathFor', () => {
  it('resolves to <vaultDir>/.orchestrator/board.lock (outside 01-projects, which vault-sync walks)', () => {
    expect(boardLockPathFor(vaultDir)).toBe(join(vaultDir, '.orchestrator', 'board.lock'));
  });
});

describe('withBoardLock', () => {
  // Bug: a wrapper that acquires but never releases (or releases only on the
  // happy path) leaves a lock file behind, so the NEXT board write on this host
  // waits out the full timeout and then writes unlocked — the serialization is
  // silently gone after the first call.
  it('holds the lock while fn runs, releases it afterwards, and releases on throw', async () => {
    const lockPath = boardLockPathFor(vaultDir);
    expect(existsSync(lockPath)).toBe(false);

    let seenDuringFn = null;
    const value = await withBoardLock(vaultDir, () => {
      seenDuringFn = existsSync(lockPath);
      return 'ok';
    });

    expect(seenDuringFn).toBe(true);
    expect(value).toBe('ok');
    expect(existsSync(lockPath)).toBe(false);

    await expect(
      withBoardLock(vaultDir, () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  // Bug: no mutual exclusion — two board writers interleave their
  // read-modify-write and the later writer's merge base is already obsolete.
  it('makes a second acquirer wait until the first releases', async () => {
    const order = [];

    const first = withBoardLock(vaultDir, async () => {
      order.push('A-enter');
      await delay(120);
      order.push('A-exit');
    }, { pollMs: 5 });

    await delay(20); // let A win the race deterministically
    const second = withBoardLock(vaultDir, async () => {
      order.push('B-enter');
      order.push('B-exit');
    }, { pollMs: 5, timeoutMs: 3000 });

    await Promise.all([first, second]);

    expect(order).toEqual(['A-enter', 'A-exit', 'B-enter', 'B-exit']);
  });

  // Bug: a crashed writer's lock file would block every subsequent board write
  // for the rest of the host's uptime. `staleCheck: 'mtime'` (not 'pid' — the
  // vault may be shared across hosts) must age it out.
  it('overrides a stale lock whose mtime is older than staleMs', async () => {
    const lockPath = boardLockPathFor(vaultDir);
    const acquired = tryAcquireFileLock(lockPath, {
      staleCheck: 'mtime',
      staleMs: 60_000,
      holder: 'dead-writer',
      indent: 2,
      tmpPrefix: '.board.lock',
      warn: () => {},
    });
    expect(acquired.acquired).toBe(true);

    // Backdate the lock file: 10 minutes old.
    const old = new Date(Date.now() - 600_000);
    utimesSync(lockPath, old, old);

    let ran = false;
    const outcomes = [];
    await withBoardLock(vaultDir, () => { ran = true; }, {
      timeoutMs: 200,
      pollMs: 5,
      staleMs: 60_000,
      onLockOutcome: (o) => outcomes.push(o),
      warn: () => {},
    });

    expect(ran).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].locked).toBe(true);
    // The override is the ONE event that can silently break the mutex (a live
    // writer whose sweep outran staleMs looks dead). Before this it existed
    // only as a prose WARN in file-lock's sink — unaggregatable, so the
    // DEFAULT_STALE_MS revisit trigger had no observable. It must reach the
    // diagnostic outcome, and still ride the SAME single call.
    expect(typeof outcomes[0].staleOverride).toBe('string');
    expect(outcomes[0].staleOverride.length).toBeGreaterThan(0);
    expect(existsSync(lockPath)).toBe(false); // released by us, not leaked
  });

  // Bug: a lock that THROWS or skips fn on contention would abort a session
  // phase over best-effort telemetry. Fail-open is the contract — but it must
  // announce itself exactly once, never silently.
  it('fails open on acquire timeout: runs fn unlocked and warns exactly once', async () => {
    const lockPath = boardLockPathFor(vaultDir);
    const held = tryAcquireFileLock(lockPath, {
      staleCheck: 'mtime',
      staleMs: 60_000,
      holder: 'live-writer',
      indent: 2,
      tmpPrefix: '.board.lock',
      warn: () => {},
    });
    expect(held.acquired).toBe(true);

    const warns = [];
    const outcomes = [];
    const value = await withBoardLock(vaultDir, () => 'ran-anyway', {
      timeoutMs: 30,
      pollMs: 5,
      staleMs: 60_000,
      warn: (m) => warns.push(m),
      onLockOutcome: (o) => outcomes.push(o),
    });

    expect(value).toBe('ran-anyway');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/withBoardLock: timeout/);
    expect(outcomes).toEqual([{ locked: false, lockPath, reason: 'timeout' }]);

    // The foreign holder's lock is untouched (PSA-003: never delete a lock we
    // do not own).
    expect(existsSync(lockPath)).toBe(true);
    releaseFileLock(lockPath, { holder: 'live-writer' });
  });

  // Bug: the fail-open contract is written for TWO failure classes — acquire
  // timeout AND fs-error — and only the timeout half was pinned. An fs-error
  // arrives through a different branch of `tryAcquireFileLock` (the mkdir/link
  // throws, there is no holder to poll), so a wrapper that handles only
  // `reason: 'timeout'` would throw EACCES straight through and abort the
  // session phase over best-effort telemetry.
  it('fails open on a NON-WRITABLE lock directory: runs fn, one WARN, reason fs-error', async () => {
    // Root ignores mode bits, so the chmod would not deny anything and the test
    // would assert the happy path under a failure name.
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (process.platform === 'win32' || isRoot) return;

    const orchDir = join(vaultDir, '.orchestrator');
    mkdirSync(orchDir, { recursive: true });
    chmodSync(orchDir, 0o500); // r-x: the lock file cannot be created inside

    const warns = [];
    const outcomes = [];
    try {
      const value = await withBoardLock(vaultDir, () => 'ran-anyway', {
        timeoutMs: 200,
        pollMs: 5,
        warn: (m) => warns.push(m),
        onLockOutcome: (o) => outcomes.push(o),
      });

      expect(value).toBe('ran-anyway');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/withBoardLock: fs-error/);
      expect(outcomes).toEqual([
        { locked: false, lockPath: boardLockPathFor(vaultDir), reason: 'fs-error' },
      ]);
      expect(existsSync(boardLockPathFor(vaultDir))).toBe(false);
    } finally {
      chmodSync(orchDir, 0o700); // else afterEach's rmSync cannot clean up
    }
  });

  it('rejects a non-function fn', async () => {
    await expect(withBoardLock(vaultDir, null)).rejects.toThrow(TypeError);
  });
});
