/**
 * tests/lib/worktree-freshness.test.mjs
 *
 * Integration tests for scripts/lib/worktree-freshness.mjs (issue #195).
 * Verifies base-ref freshness guard decision logic under real git scenarios
 * using tmpdir fixtures. Each test operates against a real git repo.
 *
 * Tests run serially (describe.sequential) to avoid races on shared git state.
 * Timeout is 15 s per test to accommodate git I/O.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// checkWorktreeBaseRefFresh uses execFileSync (not zx), so it picks up process.cwd()
// dynamically. Import at module level is safe — cwd is passed explicitly via `cwd` param.
import { checkWorktreeBaseRefFresh } from '../../scripts/lib/worktree-freshness.mjs';

// Note: createWorktree / removeWorktree use zx which captures cwd at import time.
// The roundtrip test (test 8) imports these in a dedicated beforeAll AFTER chdir,
// matching the pattern used by tests/lib/worktree.test.mjs.

// ---------------------------------------------------------------------------
// Skip gracefully when git is not available
// ---------------------------------------------------------------------------

const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
const gitAvailable = gitCheck.status === 0;

// ---------------------------------------------------------------------------
// Test repo helpers
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/**
 * Run a git command in cwd and return trimmed stdout. Throws on non-zero exit.
 */
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Create a temp repo with an initial empty commit on `main`.
 * Returns the absolute path.
 */
async function makeTempRepo() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'so-freshness-test-'));
  git(repoDir, 'init', '-q');
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  git(repoDir, 'checkout', '-b', 'main');
  git(repoDir, 'commit', '--allow-empty', '-m', 'init');
  return repoDir;
}

/**
 * Write a file (creating parent dirs) and commit it.
 * Returns the commit sha.
 */
function writeAndCommit(repoDir, relPath, content, message) {
  const abs = path.join(repoDir, relPath);
  fsSync.mkdirSync(path.dirname(abs), { recursive: true });
  fsSync.writeFileSync(abs, content, 'utf8');
  git(repoDir, 'add', relPath);
  git(repoDir, 'commit', '-m', message);
  return git(repoDir, 'rev-parse', 'HEAD');
}

/**
 * Write a meta file for the given suffix in the repo's
 * `.orchestrator/tmp/worktree-meta/` directory.
 */
