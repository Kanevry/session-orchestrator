/**
 * tests/lib/worktree.test.mjs
 *
 * Integration tests for scripts/lib/worktree.mjs
 * Issue #134 — cross-platform git worktree helpers.
 *
 * Each test operates against a real git repo created in a tmpdir.
 * Tests run serially (describe.sequential) to avoid races on shared git state.
 * Timeout is 15 s per test to accommodate git I/O.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Skip gracefully when git is not available
// ---------------------------------------------------------------------------

const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
const gitAvailable = gitCheck.status === 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an empty git repo with an initial commit (so HEAD is valid).
 * Returns the absolute path to the repo.
 */
async function makeTempRepo() {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'so-worktree-repo-'));

  function git(...args) {
    const result = spawnSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  // Ensure a default branch name so tests work regardless of system git config.
  git('checkout', '-b', 'main');
  git('commit', '--allow-empty', '-m', 'init');

  return repoDir;
}

/**
 * Run git commands against `repoDir` and return stdout (trimmed).
 */
// eslint-disable-next-line no-unused-vars
function gitIn(repoDir, ...args) {
  const result = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return result.stdout.trim();
}

/**
 * Return true when path exists (file or directory).
 */
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Import worktree functions with GIT_DIR and GIT_WORK_TREE reset so zx picks
 * up the correct repo from process.env.SO_WT_REPO (we chdir via GIT_DIR).
 *
 * Simpler approach: zx inherits cwd from the Node process. We set process.cwd
 * isn't easily changeable, but we can set GIT_DIR + GIT_WORK_TREE for the
 * subprocess. Actually the simplest approach: set process.chdir is available
 * in Node — use it inside each test.
 */

