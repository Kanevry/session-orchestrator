/**
 * tests/lib/worktree/constants.test.mjs
 *
 * Unit tests for scripts/lib/worktree/constants.mjs.
 * Covers WORKTREE_META_DIR value and DEFAULT_EXCLUDE_PATTERNS content.
 */

import { describe, it, expect } from 'vitest';

describe('worktree/constants', () => {
  it('WORKTREE_META_DIR is the canonical relative path', async () => {
    const { WORKTREE_META_DIR } = await import('@lib/worktree/constants.mjs');
    expect(WORKTREE_META_DIR).toBe('.orchestrator/tmp/worktree-meta');
  });

  it('WORKTREE_META_DIR does not start with a slash (relative path)', async () => {
    const { WORKTREE_META_DIR } = await import('@lib/worktree/constants.mjs');
    expect(WORKTREE_META_DIR.startsWith('/')).toBe(false);
  });

  it('DEFAULT_EXCLUDE_PATTERNS includes node_modules', async () => {
    const { DEFAULT_EXCLUDE_PATTERNS } = await import('@lib/worktree/constants.mjs');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('node_modules');
  });

  it('DEFAULT_EXCLUDE_PATTERNS includes dist and .next', async () => {
    const { DEFAULT_EXCLUDE_PATTERNS } = await import('@lib/worktree/constants.mjs');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('dist');
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.next');
  });

  // Removed: the $.verbose/$.quiet side-effect is an implementation detail (test-quality.md
  // anti-patterns #3 Implementation Mirror + #6 Getter/Setter); observable quiet-output
  // behaviour is covered by higher-level integration tests that exercise real worktree ops.
});
