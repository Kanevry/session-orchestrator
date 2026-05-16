/**
 * tests/lib/workspace.test.mjs
 *
 * Unit tests for scripts/lib/workspace.mjs.
 * Covers resolveWorkspaceRoot, restoreCoordinatorCwd, and validatePathInWorkspace.
 *
 * The zx `$` tag and listWorktrees() from worktree.mjs are mocked to avoid
 * real git subprocess calls and filesystem side-effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module-level mocks (must be hoisted before dynamic imports)
// ---------------------------------------------------------------------------

vi.mock('zx', () => ({
  $: Object.assign(
    vi.fn().mockImplementation(() =>
      Promise.resolve({ stdout: '' })
    ),
    { verbose: false, quiet: true }
  ),
}));

vi.mock('@lib/worktree.mjs', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sandbox;

beforeEach(() => {
  // Resolve symlinks — macOS /var/folders is a symlink to /private/var/folders
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-test-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// resolveWorkspaceRoot
// ---------------------------------------------------------------------------

describe('resolveWorkspaceRoot', () => {
  it('returns the git repo root from git rev-parse --git-common-dir (absolute path)', async () => {
    // Mock $ to return an absolute .git directory inside sandbox
    const gitDir = join(sandbox, '.git');
    mkdirSync(gitDir, { recursive: true });

    const { $ } = await import('zx');
    $.mockResolvedValueOnce({ stdout: gitDir + '\n' });

    // Change cwd so the module sees our sandbox
    const origCwd = process.cwd();
    process.chdir(sandbox);

    const { resolveWorkspaceRoot } = await import('@lib/workspace.mjs');
    const root = await resolveWorkspaceRoot();

    process.chdir(origCwd);

    // root is the directory ABOVE gitDir (dirname of .git)
    expect(root).toBe(sandbox);
  });

  it('falls back to walk-up discovery when git command fails', async () => {
    // Create a real .git directory in sandbox so the walk-up finds it
    const gitDir = join(sandbox, '.git');
    mkdirSync(gitDir, { recursive: true });

    const { $ } = await import('zx');
    $.mockRejectedValueOnce(new Error('not a git repository'));

    const origCwd = process.cwd();
    process.chdir(sandbox);

    const { resolveWorkspaceRoot } = await import('@lib/workspace.mjs');
    const root = await resolveWorkspaceRoot();

    process.chdir(origCwd);

    expect(root).toBe(sandbox);
  });

  it('throws when neither git command nor .git entry can be found', async () => {
    // An empty tmpdir with no .git at all
    const empty = mkdtempSync(join(tmpdir(), 'workspace-empty-'));
    const { $ } = await import('zx');
    $.mockRejectedValueOnce(new Error('not a git repo'));

    const origCwd = process.cwd();
    process.chdir(empty);

    const { resolveWorkspaceRoot } = await import('@lib/workspace.mjs');

    await expect(resolveWorkspaceRoot()).rejects.toThrow('resolveWorkspaceRoot:');

    process.chdir(origCwd);
    rmSync(empty, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// restoreCoordinatorCwd
// ---------------------------------------------------------------------------

describe('restoreCoordinatorCwd', () => {
  it('returns restored=false when cwd already equals workspace root', async () => {
    const gitDir = join(sandbox, '.git');
    mkdirSync(gitDir, { recursive: true });

    const { $ } = await import('zx');
    $.mockResolvedValueOnce({ stdout: gitDir + '\n' });

    const origCwd = process.cwd();
    process.chdir(sandbox);

    const { restoreCoordinatorCwd } = await import('@lib/workspace.mjs');
    const result = await restoreCoordinatorCwd();

    process.chdir(origCwd);

    expect(result.restored).toBe(false);
    expect(result.from).toBeNull();
    expect(result.to).toBe(sandbox);
  });

  it('returns object with restored, from, to shape', async () => {
    const gitDir = join(sandbox, '.git');
    mkdirSync(gitDir, { recursive: true });

    const { $ } = await import('zx');
    $.mockResolvedValueOnce({ stdout: gitDir + '\n' });

    const origCwd = process.cwd();
    process.chdir(sandbox);

    const { restoreCoordinatorCwd } = await import('@lib/workspace.mjs');
    const result = await restoreCoordinatorCwd();

    process.chdir(origCwd);

    expect(result).toMatchObject({
      restored: expect.any(Boolean),
      to: expect.any(String),
    });
    // from is string when restored=true, null otherwise
    if (result.restored) {
      expect(typeof result.from).toBe('string');
    } else {
      expect(result.from).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// validatePathInWorkspace
// ---------------------------------------------------------------------------

describe('validatePathInWorkspace', () => {
  it('accepts a path that is a descendant of the workspace root', async () => {
    const { validatePathInWorkspace } = await import('@lib/workspace.mjs');
    const target = join(sandbox, 'src', 'index.ts');
    const result = await validatePathInWorkspace(target, sandbox);
    expect(result).toBe(true);
  });

  it('rejects the workspace root itself (must be a descendant, not equal)', async () => {
    const { validatePathInWorkspace } = await import('@lib/workspace.mjs');
    const result = await validatePathInWorkspace(sandbox, sandbox);
    expect(result).toBe(false);
  });

  it('rejects a sibling path outside the workspace root', async () => {
    const { validatePathInWorkspace } = await import('@lib/workspace.mjs');
    const sibling = join(sandbox, '..', 'other-repo', 'file.ts');
    const result = await validatePathInWorkspace(sibling, sandbox);
    expect(result).toBe(false);
  });

  it('rejects a path inside .claude/worktrees/ subtree', async () => {
    const { validatePathInWorkspace } = await import('@lib/workspace.mjs');
    const worktreePath = join(sandbox, '.claude', 'worktrees', 'agent1', 'src', 'file.ts');
    const result = await validatePathInWorkspace(worktreePath, sandbox);
    expect(result).toBe(false);
  });

  it('rejects a path inside .codex/worktrees/ subtree', async () => {
    const { validatePathInWorkspace } = await import('@lib/workspace.mjs');
    const worktreePath = join(sandbox, '.codex', 'worktrees', 'agent2', 'file.ts');
    const result = await validatePathInWorkspace(worktreePath, sandbox);
    expect(result).toBe(false);
  });

  it('accepts a path that starts with "worktrees" but not in the excluded subtrees', async () => {
    const { validatePathInWorkspace } = await import('@lib/workspace.mjs');
    // A directory named "worktrees-backup" inside src should NOT be rejected
    const validPath = join(sandbox, 'src', 'worktrees-backup', 'file.ts');
    const result = await validatePathInWorkspace(validPath, sandbox);
    expect(result).toBe(true);
  });
});
