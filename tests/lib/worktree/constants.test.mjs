/**
 * tests/lib/worktree/constants.test.mjs
 *
 * Unit tests for scripts/lib/worktree/constants.mjs.
 * Covers WORKTREE_META_DIR value and DEFAULT_EXCLUDE_PATTERNS content.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock zx before importing the module so the side-effect ($.verbose/$.quiet)
// hits our mock rather than a real zx instance.
vi.mock('zx', () => ({
  $: Object.assign(
    vi.fn().mockImplementation(() => Promise.resolve({ stdout: '' })),
    { verbose: true, quiet: false }
  ),
}));

describe('worktree/constants', () => {
  it('WORKTREE_META_DIR is the canonical relative path', async () => {
    const { WORKTREE_META_DIR } = await import('../../../scripts/lib/worktree/constants.mjs');
    expect(WORKTREE_META_DIR).toBe('.orchestrator/tmp/worktree-meta');
  });

  it('WORKTREE_META_DIR does not start with a slash (relative path)', async () => {
    const { WORKTREE_META_DIR } = await import('../../../scripts/lib/worktree/constants.mjs');
    expect(WORKTREE_META_DIR.startsWith('/')).toBe(false);
  });

  it('DEFAULT_EXCLUDE_PATTERNS includes node_modules', async () => {
    const { DEFAULT_EXCLUDE_PATTERNS } = await import('../../../scripts/lib/worktree/constants.mjs');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('node_modules');
  });

  it('DEFAULT_EXCLUDE_PATTERNS includes dist and .next', async () => {
    const { DEFAULT_EXCLUDE_PATTERNS } = await import('../../../scripts/lib/worktree/constants.mjs');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('dist');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.next');
  });

  it('zx side-effect: $.verbose and $.quiet are set to false on module load', async () => {
    const { $ } = await import('zx');
    // The module side-effect sets $.verbose = false and $.quiet = true.
    // Our mock started with verbose: true, quiet: false — constants.mjs flips them.
    expect($.verbose).toBe(false);
    expect($.quiet).toBe(true);
  });
});
