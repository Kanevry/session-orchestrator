/**
 * lock-reaper.test.mjs — coverage for scripts/lib/lock-reaper.mjs (Epic #724 C7).
 *
 * Uses REAL tmp fixture repos (the reap action archive-moves real files), and
 * injects only the host/pid/event seams so the tests are deterministic and never
 * touch the real ~/Projects fleet. The confinement guard + config union are
 * stubbed out via enumerateDeps so the scan stays confined to the tmp startDir.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reapStaleLocks, reapRepoLock } from '@lib/lock-reaper.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOST = 'reaper-test-host';
const NOW = new Date('2026-07-02T12:00:00Z').getTime();

const tmpDirs = [];

function makeStartDir() {
  const d = mkdtempSync(join(tmpdir(), 'lock-reaper-'));
  tmpDirs.push(d);
  return d;
}

/** Build a lock body with a heartbeat `offsetHours` before NOW. */
function lockBody({
  host = HOST,
  offsetHours = 0,
  sessionId = 'sess',
  semantic,
  pid = 999999,
  ttl = 4,
} = {}) {
  const hb = new Date(NOW - offsetHours * 3600 * 1000).toISOString();
  const body = {
    session_id: sessionId,
    started_at: hb,
    last_heartbeat: hb,
    mode: 'deep',
    pid,
    host,
    ttl_hours: ttl,
  };
  if (semantic) body.semantic_session_id = semantic;
  return body;
}