async function writeMeta(repoDir, suffix, data) {
  const metaDir = path.join(repoDir, '.orchestrator', 'tmp', 'worktree-meta');
  await fs.mkdir(metaDir, { recursive: true });
  const metaPath = path.join(metaDir, `${suffix}.json`);
  await fs.writeFile(metaPath, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable).sequential('worktree-freshness integration tests', () => {
  // One shared temp repo per suite, recreated for each test.
  // We use a single beforeAll to set up the process.cwd() for the module
  // imports, and beforeEach/afterEach to manage the per-test repo.

  let origCwd;
  let repoDir;

  beforeAll(async () => {
    origCwd = process.cwd();
  });

  afterAll(async () => {
    process.chdir(origCwd);
  });

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    process.chdir(repoDir);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1 — fresh: baseSha === currentSha → pass
  // -------------------------------------------------------------------------

  it('fresh: baseSha equals currentSha → decision pass, fresh true, empty drift', async () => {
    const sha = git(repoDir, 'rev-parse', 'main');
    await writeMeta(repoDir, 'test-fresh', {
      suffix: 'test-fresh',
      baseRef: 'main',
      baseSha: sha,
      branch: 'so-worktree-test-fresh',
      wtPath: '/tmp/so-worktrees/so-worktree-test-fresh',
      createdAt: new Date().toISOString(),
    });

    const result = await checkWorktreeBaseRefFresh({
      suffix: 'test-fresh',
      targetBranch: 'main',
      cwd: repoDir,
    });

    expect(result.decision).toBe('pass');
    expect(result.fresh).toBe(true);
    expect(result.driftCommits).toEqual([]);
    expect(result.overlap).toEqual([]);
    expect(result.message).toMatch(/base-ref fresh/);
    expect(result.message).toMatch(/main at /);
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 2 — stale-no-overlap: main advanced on docs/, agent scoped to scripts/
  // -------------------------------------------------------------------------

  it('stale-no-overlap: main advanced on docs/, agentScope scripts/** → decision warn', async () => {
    const baseSha = git(repoDir, 'rev-parse', 'main');

    await writeMeta(repoDir, 'no-overlap', {
      suffix: 'no-overlap',
      baseRef: 'main',
      baseSha,
      branch: 'so-worktree-no-overlap',
      wtPath: '/tmp/so-worktrees/so-worktree-no-overlap',
      createdAt: new Date().toISOString(),
    });

    // Coordinator advances main with a docs change
    writeAndCommit(repoDir, 'docs/foo.md', '# foo', 'docs: add foo.md');

    const result = await checkWorktreeBaseRefFresh({
      suffix: 'no-overlap',
      targetBranch: 'main',
      agentScope: ['scripts/**'],
      cwd: repoDir,
    });

    expect(result.decision).toBe('warn');
    expect(result.fresh).toBe(false);
    expect(result.driftCommits.length).toBeGreaterThan(0);
    expect(result.overlap).toEqual([]);
    expect(result.message).toMatch(/advanced by 1 commit/);
    expect(result.message).toMatch(/no agent-scope overlap/);
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 3 — stale-with-overlap: main advanced touching scripts/, agent scoped to scripts/
  // -------------------------------------------------------------------------

  it('stale-with-overlap: main advanced on scripts/bar.mjs, agentScope scripts/** → decision block', async () => {
    const baseSha = git(repoDir, 'rev-parse', 'main');

    await writeMeta(repoDir, 'with-overlap', {
      suffix: 'with-overlap',
      baseRef: 'main',
      baseSha,
      branch: 'so-worktree-with-overlap',
      wtPath: '/tmp/so-worktrees/so-worktree-with-overlap',
      createdAt: new Date().toISOString(),
    });

    writeAndCommit(repoDir, 'scripts/bar.mjs', 'export const x = 1;', 'feat: add bar.mjs');

    const result = await checkWorktreeBaseRefFresh({
      suffix: 'with-overlap',
      targetBranch: 'main',
      agentScope: ['scripts/**'],
      cwd: repoDir,
    });

    expect(result.decision).toBe('block');
    expect(result.fresh).toBe(false);
    expect(result.overlap).toContain('scripts/bar.mjs');
    expect(result.message).toMatch(/overlap on/);
    expect(result.message).toMatch(/scripts\/bar\.mjs/);
    expect(result.message).toMatch(/would overwrite coordinator work/);
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 4 — stale-no-agentScope: agentScope=null, main advanced → warn
  // -------------------------------------------------------------------------

  it('stale-no-agentScope: agentScope=null, main advanced → decision warn (cannot determine overlap)', async () => {
    const baseSha = git(repoDir, 'rev-parse', 'main');

    await writeMeta(repoDir, 'null-scope', {
      suffix: 'null-scope',
      baseRef: 'main',
      baseSha,
      branch: 'so-worktree-null-scope',
      wtPath: '/tmp/so-worktrees/so-worktree-null-scope',
      createdAt: new Date().toISOString(),
    });

    writeAndCommit(repoDir, 'scripts/something.mjs', 'export {};', 'feat: something');

    const result = await checkWorktreeBaseRefFresh({
      suffix: 'null-scope',
      targetBranch: 'main',
      agentScope: null,
      cwd: repoDir,
    });

    expect(result.decision).toBe('warn');
    expect(result.fresh).toBe(false);
    expect(result.overlap).toEqual([]);
    expect(result.driftCommits.length).toBeGreaterThan(0);
    expect(result.message).toMatch(/coordinator review recommended/);
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 5 — missing-meta: no meta file for suffix → no-meta
  // -------------------------------------------------------------------------

  it('missing-meta: no meta file for suffix → decision no-meta, descriptive message', async () => {
    const result = await checkWorktreeBaseRefFresh({
      suffix: 'does-not-exist',
      targetBranch: 'main',
      cwd: repoDir,
    });

    expect(result.decision).toBe('no-meta');
    expect(result.fresh).toBe(false);
    expect(result.driftCommits).toEqual([]);
    expect(result.overlap).toEqual([]);
    expect(result.message).toMatch(/no meta for suffix 'does-not-exist'/);
    expect(result.message).toMatch(/cannot validate freshness/);
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 6 — corrupted-meta: invalid JSON → no-meta with "corrupted" in message
  // -------------------------------------------------------------------------

  it('corrupted-meta: meta file exists but is invalid JSON → no-meta with corrupted message', async () => {
    const metaDir = path.join(repoDir, '.orchestrator', 'tmp', 'worktree-meta');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(path.join(metaDir, 'corrupt.json'), '{ invalid json !!!', 'utf8');

    const result = await checkWorktreeBaseRefFresh({
      suffix: 'corrupt',
      targetBranch: 'main',
      cwd: repoDir,
    });

    expect(result.decision).toBe('no-meta');
    expect(result.fresh).toBe(false);
    expect(result.message).toMatch(/corrupted/);
    expect(result.message).toMatch(/corrupt/);
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 7 — concurrent-coord-commits: ≥3 commits all touching the same file
  //          → overlap count correct (not double-counted)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Test W4-A — agentScope=[] (empty array) → decision warn
  //
  // The production guard treats agentScope.length===0 the same as null:
  // cannot determine overlap, so it falls through to warn.
  // This is distinct from agentScope=['scripts/**'] (which can produce block).
  // -------------------------------------------------------------------------

  it('agentScope=[] (empty array): stale main → decision warn (cannot determine overlap)', async () => {
    const baseSha = git(repoDir, 'rev-parse', 'main');

    await writeMeta(repoDir, 'empty-scope', {
      suffix: 'empty-scope',
      baseRef: 'main',
      baseSha,
      branch: 'so-worktree-empty-scope',
      wtPath: '/tmp/so-worktrees/so-worktree-empty-scope',
      createdAt: new Date().toISOString(),
    });

    writeAndCommit(repoDir, 'scripts/thing.mjs', 'export const x = 1;', 'feat: add thing');

    const result = await checkWorktreeBaseRefFresh({
      suffix: 'empty-scope',
      targetBranch: 'main',
      agentScope: [],
      cwd: repoDir,
    });

    expect(result.decision).toBe('warn');
    expect(result.fresh).toBe(false);
    expect(result.overlap).toEqual([]);
    expect(result.driftCommits.length).toBe(1);
    expect(result.message).toMatch(/coordinator review recommended/);
  }, 15000);

  // -------------------------------------------------------------------------
  // Test W4-B — agentScope=null vs agentScope=[]: both produce warn
  //
  // Confirm the two empty-scope variants agree on the decision so no
  // refactor accidentally diverges them.
  // -------------------------------------------------------------------------

  it('agentScope=null and agentScope=[] both yield warn for stale main', async () => {
    for (const scope of [null, []]) {
      // Fresh repo state per iteration: create a new temp repo
      const iterRepo = await makeTempRepo();
      try {
        const baseSha = git(iterRepo, 'rev-parse', 'main');
        const suffix = scope === null ? 'scope-null' : 'scope-empty';
        await writeMeta(iterRepo, suffix, {
          suffix,
          baseRef: 'main',
          baseSha,
          branch: `so-worktree-${suffix}`,
          wtPath: `/tmp/so-worktrees/so-worktree-${suffix}`,
          createdAt: new Date().toISOString(),
        });
        writeAndCommit(iterRepo, 'docs/readme.md', '# hi', 'docs: readme');

        const result = await checkWorktreeBaseRefFresh({
          suffix,
          targetBranch: 'main',
          agentScope: scope,
          cwd: iterRepo,
        });

        expect(result.decision).toBe('warn');
        expect(result.overlap).toEqual([]);
      } finally {
        await fs.rm(iterRepo, { recursive: true, force: true });
      }
    }
  }, 15000);

  // -------------------------------------------------------------------------
  // Test W4-C — rename detection limitation
  //
  // `git log --name-only` only shows the NEW path for a rename commit (git mv).
  // The old path is silently dropped. This differs from `--name-status` which
  // shows both paths as "R100 old\tnew". _parseDriftLog uses --name-only, so
  // only the destination path appears in driftCommits[i].files.
  //
  // Consequence: if an agent scoped to the OLD path merges back, it will NOT
  // be blocked by the freshness guard because the old name is not in files[].
  // This test documents the limitation so it is not re-introduced as a "fix".
  // -------------------------------------------------------------------------

  it('rename limitation: git mv commit only produces new-path entry in driftCommits[0].files (old path absent)', async () => {
    // Create the file that will be renamed in the initial commit
    const baseSha = writeAndCommit(repoDir, 'scripts/old-name.mjs', 'export const v = 0;', 'feat: add old-name');

    await writeMeta(repoDir, 'rename-test', {
      suffix: 'rename-test',
      baseRef: 'main',
      baseSha,
      branch: 'so-worktree-rename-test',
      wtPath: '/tmp/so-worktrees/so-worktree-rename-test',
      createdAt: new Date().toISOString(),
    });

    // Perform the rename via git mv and commit
    git(repoDir, 'mv', 'scripts/old-name.mjs', 'scripts/new-name.mjs');
    git(repoDir, 'commit', '-m', 'refactor: rename old-name to new-name');

    const result = await checkWorktreeBaseRefFresh({
      suffix: 'rename-test',
      targetBranch: 'main',
      agentScope: ['scripts/**'],
      cwd: repoDir,
    });

    expect(result.driftCommits).toHaveLength(1);
    // --name-only limitation: only the destination path is emitted for renames
    expect(result.driftCommits[0].files).toContain('scripts/new-name.mjs');
    expect(result.driftCommits[0].files).not.toContain('scripts/old-name.mjs');
    expect(result.driftCommits[0].files).toHaveLength(1);
    // New path matches scripts/**, so overlap is detected via the new name
    expect(result.decision).toBe('block');
    expect(result.overlap).toEqual(['scripts/new-name.mjs']);
  }, 15000);

  // -------------------------------------------------------------------------
  // Test W4-D — cwd mismatch: meta written to repoDir-A, call with repoDir-B
  //             → decision no-meta (path diverges, meta not found)
  // -------------------------------------------------------------------------

  it('cwd mismatch: meta in repoDir, cwd points elsewhere → decision no-meta', async () => {
    // Write meta in repoDir (the per-test repo)
    const sha = git(repoDir, 'rev-parse', 'main');
    await writeMeta(repoDir, 'cwd-mismatch', {
      suffix: 'cwd-mismatch',
      baseRef: 'main',
      baseSha: sha,
      branch: 'so-worktree-cwd-mismatch',
      wtPath: '/tmp/so-worktrees/so-worktree-cwd-mismatch',
      createdAt: new Date().toISOString(),
    });

    // Create a second temp repo that has no meta file for this suffix
    const otherRepo = await makeTempRepo();
    try {
      const result = await checkWorktreeBaseRefFresh({
        suffix: 'cwd-mismatch',
        targetBranch: 'main',
        cwd: otherRepo, // wrong repo — no meta here
      });

      expect(result.decision).toBe('no-meta');
      expect(result.fresh).toBe(false);
      expect(result.message).toMatch(/no meta for suffix 'cwd-mismatch'/);
    } finally {
      await fs.rm(otherRepo, { recursive: true, force: true });
    }
  }, 15000);

  it('concurrent-coord-commits: 3 commits all touching scripts/shared.mjs → overlap deduplicated', async () => {
    const baseSha = git(repoDir, 'rev-parse', 'main');

    await writeMeta(repoDir, 'multi-commit', {
      suffix: 'multi-commit',
      baseRef: 'main',
      baseSha,
      branch: 'so-worktree-multi-commit',
      wtPath: '/tmp/so-worktrees/so-worktree-multi-commit',
      createdAt: new Date().toISOString(),
    });

    // Three commits all touching the same file
    writeAndCommit(repoDir, 'scripts/shared.mjs', 'export const v = 1;', 'feat: v1');
    writeAndCommit(repoDir, 'scripts/shared.mjs', 'export const v = 2;', 'feat: v2');
    writeAndCommit(repoDir, 'scripts/shared.mjs', 'export const v = 3;', 'feat: v3');

    const result = await checkWorktreeBaseRefFresh({
      suffix: 'multi-commit',
      targetBranch: 'main',
      agentScope: ['scripts/**'],
      cwd: repoDir,
    });

    expect(result.decision).toBe('block');
    expect(result.driftCommits).toHaveLength(3);
    // Overlap should be deduplicated — scripts/shared.mjs appears once
    expect(result.overlap).toEqual(['scripts/shared.mjs']);
    expect(result.overlap).toHaveLength(1);
    expect(result.message).toMatch(/advanced by 3 commits/);
  }, 15000);

});

// ---------------------------------------------------------------------------
// Test 8 — roundtrip with createWorktree → decision pass
//
// Isolated describe block so createWorktree / removeWorktree (which use zx)
// are imported AFTER process.chdir() to the temp repo. This matches the
// pattern used by tests/lib/worktree.test.mjs (beforeAll import-after-chdir).
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable).sequential('worktree-freshness roundtrip (createWorktree integration)', () => {
  let roundtripRepo;
  let origCwd2;
  let createWorktree;
  let removeWorktree;

  beforeAll(async () => {
    origCwd2 = process.cwd();
    roundtripRepo = await makeTempRepo();
    process.chdir(roundtripRepo);
    // Import after chdir so zx picks up the temp repo as its cwd.
    ({ createWorktree, removeWorktree } = await import('../../scripts/lib/worktree.mjs'));
  });

  afterAll(async () => {
    process.chdir(origCwd2);
    await fs.rm(roundtripRepo, { recursive: true, force: true });
  });

  it('roundtrip: createWorktree persists meta → checkWorktreeBaseRefFresh returns pass', async () => {
    let wtPath;
    let tmpDir;
    let testSuffix;
    try {
      // Per-run unique suffix to avoid collisions from stale cleanup (#406)
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'so-wt-fresh-rt-'));
      testSuffix = path.basename(tmpDir).replace(/^so-wt-fresh-rt-/, '');
      wtPath = await createWorktree(testSuffix, 'HEAD');

      // No new commits since worktree creation — freshness check must return pass.
      // Use cwd: roundtripRepo so checkWorktreeBaseRefFresh resolves meta + git
      // against the same temp repo that createWorktree (via zx) used.
      const result = await checkWorktreeBaseRefFresh({
        suffix: testSuffix,
        targetBranch: 'main',
        cwd: roundtripRepo,
      });

      expect(result.decision).toBe('pass');
      expect(result.fresh).toBe(true);
    } finally {
      if (wtPath) {
        await removeWorktree(wtPath).catch(() => {});
      }
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 30000);
});
