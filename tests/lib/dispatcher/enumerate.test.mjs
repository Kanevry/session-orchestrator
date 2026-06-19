/**
 * enumerate.test.mjs — coverage for scripts/lib/dispatcher/enumerate.mjs
 * (Epic #673 Phase 2, issue #676). Candidate-repo enumeration + free/busy
 * resolution from each repo's session.lock v2 lease.
 *
 * The SUT is fully dependency-injected via the `deps` arg, so these tests stub
 * readdirSync / existsSync / readLock / isLockLive / getCrossRepoProjects /
 * validatePathInsideProject directly — they never touch the real ~/Projects
 * filesystem or the host session registry. Portable: no hardcoded home paths
 * (the CI owner-leakage scanner blocks those). Imported by relative path
 * (tests/lib/dispatcher → repo root is 3 levels up).
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';

import {
  enumerateCandidates,
  freeCandidates,
} from '../../../scripts/lib/dispatcher/enumerate.mjs';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

// Deterministic clock seam. ttl math below is anchored to this instant.
const FIXED_NOW = new Date('2026-06-18T20:00:00Z').getTime();

// A POSIX-absolute scan root used for the DI-stub path. Never resolves against
// the real fs because readdirSync/existsSync are stubbed.
const ROOT = '/sandbox/projects';

/** A fake Dirent for the withFileTypes:true readdir stub. */
function dirent(name, isDir = true) {
  return { name, isDirectory: () => isDir };
}

/**
 * Build a deps bundle for enumerateCandidates. Every fs/lock/config seam is a
 * pure in-memory stub so a single test fully determines the SUT's inputs.
 *
 * @param {object} opts
 * @param {Array} [opts.entries]      — readdirSync(root) result (Dirent[]).
 * @param {Set<string>} [opts.gitRepos] — abs child paths whose `<child>/.git` "exists".
 * @param {Map<string,object|null>} [opts.locks] — repoRoot → lock body (null = no lock).
 * @param {Function} [opts.isLockLive] — isLockLive(lock, nowMs) → boolean.
 * @param {Array} [opts.crossRepo]    — getCrossRepoProjects() resolved value.
 * @param {Set<string>} [opts.rejectInside] — abs paths the confinement guard rejects.
 * @param {boolean} [opts.readdirThrows] — when true, readdirSync throws (unreadable root).
 */
function makeDeps({
  entries = [],
  gitRepos = new Set(),
  locks = new Map(),
  isLockLive,
  crossRepo = [],
  rejectInside = new Set(),
  readdirThrows = false,
} = {}) {
  return {
    readdirSync(dir, _opts) {
      if (readdirThrows) {
        const err = new Error(`ENOENT: ${dir}`);
        err.code = 'ENOENT';
        throw err;
      }
      return entries;
    },
    existsSync(p) {
      // `<child>/.git` membership encodes which children are git repos.
      return gitRepos.has(p);
    },
    readLock({ repoRoot }) {
      return locks.has(repoRoot) ? locks.get(repoRoot) : null;
    },
    isLockLive: isLockLive ?? (() => false),
    async getCrossRepoProjects() {
      return crossRepo;
    },
    validatePathInsideProject(childAbs) {
      return rejectInside.has(childAbs) ? { ok: false } : { ok: true };
    },
  };
}

/** A live lock body: heartbeat recent, ttl wide. */
function liveLock(sessionId = 'sess-live') {
  return {
    session_id: sessionId,
    last_heartbeat: new Date(FIXED_NOW).toISOString(),
    ttl_hours: 4,
  };
}

/** A dead-lease lock body: present but heartbeat older than ttl. */
function deadLock(sessionId = 'sess-dead') {
  return {
    session_id: sessionId,
    // 5h ago against a 4h ttl.
    last_heartbeat: new Date(FIXED_NOW - 5 * 3600 * 1000).toISOString(),
    ttl_hours: 4,
  };
}

// ===========================================================================
// Free/busy three-way resolution
// ===========================================================================