/** Create a real git-repo fixture with an optional session.lock. */
function makeRepo(startDir, name, lock) {
  const repo = join(startDir, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  if (lock) {
    mkdirSync(join(repo, '.orchestrator'), { recursive: true });
    writeFileSync(join(repo, '.orchestrator', 'session.lock'), JSON.stringify(lock, null, 2) + '\n');
  }
  return repo;
}

const lockFileOf = (repo) => join(repo, '.orchestrator', 'session.lock');
const reapedDirOf = (repo) => join(repo, '.orchestrator', 'tmp', 'reaped-locks');

/** enumerate DI: keep the scan confined to the tmp fixture (no real config/guard). */
function enumerateDeps() {
  return {
    getCrossRepoProjects: async () => [],
    validatePathInsideProject: () => ({ ok: true }),
  };
}

/** Top-level reaper deps with controllable host/pid/event seams. */
function makeDeps({ pidAlive = false, hostname = HOST } = {}) {
  const emit = vi.fn(async () => {});
  return {
    deps: {
      hostname: () => hostname,
      isPidAliveOnHost: () => pidAlive,
      emitEvent: emit,
      enumerateDeps: enumerateDeps(),
    },
    emit,
  };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

// ===========================================================================
// reapStaleLocks — host-wide reconciliation
// ===========================================================================

describe('reapStaleLocks', () => {
  it('archive-moves an own-host dead-lease lock under --apply and emits the reaped event', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'dead', lockBody({ offsetHours: 5, sessionId: 'ghost-1', semantic: 'deep-99' }));
    const { deps, emit } = makeDeps({ pidAlive: false });

    const out = await reapStaleLocks({ startDir, now: NOW, dryRun: false, deps });

    expect(out.scanned).toBe(1);
    expect(out.reaped).toHaveLength(1);
    expect(out.candidates).toHaveLength(1);
    expect(out.skipped).toHaveLength(0);
    expect(out.dryRun).toBe(false);

    // Invariant (d): archive-move — original gone, archive written.
    expect(existsSync(lockFileOf(repo))).toBe(false);
    expect(existsSync(reapedDirOf(repo))).toBe(true);
    expect(readdirSync(reapedDirOf(repo))).toHaveLength(1);
    expect(out.reaped[0].archivePath).toContain('reaped-locks');
    expect(out.reaped[0].sessionId).toBe('deep-99');

    // Event emitted with reap_mode 'cli'.
    expect(emit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = emit.mock.calls[0];
    expect(eventName).toBe('orchestrator.session.lock.reaped');
    expect(payload.reap_mode).toBe('cli');
    expect(payload.semantic_session_id).toBe('deep-99');
  });

  it('dry-run (default) mutates nothing and emits no event', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'dead', lockBody({ offsetHours: 5 }));
    const { deps, emit } = makeDeps();

    const out = await reapStaleLocks({ startDir, now: NOW, deps }); // dryRun defaults true

    expect(out.dryRun).toBe(true);
    expect(out.candidates).toHaveLength(1);
    expect(out.reaped).toHaveLength(0);
    // Nothing touched.
    expect(existsSync(lockFileOf(repo))).toBe(true);
    expect(existsSync(reapedDirOf(repo))).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('NEVER reaps a live lock (invariant a) — live lock is not even a candidate', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'live', lockBody({ offsetHours: 0, sessionId: 'live-1' }));
    const { deps, emit } = makeDeps();

    const out = await reapStaleLocks({ startDir, now: NOW, dryRun: false, deps });

    expect(out.scanned).toBe(1);
    expect(out.reaped).toHaveLength(0);
    expect(out.candidates).toHaveLength(0);
    expect(existsSync(lockFileOf(repo))).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('NEVER auto-reaps a cross-host dead lock (invariant c) even under --apply', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'foreign', lockBody({ offsetHours: 5, host: 'a-different-host' }));
    const { deps, emit } = makeDeps({ hostname: HOST });

    const out = await reapStaleLocks({ startDir, now: NOW, dryRun: false, deps });

    expect(out.reaped).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe('cross-host-requires-operator');
    // Never touched.
    expect(existsSync(lockFileOf(repo))).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('NEVER reaps an own-host lock whose PID is still alive (invariant b)', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'pid-alive', lockBody({ offsetHours: 5, host: HOST }));
    const { deps } = makeDeps({ pidAlive: true, hostname: HOST });

    const out = await reapStaleLocks({ startDir, now: NOW, dryRun: false, deps });

    expect(out.reaped).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe('own-host-pid-alive');
    expect(existsSync(lockFileOf(repo))).toBe(true);
  });

  it('a per-repo archive failure is reported as an error skip and does NOT unlink the lock', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'boom', lockBody({ offsetHours: 5, host: HOST }));
    const { deps } = makeDeps({ hostname: HOST });
    // Inject an fs whose mkdirSync throws so the archive-move fails before unlink.
    // unlinkSync is spied (not just throwing) so we can assert call-count, not
    // just its exception message.
    const unlinkSpy = vi.fn(() => { throw new Error('should not be reached'); });
    deps.fs = {
      mkdirSync: () => { throw new Error('disk full'); },
      readFileSync: () => '',
      writeFileSync: () => {},
      unlinkSync: unlinkSpy,
    };

    const out = await reapStaleLocks({ startDir, now: NOW, dryRun: false, deps });

    expect(out.reaped).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    // (a) The reason must surface the ACTUAL mkdir failure, not merely match
    // /^error:/ — a reorder mutation (unlink-before-archive) would throw
    // unlinkSync's "should not be reached" message instead, which also matches
    // /^error:/ and would leave that weaker assertion green.
    expect(out.skipped[0].reason).toBe('error: disk full');
    // (b) unlinkSync must NEVER be invoked — proves control flow never reached
    // the unlink step, not merely that *some* error surfaced.
    expect(unlinkSpy).toHaveBeenCalledTimes(0);
    // Invariant (d): archive failed → original lock preserved, never unlink-only.
    expect(existsSync(lockFileOf(repo))).toBe(true);
  });

  it('aborts a reap when the lease changes between the initial read and the destructive unlink (TOCTOU re-check, invariant e)', async () => {
    const startDir = makeStartDir();
    const originalLock = lockBody({ offsetHours: 5, host: HOST, sessionId: 'ghost-2' });
    const repo = makeRepo(startDir, 'toctou', originalLock);
    // Simulates a DIFFERENT session bootstrapping and writing a fresh lock in
    // the window between evaluateRepo's initial read and archiveLock's
    // pre-unlink re-check.
    const freshLock = lockBody({ offsetHours: 0, host: HOST, sessionId: 'fresh-session' });

    let readCount = 0;
    const readLockSpy = vi.fn(() => {
      readCount += 1;
      // Call 1: evaluateRepo's initial lease read. Call 2: archiveLock's
      // pre-unlink TOCTOU re-check.
      return readCount === 1 ? originalLock : freshLock;
    });

    const { deps } = makeDeps({ hostname: HOST });
    deps.readLock = readLockSpy;
    // fs is left at its real default so the archive write itself succeeds —
    // the abort must come from the re-check, not from an fs failure.

    const out = await reapStaleLocks({ startDir, now: NOW, dryRun: false, deps });

    expect(readLockSpy).toHaveBeenCalledTimes(2);
    expect(out.reaped).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe('lock-changed-during-reap');
    // The original lease must be untouched — never unlinked.
    expect(existsSync(lockFileOf(repo))).toBe(true);
    // Best-effort undo removed the archive copy written before the re-check.
    expect(existsSync(reapedDirOf(repo))).toBe(true);
    expect(readdirSync(reapedDirOf(repo))).toHaveLength(0);
  });

  it('classifies a mixed fleet: reaps the dead own-host lock, lists cross-host + pid-alive, ignores live', async () => {
    const startDir = makeStartDir();
    const deadRepo = makeRepo(startDir, 'a-dead', lockBody({ offsetHours: 5, host: HOST, sessionId: 'dead' }));
    makeRepo(startDir, 'b-live', lockBody({ offsetHours: 0, host: HOST, sessionId: 'live' }));
    makeRepo(startDir, 'c-foreign', lockBody({ offsetHours: 5, host: 'elsewhere', sessionId: 'foreign' }));
    makeRepo(startDir, 'd-free', null);
    const { deps } = makeDeps({ pidAlive: false, hostname: HOST });

    const out = await reapStaleLocks({ startDir, now: NOW, dryRun: false, deps });

    expect(out.scanned).toBe(4);
    expect(out.reaped).toHaveLength(1);
    expect(out.reaped[0].repoName).toBe('a-dead');
    expect(existsSync(lockFileOf(deadRepo))).toBe(false);
    // c-foreign is force-closed (dead heartbeat) but cross-host → skipped, not reaped.
    const reasons = out.skipped.map((s) => s.reason).sort();
    expect(reasons).toContain('cross-host-requires-operator');
  });

  it('echoes ownHostOnly in the result and defaults it to true', async () => {
    const startDir = makeStartDir();
    makeRepo(startDir, 'x', null);
    const { deps } = makeDeps();

    const out = await reapStaleLocks({ startDir, now: NOW, deps });
    expect(out.ownHostOnly).toBe(true);
  });
});

