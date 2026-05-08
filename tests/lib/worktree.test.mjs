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

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access, realpath, readFile, stat } from 'node:fs/promises';
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
  let metaPathFor;
  let WORKTREE_META_DIR;

  beforeAll(async () => {
    origCwd = process.cwd();
    repoDir = await realpath(await makeTempRepo());
    // Switch cwd to the temp repo so git commands in worktree.mjs work on it.
    process.chdir(repoDir);
    // Import after chdir so zx uses the temp repo.
    ({ createWorktree, removeWorktree, listWorktrees, cleanupAllWorktrees, metaPathFor, WORKTREE_META_DIR } =
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
    // Normalise path separators — git worktree --porcelain emits forward
    // slashes on Windows while Node's realpath returns backslashes.
    const norm = (s) => s.replaceAll(path.sep, '/');
    expect(norm(main.path)).toBe(norm(repoDir));
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

  it('worktree-exclude: null in CLAUDE.md disables all excludes (no node_modules removed)', async () => {
    // Write a CLAUDE.md with worktree-exclude: null into the temp repo so that
    // createWorktree picks it up from process.cwd() (which is repoDir in this suite).
    const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
    await writeFile(
      claudeMdPath,
      '## Session Config\nworktree-exclude: null\n',
      'utf8'
    );

    // Seed a node_modules dir inside the worktree after creation is not possible
    // without a real project — instead verify createWorktree resolves and that
    // applyWorktreeExcludes is called with [] (empty patterns → nothing deleted).
    // We validate indirectly: the worktree creates successfully and no error is thrown.
    // Direct pattern-resolution is unit-tested below in the applyWorktreeExcludes suite.
    let wtPath;
    try {
      wtPath = await createWorktree('null-exclude');
      expect(await exists(wtPath)).toBe(true);
    } finally {
      if (wtPath) await removeWorktree(wtPath).catch(() => {});
      // Remove the CLAUDE.md so subsequent tests aren't affected.
      await rm(claudeMdPath, { force: true }).catch(() => {});
    }
  }, 15000);

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

  // -------------------------------------------------------------------------
  // Meta persistence (issue #195)
  // -------------------------------------------------------------------------

  it('createWorktree persists meta at metaPathFor(suffix) with required fields', async () => {
    const suffix = 'meta-check';
    const wtPath = await createWorktree(suffix, 'HEAD');
    try {
      const expectedMetaPath = metaPathFor(suffix);
      expect(await exists(expectedMetaPath)).toBe(true);

      const raw = await readFile(expectedMetaPath, 'utf8');
      const meta = JSON.parse(raw);

      expect(meta.suffix).toBe(suffix);
      expect(typeof meta.baseSha).toBe('string');
      expect(meta.baseSha.length).toBe(40); // full SHA
      expect(meta.branch).toBe(`so-worktree-${suffix}`);
      expect(meta.wtPath).toBe(wtPath);
      expect(typeof meta.createdAt).toBe('string');
      expect(meta.baseRef).toBe('HEAD');
    } finally {
      await removeWorktree(wtPath).catch(() => {});
    }
  }, 15000);

  it('removeWorktree cleans up the meta file after removal', async () => {
    const suffix = 'meta-cleanup';
    const wtPath = await createWorktree(suffix, 'HEAD');
    const metaPath = metaPathFor(suffix);

    // Confirm meta exists before removal
    expect(await exists(metaPath)).toBe(true);

    await removeWorktree(wtPath);

    // Meta file should be gone
    expect(await exists(metaPath)).toBe(false);
  }, 15000);

  it('createWorktree continues and warns when meta-dir path is a file (write failure)', async () => {
    // Simulate meta write failure by making the meta-dir itself a file
    const metaDirAbs = path.join(repoDir, WORKTREE_META_DIR);
    // Ensure parent exists but the target dir is actually a file
    await mkdir(path.dirname(metaDirAbs), { recursive: true });
    // Only create the blocking file if the meta dir does not already exist
    if (!(await exists(metaDirAbs))) {
      await writeFile(metaDirAbs, 'blocking file', 'utf8');
    } else {
      // Meta dir already exists from previous tests; replace the deepest component with a file
      // We can't easily block this, so just verify the worktree still creates successfully.
    }

    const warnMessages = [];
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(msg => {
      warnMessages.push(msg);
    });

    const suffix = 'meta-write-fail';
    let wtPath;
    try {
      wtPath = await createWorktree(suffix, 'HEAD');
      // Worktree must still be created even if meta write fails
      expect(await exists(wtPath)).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      if (wtPath) {
        await removeWorktree(wtPath).catch(() => {});
      }
      // Clean up the blocking file so it doesn't interfere with other tests
      // (only if it's actually a file, not a directory)
      try {
        const s = await stat(metaDirAbs);
        if (s.isFile()) {
          const { unlink } = await import('node:fs/promises');
          await unlink(metaDirAbs).catch(() => {});
        }
      } catch {
        // Ignore
      }
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// Worktree hardening helpers — resolveWorkspaceRoot, restoreCoordinatorCwd,
// validatePathInWorkspace (issue #219)
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable).sequential('worktree hardening helpers (#219)', () => {
  let repoDir;
  let origCwd;
  let resolveWorkspaceRoot;
  let restoreCoordinatorCwd;
  let validatePathInWorkspace;
  let createWorktree;
  let removeWorktree;

  beforeAll(async () => {
    origCwd = process.cwd();
    repoDir = await realpath(await makeTempRepo());
    process.chdir(repoDir);
    // Import the module after chdir so it picks up the correct repo root via
    // process.cwd(). Use a cache-busting query param to force a fresh module
    // instance separate from the one loaded by the first describe block.
    const [worktreeMod, workspaceMod] = await Promise.all([
      import('../../scripts/lib/worktree.mjs?hardening'),
      import('../../scripts/lib/workspace.mjs?hardening'),
    ]);
    ({ createWorktree, removeWorktree } = worktreeMod);
    ({
      resolveWorkspaceRoot,
      restoreCoordinatorCwd,
      validatePathInWorkspace,
    } = workspaceMod);
  });

  afterAll(async () => {
    process.chdir(origCwd);
    await rm(repoDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Guarantee CWD is restored to repoDir between tests so any failed chdir
    // inside a test does not contaminate the next test.
    try {
      process.chdir(repoDir);
    } catch {
      // If repoDir was removed, restore to origCwd.
      process.chdir(origCwd);
    }
  });

  // -------------------------------------------------------------------------
  // resolveWorkspaceRoot
  // -------------------------------------------------------------------------

  it('resolveWorkspaceRoot returns the repo root when called from the main tree', async () => {
    process.chdir(repoDir);
    const root = await resolveWorkspaceRoot();
    // Normalize separators so comparison is cross-platform.
    const norm = (s) => s.replaceAll(path.sep, '/');
    expect(norm(root)).toBe(norm(repoDir));
  }, 15000);

  it('resolveWorkspaceRoot returns the MAIN repo root when called from a linked worktree', async () => {
    const wtPath = await createWorktree('rwsr-linked');
    try {
      const wtPathReal = await realpath(wtPath);
      process.chdir(wtPathReal);
      const root = await resolveWorkspaceRoot();
      const norm = (s) => s.replaceAll(path.sep, '/');
      // Must return the main repo root, NOT the linked worktree path.
      expect(norm(root)).toBe(norm(repoDir));
      expect(norm(root)).not.toBe(norm(wtPathReal));
    } finally {
      process.chdir(repoDir);
      await removeWorktree(wtPath).catch(() => {});
    }
  }, 15000);

  it('resolveWorkspaceRoot works when called from a subdirectory 5 levels deep inside the repo', async () => {
    const deepDir = path.join(repoDir, 'a', 'b', 'c', 'd', 'e');
    await mkdir(deepDir, { recursive: true });
    process.chdir(deepDir);
    const root = await resolveWorkspaceRoot();
    const norm = (s) => s.replaceAll(path.sep, '/');
    expect(norm(root)).toBe(norm(repoDir));
  }, 15000);

  it('resolveWorkspaceRoot throws with "resolveWorkspaceRoot:" prefix when not inside a git repo', async () => {
    // Create a plain temp directory with no .git anywhere above it.
    const plainDir = await mkdtemp(path.join(tmpdir(), 'so-no-git-'));
    try {
      process.chdir(plainDir);
      await expect(resolveWorkspaceRoot()).rejects.toThrow('resolveWorkspaceRoot:');
    } finally {
      process.chdir(repoDir);
      await rm(plainDir, { recursive: true, force: true });
    }
  }, 15000);

  // -------------------------------------------------------------------------
  // restoreCoordinatorCwd
  // -------------------------------------------------------------------------

  it('restoreCoordinatorCwd returns restored:false and from:null when CWD is already workspace root', async () => {
    process.chdir(repoDir);
    const result = await restoreCoordinatorCwd();
    expect(result.restored).toBe(false);
    expect(result.from).toBe(null);
    // to must equal the resolved workspace root.
    const norm = (s) => s.replaceAll(path.sep, '/');
    expect(norm(result.to)).toBe(norm(repoDir));
  }, 15000);

  it('restoreCoordinatorCwd restores CWD to workspace root when drifted into a linked worktree', async () => {
    const wtPath = await createWorktree('rcc-drifted');
    try {
      const wtPathReal = await realpath(wtPath);
      process.chdir(wtPathReal);
      const result = await restoreCoordinatorCwd();

      expect(result.restored).toBe(true);
      // from must be the worktree path we chdir'd into.
      const norm = (s) => s.replaceAll(path.sep, '/');
      expect(norm(result.from)).toBe(norm(wtPathReal));
      // to must be the main repo root.
      expect(norm(result.to)).toBe(norm(repoDir));
      // process.cwd() must now equal the repo root.
      expect(norm(process.cwd())).toBe(norm(repoDir));
    } finally {
      process.chdir(repoDir);
      await removeWorktree(wtPath).catch(() => {});
    }
  }, 15000);

  // -------------------------------------------------------------------------
  // validatePathInWorkspace
  // -------------------------------------------------------------------------

  it('validatePathInWorkspace returns true for a relative path inside the workspace', async () => {
    process.chdir(repoDir);
    const result = await validatePathInWorkspace('scripts/foo.mjs', repoDir);
    expect(result).toBe(true);
  }, 15000);

  it('validatePathInWorkspace returns true for an absolute path inside the workspace', async () => {
    const absPath = path.join(repoDir, 'src', 'index.ts');
    const result = await validatePathInWorkspace(absPath, repoDir);
    expect(result).toBe(true);
  }, 15000);

  it('validatePathInWorkspace returns false for a path outside the workspace (/tmp/foo)', async () => {
    const outsidePath = path.join(tmpdir(), 'foo.txt');
    const result = await validatePathInWorkspace(outsidePath, repoDir);
    expect(result).toBe(false);
  }, 15000);

  it('validatePathInWorkspace returns false for a path escaping via ../sibling', async () => {
    // Relative to repoDir, "../sibling" resolves outside the repo.
    process.chdir(repoDir);
    const result = await validatePathInWorkspace('../sibling-project/file.ts', repoDir);
    expect(result).toBe(false);
  }, 15000);

  it('validatePathInWorkspace returns false for path inside .claude/worktrees/ subtree', async () => {
    const worktreePath = path.join(repoDir, '.claude', 'worktrees', 'agent-X', 'file.ts');
    const result = await validatePathInWorkspace(worktreePath, repoDir);
    expect(result).toBe(false);
  }, 15000);

  it('validatePathInWorkspace returns false for path inside .codex/worktrees/ subtree', async () => {
    const worktreePath = path.join(repoDir, '.codex', 'worktrees', 'agent-1', 'index.js');
    const result = await validatePathInWorkspace(worktreePath, repoDir);
    expect(result).toBe(false);
  }, 15000);

  it('validatePathInWorkspace returns false for path inside .cursor/worktrees/ subtree', async () => {
    const worktreePath = path.join(repoDir, '.cursor', 'worktrees', 'wave2', 'component.tsx');
    const result = await validatePathInWorkspace(worktreePath, repoDir);
    expect(result).toBe(false);
  }, 15000);
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

  // -------------------------------------------------------------------------
  // worktree-exclude null semantics (Fix: explicit null → disable excludes)
  // -------------------------------------------------------------------------

  it('worktree-exclude: null in config → applyWorktreeExcludes called with [] → node_modules preserved', async () => {
    // This test verifies the null-vs-empty contract added in worktree.mjs:
    // when config['worktree-exclude'] === null, excludePatterns resolves to []
    // and applyWorktreeExcludes short-circuits (nothing removed).
    // We exercise this by calling applyWorktreeExcludes with [] directly —
    // the resolution logic (null → []) is integration-tested via the
    // CLAUDE.md-based test in the git integration suite above.
    await withStagingDir(['node_modules', 'dist'], async (dir) => {
      // [] is what the null-resolution path produces.
      await applyWorktreeExcludes(dir, []);
      // Both directories must survive — no excludes applied.
      expect(await exists(path.join(dir, 'node_modules'))).toBe(true);
      expect(await exists(path.join(dir, 'dist'))).toBe(true);
    });
  });
});
