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
 * Build a directory tree for the readdirSync stub.
 *
 * @param {Record<string, Array<string|[string, boolean]>>} spec
 *   Absolute dir path → child names. A bare string is a directory; a
 *   `[name, false]` tuple is a non-directory entry.
 * @returns {Map<string, Array<{name: string, isDirectory: () => boolean}>>}
 */
function tree(spec) {
  const m = new Map();
  for (const [dir, names] of Object.entries(spec)) {
    m.set(dir, names.map((n) => (Array.isArray(n) ? dirent(n[0], n[1]) : dirent(n))));
  }
  return m;
}

/**
 * Build a deps bundle for enumerateCandidates. Every fs/lock/config seam is a
 * pure in-memory stub so a single test fully determines the SUT's inputs.
 *
 * The readdirSync stub is keyed BY DIRECTORY (issue #832): the SUT now walks
 * recursively, so a stub that ignored `dir` and returned the same array for
 * every path would turn each fixture into a maxDepth-deep fanout tree and make
 * `toHaveLength(1)` assertions pass (or fail) for entirely the wrong reason.
 * `entries` seeds ROOT; any directory not present in `dirs` reads as empty.
 *
 * The returned bundle carries two inspection arrays for spy-style assertions:
 *   `readdirCalls` — every dir passed to readdirSync, in call order.
 *   `guardCalls`   — every `[path, root]` pair passed to the confinement guard.
 *
 * @param {object} opts
 * @param {Array} [opts.entries]      — readdirSync(ROOT) result (Dirent[]).
 * @param {Map<string,Array>} [opts.dirs] — dirAbs → Dirent[] for deeper levels.
 * @param {string} [opts.root]        — which dir `entries` seeds (default ROOT).
 * @param {Set<string>} [opts.gitRepos] — abs child paths whose `<child>/.git` "exists".
 * @param {Map<string,object|null>} [opts.locks] — repoRoot → lock body (null = no lock).
 * @param {Function} [opts.isLockLive] — isLockLive(lock, nowMs) → boolean.
 * @param {Array} [opts.crossRepo]    — getCrossRepoProjects() resolved value.
 * @param {Set<string>} [opts.rejectInside] — abs paths the confinement guard rejects.
 * @param {Set<string>} [opts.guardThrowsFor] — abs paths for which the guard throws EACCES.
 * @param {boolean} [opts.readdirThrows] — when true, readdirSync throws for EVERY dir.
 * @param {Set<string>} [opts.readdirThrowsFor] — dirs for which readdirSync throws.
 */