// ===========================================================================
// reapRepoLock — single-repo (the SessionStart hook path)
// ===========================================================================

describe('reapRepoLock', () => {
  it('archive-moves a dead own-host lease under !dryRun', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'own', lockBody({ offsetHours: 5, host: HOST, sessionId: 'orphan' }));
    const { deps, emit } = makeDeps({ hostname: HOST });

    const res = await reapRepoLock({ repoRoot: repo, now: NOW, dryRun: false, deps });

    expect(res.action).toBe('reaped');
    expect(existsSync(lockFileOf(repo))).toBe(false);
    expect(existsSync(reapedDirOf(repo))).toBe(true);
    const [, payload] = emit.mock.calls[0];
    expect(payload.reap_mode).toBe('auto-own-repo');
  });

  it('skips a live lock (invariant a) and leaves it untouched', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'own-live', lockBody({ offsetHours: 0, host: HOST }));
    const { deps } = makeDeps({ hostname: HOST });

    const res = await reapRepoLock({ repoRoot: repo, now: NOW, dryRun: false, deps });

    expect(res.action).toBe('skipped');
    expect(res.reason).toBe('live');
    expect(existsSync(lockFileOf(repo))).toBe(true);
  });

  it('never reaps the current session\'s own lease (currentSessionId guard)', async () => {
    const startDir = makeStartDir();
    // Dead heartbeat but it IS our session (matches on semantic id).
    const repo = makeRepo(
      startDir,
      'own-self',
      lockBody({ offsetHours: 5, host: HOST, sessionId: 'uuid-x', semantic: 'main-deep-1' }),
    );
    const { deps } = makeDeps({ hostname: HOST });

    const res = await reapRepoLock({
      repoRoot: repo,
      now: NOW,
      dryRun: false,
      currentSessionId: 'main-deep-1',
      deps,
    });

    expect(res.action).toBe('skipped');
    expect(res.reason).toBe('current-session');
    expect(existsSync(lockFileOf(repo))).toBe(true);
  });

  it('returns none for a missing repoRoot and for a repo with no lock', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'no-lock', null);
    const { deps } = makeDeps();

    const noRoot = await reapRepoLock({ deps });
    expect(noRoot.action).toBe('none');
    expect(noRoot.reason).toBe('no-repo-root');

    const noLock = await reapRepoLock({ repoRoot: repo, now: NOW, deps });
    expect(noLock.action).toBe('none');
    expect(noLock.reason).toBe('no-lock');
  });

  it('surfaces an internal failure as an error skip (outer no-throw guard)', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'throwy', lockBody({ offsetHours: 5, host: HOST }));
    const { deps } = makeDeps({ hostname: HOST });
    // isLockLive throwing propagates out of evaluateRepo → caught by reapRepoLock.
    deps.isLockLive = () => { throw new Error('boom'); };

    const res = await reapRepoLock({ repoRoot: repo, now: NOW, dryRun: false, deps });

    expect(res.action).toBe('skipped');
    expect(res.reason).toMatch(/^error:/);
    expect(existsSync(lockFileOf(repo))).toBe(true);
  });
});