// ---------------------------------------------------------------------------
// Test suite — serial to avoid git concurrency issues
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable).sequential('worktree integration tests', () => {
  let repoDir;
  let origCwd;
  let createWorktree;
  let removeWorktree;
  let listWorktrees;
  let cleanupAllWorktrees;

  beforeAll(async () => {
    origCwd = process.cwd();
    repoDir = await realpath(await makeTempRepo());
    // Switch cwd to the temp repo so git commands in worktree.mjs work on it.
    process.chdir(repoDir);
    // Import after chdir so zx uses the temp repo.
    ({ createWorktree, removeWorktree, listWorktrees, cleanupAllWorktrees } =
      await import('../../scripts/lib/worktree.mjs'));
  });

  afterAll(async () => {
    process.chdir(origCwd);
    await rm(repoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // listWorktrees
  // -------------------------------------------------------------------------

  it('listWorktrees returns array with at least the main worktree', async () => {
    const wts = await listWorktrees();
    expect(Array.isArray(wts)).toBe(true);
    expect(wts.length).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('listWorktrees main worktree path matches the repo directory', async () => {
    const wts = await listWorktrees();
    const main = wts[0];
    // Normalise both sides so symlinks / trailing slash don't trip us up.
    expect(main.path).toBe(repoDir);
  }, 15000);

  it('listWorktrees main worktree has a non-empty branch field', async () => {
    const wts = await listWorktrees();
    const main = wts[0];
    expect(typeof main.branch).toBe('string');
    expect(main.branch.length).toBeGreaterThan(0);
  }, 15000);

  // -------------------------------------------------------------------------
  // createWorktree
  // -------------------------------------------------------------------------

  it('createWorktree returns a path under os.tmpdir()', async () => {
    const wtPath = await createWorktree('test-suffix');
    try {
      expect(path.isAbsolute(wtPath)).toBe(true);
      expect(wtPath.startsWith(tmpdir())).toBe(true);
    } finally {
      // Best-effort cleanup.
      await removeWorktree(wtPath).catch(() => {});
    }
  }, 15000);

  it('createWorktree creates the directory on disk', async () => {
    const wtPath = await createWorktree('disk-check');
    try {
      expect(await exists(wtPath)).toBe(true);
    } finally {
      await removeWorktree(wtPath).catch(() => {});
    }
  }, 15000);

  it('createWorktree creates branch so-worktree-<suffix> visible in listWorktrees', async () => {
    const wtPath = await createWorktree('listed');
    try {
      const wts = await listWorktrees();
      const found = wts.some(wt => wt.branch === 'so-worktree-listed');
      expect(found).toBe(true);
    } finally {
      await removeWorktree(wtPath).catch(() => {});
    }
  }, 15000);

  it('createWorktree twice with the same suffix succeeds via force-cleanup retry', async () => {
    const wtPath1 = await createWorktree('retry-suffix');
    // Do not remove — this forces the second call to hit the catch + retry path.
    let wtPath2;
    try {
      wtPath2 = await createWorktree('retry-suffix');
      expect(await exists(wtPath2)).toBe(true);
    } finally {
      await removeWorktree(wtPath2 ?? wtPath1).catch(() => {});
    }
  }, 30000);

  // -------------------------------------------------------------------------
  // removeWorktree
  // -------------------------------------------------------------------------

  it('removeWorktree removes the directory from disk', async () => {
    const wtPath = await createWorktree('to-remove');
    await removeWorktree(wtPath);
    expect(await exists(wtPath)).toBe(false);
  }, 15000);

  it('removeWorktree removes the so-worktree branch', async () => {
    const wtPath = await createWorktree('branch-remove');
    await removeWorktree(wtPath);
    const wts = await listWorktrees();
    const found = wts.some(wt => wt.branch === 'so-worktree-branch-remove');
    expect(found).toBe(false);
  }, 15000);

  it('removeWorktree on a nonexistent path resolves without throwing', async () => {
    const fakePath = path.join(tmpdir(), 'so-worktrees', 'so-worktree-does-not-exist-xyz');
    await expect(removeWorktree(fakePath)).resolves.toBeUndefined();
  }, 15000);

  it('removeWorktree on a worktree with uncommitted changes still removes it', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wtPath = await createWorktree('dirty');
    try {
      // Create an uncommitted file inside the worktree.
      await writeFile(path.join(wtPath, 'dirty.txt'), 'uncommitted content', 'utf8');
      await removeWorktree(wtPath);
      expect(await exists(wtPath)).toBe(false);
    } finally {
      consoleSpy.mockRestore();
      // In case the remove failed, clean up.
      await removeWorktree(wtPath).catch(() => {});
    }
  }, 15000);

  it('removeWorktree emits a warning to stderr when uncommitted changes exist', async () => {
    const errorMessages = [];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(msg => {
      errorMessages.push(msg);
    });
    const wtPath = await createWorktree('dirty-warn');
    try {
      await writeFile(path.join(wtPath, 'dirty2.txt'), 'uncommitted', 'utf8');
      await removeWorktree(wtPath);
      const hasWarning = errorMessages.some(m => /uncommitted changes/i.test(m));
      expect(hasWarning).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      await removeWorktree(wtPath).catch(() => {});
    }
  }, 15000);

  // -------------------------------------------------------------------------
  // cleanupAllWorktrees
  // -------------------------------------------------------------------------

  it('cleanupAllWorktrees removes all so-worktree-* branches, leaving main intact', async () => {
    const wt1 = await createWorktree('cleanup-a');
    const wt2 = await createWorktree('cleanup-b');

    await cleanupAllWorktrees();

    const wtsAfter = await listWorktrees();

    // so-worktree-* branches must be gone.
    const soWts = wtsAfter.filter(wt => /^so-worktree-/.test(wt.branch));
    expect(soWts).toHaveLength(0);

    // Main worktree must still be present.
    expect(wtsAfter.length).toBeGreaterThanOrEqual(1);

    // Disk paths cleaned up.
    expect(await exists(wt1)).toBe(false);
    expect(await exists(wt2)).toBe(false);
  }, 30000);
});

// ---------------------------------------------------------------------------
// applyWorktreeExcludes unit tests (issue #192)
// ---------------------------------------------------------------------------
//
// Design note: these tests call applyWorktreeExcludes() directly against a
// plain temporary directory — no git, no zx. This avoids the vitest/zx
// subprocess interaction issues that arise when createWorktree() (which calls
// nothrow() internally) and a second describe block both run in the same
// vitest worker thread.

describe.sequential('applyWorktreeExcludes (issue #192)', () => {
  let applyWorktreeExcludes;

  beforeAll(async () => {
    ({ applyWorktreeExcludes } = await import('../../scripts/lib/worktree.mjs'));
  });

  /**
   * Create a temporary directory pre-seeded with the given sub-directory
   * names, run callback with its path, then remove it.
   * Uses plain Node.js fs — no git involved.
   */
  async function withStagingDir(seedDirs, callback) {
    const stagingDir = await realpath(await mkdtemp(path.join(tmpdir(), 'so-excl-test-')));
    for (const dir of seedDirs) {
      await mkdir(path.join(stagingDir, dir), { recursive: true });
    }
    try {
      await callback(stagingDir);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  it('removes node_modules and dist but preserves src', async () => {
    await withStagingDir(['node_modules', 'dist', 'src'], async (dir) => {
      await applyWorktreeExcludes(dir, ['node_modules', 'dist', 'build', '.next', '.nuxt',
        'coverage', '.cache', '.turbo', '.vercel', 'out']);
      expect(await exists(path.join(dir, 'src'))).toBe(true);
      expect(await exists(path.join(dir, 'node_modules'))).toBe(false);
      expect(await exists(path.join(dir, 'dist'))).toBe(false);
    });
  });

  it('custom patterns — only-me removed, node_modules kept', async () => {
    await withStagingDir(['only-me', 'node_modules'], async (dir) => {
      await applyWorktreeExcludes(dir, ['only-me']);
      expect(await exists(path.join(dir, 'only-me'))).toBe(false);
      expect(await exists(path.join(dir, 'node_modules'))).toBe(true);
    });
  });

  it('empty patterns array — node_modules preserved (feature disabled)', async () => {
    await withStagingDir(['node_modules'], async (dir) => {
      await applyWorktreeExcludes(dir, []);
      expect(await exists(path.join(dir, 'node_modules'))).toBe(true);
    });
  });

  it('non-existent patterns are silently skipped — resolves without throwing', async () => {
    await withStagingDir([], async (dir) => {
      await expect(applyWorktreeExcludes(dir, ['does-not-exist'])).resolves.toBeUndefined();
    });
  });

  it('nested directories are NOT recursed — src/node_modules survives', async () => {
    await withStagingDir(['src/node_modules'], async (dir) => {
      await applyWorktreeExcludes(dir, ['node_modules']);
      // Top-level node_modules does not exist; src/node_modules must survive.
      expect(await exists(path.join(dir, 'src', 'node_modules'))).toBe(true);
    });
  });
});