describe('enumerateCandidates — free/busy resolution', () => {
  it('live lock → status in-progress, free:false (busy)', async () => {
    const repo = path.resolve(ROOT, 'busy-live');
    const deps = makeDeps({
      entries: [dirent('busy-live')],
      gitRepos: new Set([path.join(ROOT, 'busy-live', '.git')]),
      locks: new Map([[repo, liveLock('live-1')]]),
      isLockLive: () => true,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('in-progress');
    expect(out[0].free).toBe(false);
    expect(out[0].sessionId).toBe('live-1');
  });

  it('dead lease (heartbeat past ttl) → status force-closed, free:false (busy)', async () => {
    const repo = path.resolve(ROOT, 'busy-dead');
    const deadBody = deadLock('dead-7');
    const deps = makeDeps({
      entries: [dirent('busy-dead')],
      gitRepos: new Set([path.join(ROOT, 'busy-dead', '.git')]),
      locks: new Map([[repo, deadBody]]),
      // Real liveness predicate: heartbeat 5h ago vs 4h ttl → not live.
      isLockLive: (lock, nowMs) => {
        const hb = Date.parse(lock.last_heartbeat);
        return nowMs - hb < lock.ttl_hours * 3600 * 1000;
      },
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('force-closed');
    expect(out[0].free).toBe(false);
    // Dead lock fields are preserved, not nulled.
    expect(out[0].sessionId).toBe('dead-7');
    expect(out[0].heartbeat).toBe(deadBody.last_heartbeat);
  });

  it('no lock → status frei, free:true with null heartbeat/session', async () => {
    const deps = makeDeps({
      entries: [dirent('idle')],
      gitRepos: new Set([path.join(ROOT, 'idle', '.git')]),
      locks: new Map(), // readLock returns null
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('frei');
    expect(out[0].free).toBe(true);
    expect(out[0].heartbeat).toBeNull();
    expect(out[0].sessionId).toBeNull();
  });

  it('sessionId prefers semantic_session_id over session_id', async () => {
    const repo = path.resolve(ROOT, 'semantic');
    const deps = makeDeps({
      entries: [dirent('semantic')],
      gitRepos: new Set([path.join(ROOT, 'semantic', '.git')]),
      locks: new Map([[repo, {
        session_id: 'uuid-123',
        semantic_session_id: 'deep-1647',
        last_heartbeat: new Date(FIXED_NOW).toISOString(),
        ttl_hours: 4,
      }]]),
      isLockLive: () => true,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out[0].sessionId).toBe('deep-1647');
  });
});

// ===========================================================================
// Busy repos are LISTED, not dropped
// ===========================================================================

describe('enumerateCandidates — busy repos listed not dropped', () => {
  it('returns all three of frei + in-progress + force-closed with correct free flags', async () => {
    const liveRepo = path.resolve(ROOT, 'b-live');
    const deadRepo = path.resolve(ROOT, 'c-dead');
    const deps = makeDeps({
      entries: [dirent('a-free'), dirent('b-live'), dirent('c-dead')],
      gitRepos: new Set([
        path.join(ROOT, 'a-free', '.git'),
        path.join(ROOT, 'b-live', '.git'),
        path.join(ROOT, 'c-dead', '.git'),
      ]),
      locks: new Map([
        [liveRepo, liveLock('live')],
        [deadRepo, deadLock('dead')],
        // a-free has no lock.
      ]),
      isLockLive: (lock) => lock.session_id === 'live',
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    // All three appear — busy ones are not filtered out here.
    expect(out).toHaveLength(3);
    const byName = Object.fromEntries(out.map((c) => [c.repoName, c]));
    expect(byName['a-free'].status).toBe('frei');
    expect(byName['a-free'].free).toBe(true);
    expect(byName['b-live'].status).toBe('in-progress');
    expect(byName['b-live'].free).toBe(false);
    expect(byName['c-dead'].status).toBe('force-closed');
    expect(byName['c-dead'].free).toBe(false);
  });
});

// ===========================================================================
// Confinement guard
// ===========================================================================

describe('enumerateCandidates — confinement guard', () => {
  it('excludes a child the guard rejects (ok:false), keeps the accepted sibling', async () => {
    const escapeChild = path.join(ROOT, 'escape');
    const deps = makeDeps({
      entries: [dirent('escape'), dirent('inside')],
      gitRepos: new Set([
        path.join(ROOT, 'escape', '.git'),
        path.join(ROOT, 'inside', '.git'),
      ]),
      locks: new Map(),
      isLockLive: () => false,
      rejectInside: new Set([escapeChild]),
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].repoName).toBe('inside');
  });

  it('excludes a child even when guard returns a falsy value (null)', async () => {
    const deps = {
      ...makeDeps({
        entries: [dirent('nullguard')],
        gitRepos: new Set([path.join(ROOT, 'nullguard', '.git')]),
      }),
      validatePathInsideProject() {
        return null;
      },
    };

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toEqual([]);
  });
});

// ===========================================================================
// Config-declared secondary union + dedup
// ===========================================================================

describe('enumerateCandidates — config-declared union + dedup', () => {
  it('a config repo also present in the FS scan appears exactly once', async () => {
    const shared = path.resolve(ROOT, 'shared');
    const deps = makeDeps({
      entries: [dirent('shared')],
      gitRepos: new Set([path.join(ROOT, 'shared', '.git')]),
      locks: new Map(),
      isLockLive: () => false,
      // Config declares the same resolved path again.
      crossRepo: [shared],
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    // Dedup by path.resolve → one entry, not two.
    expect(out).toHaveLength(1);
    expect(out[0].repoRoot).toBe(shared);
  });

  it('a config-declared repo NOT in the FS scan is unioned in (still confinement-filtered)', async () => {
    const extra = path.resolve(ROOT, 'extra-config');
    const deps = makeDeps({
      entries: [dirent('fs-only')],
      gitRepos: new Set([path.join(ROOT, 'fs-only', '.git')]),
      locks: new Map(),
      isLockLive: () => false,
      crossRepo: [extra],
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(2);
    const names = out.map((c) => c.repoName).sort();
    expect(names).toEqual(['extra-config', 'fs-only']);
  });

  it('a config-declared repo rejected by the confinement guard is excluded', async () => {
    const outside = path.resolve('/elsewhere/rogue');
    const deps = makeDeps({
      entries: [],
      gitRepos: new Set(),
      crossRepo: [outside],
      rejectInside: new Set([outside]),
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toEqual([]);
  });
});

// ===========================================================================
// Unreadable / absent startDir
// ===========================================================================

describe('enumerateCandidates — unreadable startDir', () => {
  it('readdir throwing → returns [] (does not crash)', async () => {
    const deps = makeDeps({ readdirThrows: true });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toEqual([]);
  });

  it('readdir throwing but config still declares a valid repo → only the config repo', async () => {
    const cfg = path.resolve(ROOT, 'cfg-repo');
    const deps = makeDeps({
      readdirThrows: true,
      crossRepo: [cfg],
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].repoRoot).toBe(cfg);
  });
});

// ===========================================================================
// .git as a FILE (worktree / submodule)
// ===========================================================================

describe('enumerateCandidates — .git detection', () => {
  it('detects a repo whose .git is a FILE (existsSync true) the same as a dir', async () => {
    // existsSync returns true for `<child>/.git` regardless of file-vs-dir;
    // the SUT only checks existence, so a worktree pointer file is a repo.
    const deps = makeDeps({
      entries: [dirent('worktree')],
      gitRepos: new Set([path.join(ROOT, 'worktree', '.git')]),
      locks: new Map(),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].repoName).toBe('worktree');
  });

  it('a child without a .git entry is not a repo and is excluded', async () => {
    const deps = makeDeps({
      entries: [dirent('not-a-repo'), dirent('real-repo')],
      // Only real-repo has a .git.
      gitRepos: new Set([path.join(ROOT, 'real-repo', '.git')]),
      locks: new Map(),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].repoName).toBe('real-repo');
  });

  it('a non-directory entry (Dirent.isDirectory false) is skipped', async () => {
    const deps = makeDeps({
      entries: [dirent('a-file.txt', false), dirent('a-repo', true)],
      gitRepos: new Set([
        // Even if a stray `.git` existed for the file entry, isDirectory:false skips it first.
        path.join(ROOT, 'a-file.txt', '.git'),
        path.join(ROOT, 'a-repo', '.git'),
      ]),
      locks: new Map(),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].repoName).toBe('a-repo');
  });
});

// ===========================================================================
// freeCandidates filter
// ===========================================================================

describe('freeCandidates', () => {
  it('returns only entries with free:true', () => {
    const candidates = [
      { repoName: 'x', free: true, status: 'frei' },
      { repoName: 'y', free: false, status: 'in-progress' },
      { repoName: 'z', free: true, status: 'frei' },
      { repoName: 'w', free: false, status: 'force-closed' },
    ];

    const out = freeCandidates(candidates);

    expect(out).toHaveLength(2);
    expect(out.map((c) => c.repoName)).toEqual(['x', 'z']);
  });

  it('returns [] when given a non-array', () => {
    expect(freeCandidates(undefined)).toEqual([]);
    expect(freeCandidates(null)).toEqual([]);
    expect(freeCandidates('nope')).toEqual([]);
  });

  it('drops null/undefined members defensively', () => {
    const out = freeCandidates([null, { free: true, repoName: 'ok' }, undefined]);
    expect(out).toHaveLength(1);
    expect(out[0].repoName).toBe('ok');
  });

  it('integrates with enumerateCandidates: filters a mixed result to the free one', async () => {
    const liveRepo = path.resolve(ROOT, 'live');
    const deps = makeDeps({
      entries: [dirent('free'), dirent('live')],
      gitRepos: new Set([
        path.join(ROOT, 'free', '.git'),
        path.join(ROOT, 'live', '.git'),
      ]),
      locks: new Map([[liveRepo, liveLock('s')]]),
      isLockLive: (lock) => !!lock,
    });

    const all = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });
    const free = freeCandidates(all);

    expect(all).toHaveLength(2);
    expect(free).toHaveLength(1);
    expect(free[0].repoName).toBe('free');
    expect(free[0].free).toBe(true);
  });
});