function makeDeps({
  entries = [],
  dirs,
  root = ROOT,
  gitRepos = new Set(),
  locks = new Map(),
  isLockLive,
  crossRepo = [],
  rejectInside = new Set(),
  guardThrowsFor = new Set(),
  readdirThrows = false,
  readdirThrowsFor = new Set(),
} = {}) {
  const byDir = new Map(dirs ?? []);
  // ROOT keeps `entries` as its value so every pre-#832 test retains its meaning.
  if (!byDir.has(root)) byDir.set(root, entries);

  const readdirCalls = [];
  const guardCalls = [];

  return {
    readdirCalls,
    guardCalls,
    readdirSync(dir, _opts) {
      readdirCalls.push(dir);
      if (readdirThrows || readdirThrowsFor.has(dir)) {
        const err = new Error(`ENOENT: ${dir}`);
        err.code = 'ENOENT';
        throw err;
      }
      return byDir.get(dir) ?? [];
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
    validatePathInsideProject(childAbs, guardRoot) {
      guardCalls.push([childAbs, guardRoot]);
      if (guardThrowsFor.has(childAbs)) {
        const err = new Error(`EACCES: permission denied, ${childAbs}`);
        err.code = 'EACCES';
        throw err;
      }
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
// Recursive walk + depth cap (issue #832)
// ===========================================================================

describe('enumerateCandidates — recursive walk (#832)', () => {
  // The headline fake-regression fixture: the real host topology is
  // ~/Projects/<org>/<repo>, so a depth-1 scan finds nothing here. Reverting
  // the walk to a flat readdir turns this test RED.
  const ORG = path.join(ROOT, 'org');
  const DEEP_REPO = path.join(ORG, 'deep-repo');

  function twoLevelDeps(extra = {}) {
    return makeDeps({
      entries: [dirent('org')],
      dirs: tree({ [ORG]: ['deep-repo'] }),
      // `org` itself is NOT a repo — only the grandchild is.
      gitRepos: new Set([path.join(DEEP_REPO, '.git')]),
      locks: new Map(),
      isLockLive: () => false,
      ...extra,
    });
  }

  it('maxDepth:1 finds nothing in an <org>/<repo> tree (pre-#832 behaviour)', async () => {
    const out = await enumerateCandidates({
      startDir: ROOT, now: FIXED_NOW, maxDepth: 1, deps: twoLevelDeps(),
    });

    expect(out).toEqual([]);
  });

  it('maxDepth:2 finds exactly the grandchild repo in an <org>/<repo> tree', async () => {
    const out = await enumerateCandidates({
      startDir: ROOT, now: FIXED_NOW, maxDepth: 2, deps: twoLevelDeps(),
    });

    expect(out).toHaveLength(1);
    expect(out[0].repoRoot).toBe(DEEP_REPO);
    expect(out[0].repoName).toBe('deep-repo');
    expect(out[0].status).toBe('frei');
  });

  it('defaults to depth 2 when maxDepth is omitted', async () => {
    const out = await enumerateCandidates({
      startDir: ROOT, now: FIXED_NOW, deps: twoLevelDeps(),
    });

    expect(out).toHaveLength(1);
    expect(out[0].repoRoot).toBe(DEEP_REPO);
  });

  it('hard cap: a depth-3 repo is missed at maxDepth 2 and found at maxDepth 3', async () => {
    const a = path.join(ROOT, 'a');
    const b = path.join(a, 'b');
    const cRepo = path.join(b, 'c-repo');
    const build = () => makeDeps({
      entries: [dirent('a')],
      dirs: tree({ [a]: ['b'], [b]: ['c-repo'] }),
      gitRepos: new Set([path.join(cRepo, '.git')]),
      isLockLive: () => false,
    });

    const atTwo = await enumerateCandidates({
      startDir: ROOT, now: FIXED_NOW, maxDepth: 2, deps: build(),
    });
    const atThree = await enumerateCandidates({
      startDir: ROOT, now: FIXED_NOW, maxDepth: 3, deps: build(),
    });

    expect(atTwo).toEqual([]);
    expect(atThree).toHaveLength(1);
    expect(atThree[0].repoRoot).toBe(cRepo);
  });

  it('does NOT stop descending at a repo: an umbrella repo AND its inner repo are both returned', async () => {
    // Pins the measured umbrella-repo case: an org-level directory that is
    // itself a small git repo while also containing independent repos. An
    // early-exit-on-.git walk would return only `umbrella` and lose `inner`.
    const umbrella = path.join(ROOT, 'umbrella');
    const inner = path.join(umbrella, 'inner');
    const deps = makeDeps({
      entries: [dirent('umbrella')],
      dirs: tree({ [umbrella]: ['inner'] }),
      gitRepos: new Set([
        path.join(umbrella, '.git'),
        path.join(inner, '.git'),
      ]),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out.map((c) => c.repoRoot).sort()).toEqual([umbrella, inner].sort());
  });

  it('dedupes a repo reachable from BOTH the deep walk and the cross-repo config', async () => {
    const deps = twoLevelDeps({ crossRepo: [DEEP_REPO] });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].repoRoot).toBe(DEEP_REPO);
  });

  it('resolves a dead lease on a depth-2 repo as force-closed (the #676/#716 sweep gap)', async () => {
    const deps = twoLevelDeps({
      locks: new Map([[DEEP_REPO, deadLock('dead-deep')]]),
      isLockLive: (lock, nowMs) => {
        const hb = Date.parse(lock.last_heartbeat);
        return nowMs - hb < lock.ttl_hours * 3600 * 1000;
      },
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('force-closed');
    expect(out[0].free).toBe(false);
    expect(out[0].sessionId).toBe('dead-deep');
  });
});

// ===========================================================================
// Descent pruning (#832)
// ===========================================================================

describe('enumerateCandidates — descent pruning', () => {
  it('never descends into node_modules, so a vendored .git there is not a candidate', async () => {
    const a = path.join(ROOT, 'a');
    const nm = path.join(a, 'node_modules');
    const vendored = path.join(nm, 'x-repo');
    const deps = makeDeps({
      entries: [dirent('a')],
      dirs: tree({ [a]: ['node_modules'], [nm]: ['x-repo'] }),
      gitRepos: new Set([path.join(vendored, '.git')]),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({
      startDir: ROOT, now: FIXED_NOW, maxDepth: 3, deps,
    });

    expect(out).toEqual([]);
    // Pruning happens at the DESCENT decision — node_modules is never opened.
    expect(deps.readdirCalls).not.toContain(nm);
  });

  it('never descends into a dot-directory', async () => {
    const a = path.join(ROOT, 'a');
    const hidden = path.join(a, '.cache');
    const buried = path.join(hidden, 'y-repo');
    const deps = makeDeps({
      entries: [dirent('a')],
      dirs: tree({ [a]: ['.cache'], [hidden]: ['y-repo'] }),
      gitRepos: new Set([path.join(buried, '.git')]),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({
      startDir: ROOT, now: FIXED_NOW, maxDepth: 3, deps,
    });

    expect(out).toEqual([]);
    expect(deps.readdirCalls).not.toContain(hidden);
  });

  it('the skip-list gates descent only — a depth-1 dot-dir that IS a repo is still emitted', async () => {
    // Guards the "depth-1 contract stays byte-identical" invariant: pruning must
    // not remove a node from EMISSION, only from descent.
    const dotRepo = path.join(ROOT, '.dot-repo');
    const deps = makeDeps({
      entries: [dirent('.dot-repo')],
      gitRepos: new Set([path.join(dotRepo, '.git')]),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].repoRoot).toBe(dotRepo);
  });
});

// ===========================================================================
// maxDepth clamping (#832)
// ===========================================================================

describe('enumerateCandidates — maxDepth clamping', () => {
  const a = path.join(ROOT, 'a');
  const b = path.join(a, 'b');
  const cRepo = path.join(b, 'c-repo');
  const orgRepo = path.join(a, 'shallow-repo');

  /** Tree carrying BOTH a depth-2 repo and a depth-3 repo. */
  function depthProbeDeps() {
    return makeDeps({
      entries: [dirent('a')],
      dirs: tree({ [a]: ['b', 'shallow-repo'], [b]: ['c-repo'] }),
      gitRepos: new Set([
        path.join(orgRepo, '.git'),
        path.join(cRepo, '.git'),
      ]),
      isLockLive: () => false,
    });
  }

  async function reposAt(maxDepth) {
    const out = await enumerateCandidates({
      startDir: ROOT, now: FIXED_NOW, maxDepth, deps: depthProbeDeps(),
    });
    return out.map((c) => c.repoRoot).sort();
  }

  it('0 falls back to the default depth of 2', async () => {
    expect(await reposAt(0)).toEqual([orgRepo]);
  });

  it('-1 falls back to the default depth of 2', async () => {
    expect(await reposAt(-1)).toEqual([orgRepo]);
  });

  it('NaN falls back to the default depth of 2', async () => {
    expect(await reposAt(NaN)).toEqual([orgRepo]);
  });

  it("the STRING '3' is not coerced — it falls back to the default depth of 2", async () => {
    // Discriminating assertion: a coercing implementation would find c-repo.
    expect(await reposAt('3')).toEqual([orgRepo]);
    expect(await reposAt(3)).toEqual([orgRepo, cRepo].sort());
  });

  it('undefined falls back to the default depth of 2', async () => {
    expect(await reposAt(undefined)).toEqual([orgRepo]);
  });

  it('a value above the ceiling clamps to 3 rather than walking deeper', async () => {
    const deep = path.join(cRepo, 'd', 'e-repo');
    const deps = makeDeps({
      entries: [dirent('a')],
      dirs: tree({
        [a]: ['b'],
        [b]: ['c-repo'],
        [cRepo]: ['d'],
        [path.join(cRepo, 'd')]: ['e-repo'],
      }),
      gitRepos: new Set([path.join(cRepo, '.git'), path.join(deep, '.git')]),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({
      startDir: ROOT, now: FIXED_NOW, maxDepth: 99, deps,
    });

    // Clamped to 3 → c-repo (depth 3) yes, e-repo (depth 5) no.
    expect(out.map((c) => c.repoRoot)).toEqual([cRepo]);
  });
});

// ===========================================================================
// Security invariants of the recursive walk (#832)
// ===========================================================================

describe('enumerateCandidates — walk security invariants', () => {
  it('a guard-rejected node is never DESCENDED into, not merely never emitted', async () => {
    // Invariant (ii): pre-#832 the guard ran only after isGitRepo passed, which
    // was safe because a non-repo dir was never opened. Under recursion an
    // unguarded node WOULD be opened — so refusal must cover descent too.
    const escape = path.join(ROOT, 'escape');
    const hidden = path.join(escape, 'repo');
    const deps = makeDeps({
      entries: [dirent('escape'), dirent('ok')],
      dirs: tree({ [escape]: ['repo'], [path.join(ROOT, 'ok')]: [] }),
      gitRepos: new Set([path.join(hidden, '.git')]),
      rejectInside: new Set([escape]),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toEqual([]);
    // The load-bearing assertion: the rejected subtree was never opened.
    expect(deps.readdirCalls).not.toContain(escape);
    expect(deps.readdirCalls).toContain(ROOT);
  });

  it('validates every node against the ORIGINAL root, never against its parent', async () => {
    // Invariant (i): re-rooting per level would validate a symlinked subtree
    // against ITSELF and defeat the guard. realpathSync resolves every
    // intermediate component, so the original root is sufficient at any depth.
    const org = path.join(ROOT, 'org');
    const deepRepo = path.join(org, 'deep-repo');
    const deps = makeDeps({
      entries: [dirent('org')],
      dirs: tree({ [org]: ['deep-repo'] }),
      gitRepos: new Set([path.join(deepRepo, '.git')]),
      isLockLive: () => false,
    });

    await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    const walkCalls = deps.guardCalls.filter(([p]) => p === org || p === deepRepo);
    expect(walkCalls).toEqual([
      [org, ROOT],
      [deepRepo, ROOT],
    ]);
    // Explicit negative: the grandchild is NEVER re-rooted against its parent.
    expect(deps.guardCalls).not.toContainEqual([deepRepo, org]);
  });

  it('a guard that THROWS (EACCES) skips that node without rejecting the promise', async () => {
    // Invariant (iii): path-utils rethrows any non-ENOENT realpath error, and
    // runDispatch has no try/catch around enumerateCandidates.
    const boom = path.join(ROOT, 'mode-000');
    const sibling = path.join(ROOT, 'sibling-repo');
    const deps = makeDeps({
      entries: [dirent('mode-000'), dirent('sibling-repo')],
      gitRepos: new Set([
        path.join(boom, '.git'),
        path.join(sibling, '.git'),
      ]),
      guardThrowsFor: new Set([boom]),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].repoRoot).toBe(sibling);
  });

  it('readdir throwing on a SUBdirectory skips that subtree and preserves siblings', async () => {
    const bad = path.join(ROOT, 'bad');
    const good = path.join(ROOT, 'good');
    const goodRepo = path.join(good, 'nested-repo');
    const deps = makeDeps({
      entries: [dirent('bad'), dirent('good')],
      dirs: tree({ [good]: ['nested-repo'] }),
      gitRepos: new Set([path.join(goodRepo, '.git')]),
      readdirThrowsFor: new Set([bad]),
      isLockLive: () => false,
    });

    const out = await enumerateCandidates({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(out).toHaveLength(1);
    expect(out[0].repoRoot).toBe(goodRepo);
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
