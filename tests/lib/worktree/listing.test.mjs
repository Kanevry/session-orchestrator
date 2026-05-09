/**
 * tests/lib/worktree/listing.test.mjs
 *
 * Unit tests for scripts/lib/worktree/listing.mjs.
 * Covers listWorktrees (porcelain parsing) and applyWorktreeExcludes (fs removal).
 *
 * zx is mocked so no real git subprocess is invoked.
 * fs operations in applyWorktreeExcludes tests use real tmpdir fixtures.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module-level mock — must be hoisted
// ---------------------------------------------------------------------------

// Shared state for the $ callable mock.
let mockStdout = '';
let mockShouldThrow = false;

vi.mock('zx', () => {
  // Inner tagged-template function returned by $({ cwd }).
  const tagFn = vi.fn().mockImplementation(() => {
    if (mockShouldThrow) return Promise.reject(new Error('git failure'));
    return Promise.resolve({ stdout: mockStdout });
  });
  // $ is called with options object → returns tagFn.
  const $fn = Object.assign(
    vi.fn().mockImplementation(() => tagFn),
    { verbose: false, quiet: true }
  );
  return { $: $fn };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'listing-test-'));
  mockStdout = '';
  mockShouldThrow = false;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// listWorktrees
// ---------------------------------------------------------------------------

describe('listWorktrees', () => {
  it('returns an empty array when git command fails', async () => {
    mockShouldThrow = true;
    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');
    const result = await listWorktrees();
    expect(result).toEqual([]);
  });

  it('returns an empty array when output is empty', async () => {
    mockStdout = '';
    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');
    const result = await listWorktrees();
    expect(result).toEqual([]);
  });

  it('parses a single worktree record from porcelain output', async () => {
    mockStdout = [
      'worktree /repo',
      'HEAD abc123def456abc123def456abc123def456abc12',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');
    const result = await listWorktrees();

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/repo');
    expect(result[0].head).toBe('abc123def456abc123def456abc123def456abc12');
    expect(result[0].branch).toBe('main');
  });

  it('strips refs/heads/ prefix from branch field', async () => {
    mockStdout = [
      'worktree /repo',
      'HEAD aaaa',
      'branch refs/heads/feature/my-branch',
      '',
    ].join('\n');

    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');
    const result = await listWorktrees();

    expect(result[0].branch).toBe('feature/my-branch');
  });

  it('parses two worktree records correctly', async () => {
    mockStdout = [
      'worktree /repo',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /tmp/so-worktrees/so-worktree-wave1',
      'HEAD bbb',
      'branch refs/heads/so-worktree-wave1',
      '',
    ].join('\n');

    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');
    const result = await listWorktrees();

    expect(result).toHaveLength(2);
    expect(result[1].branch).toBe('so-worktree-wave1');
    expect(result[1].path).toBe('/tmp/so-worktrees/so-worktree-wave1');
  });

  it('handles trailing record without trailing blank line', async () => {
    // No trailing newline — tests the flush-after-loop logic.
    mockStdout = 'worktree /repo\nHEAD abc\nbranch refs/heads/main';

    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');
    const result = await listWorktrees();

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/repo');
  });

  it('returns empty branch string when branch line is absent', async () => {
    mockStdout = 'worktree /repo\nHEAD abc\n\n';

    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');
    const result = await listWorktrees();

    expect(result[0].branch).toBe('');
  });
});

// ---------------------------------------------------------------------------
// applyWorktreeExcludes
// ---------------------------------------------------------------------------

describe('applyWorktreeExcludes', () => {
  it('removes a matching directory', async () => {
    const targetDir = join(sandbox, 'node_modules');
    mkdirSync(targetDir);

    const { applyWorktreeExcludes } = await import('../../../scripts/lib/worktree/listing.mjs');
    await applyWorktreeExcludes(sandbox, ['node_modules']);

    expect(existsSync(targetDir)).toBe(false);
  });

  it('preserves directories not in patterns', async () => {
    mkdirSync(join(sandbox, 'src'));
    mkdirSync(join(sandbox, 'node_modules'));

    const { applyWorktreeExcludes } = await import('../../../scripts/lib/worktree/listing.mjs');
    await applyWorktreeExcludes(sandbox, ['node_modules']);

    expect(existsSync(join(sandbox, 'src'))).toBe(true);
    expect(existsSync(join(sandbox, 'node_modules'))).toBe(false);
  });

  it('resolves without throwing when patterns is empty', async () => {
    mkdirSync(join(sandbox, 'node_modules'));

    const { applyWorktreeExcludes } = await import('../../../scripts/lib/worktree/listing.mjs');
    await expect(applyWorktreeExcludes(sandbox, [])).resolves.toBeUndefined();

    expect(existsSync(join(sandbox, 'node_modules'))).toBe(true);
  });

  it('resolves without throwing when a pattern does not exist', async () => {
    const { applyWorktreeExcludes } = await import('../../../scripts/lib/worktree/listing.mjs');
    await expect(applyWorktreeExcludes(sandbox, ['does-not-exist'])).resolves.toBeUndefined();
  });

  it('does not descend — nested node_modules inside src survives', async () => {
    const nestedDir = join(sandbox, 'src', 'node_modules');
    mkdirSync(nestedDir, { recursive: true });

    const { applyWorktreeExcludes } = await import('../../../scripts/lib/worktree/listing.mjs');
    await applyWorktreeExcludes(sandbox, ['node_modules']);

    // Top-level does not exist, nested must survive.
    expect(existsSync(nestedDir)).toBe(true);
  });

  it('removes multiple matching directories', async () => {
    mkdirSync(join(sandbox, 'dist'));
    mkdirSync(join(sandbox, '.next'));

    const { applyWorktreeExcludes } = await import('../../../scripts/lib/worktree/listing.mjs');
    await applyWorktreeExcludes(sandbox, ['dist', '.next']);

    expect(existsSync(join(sandbox, 'dist'))).toBe(false);
    expect(existsSync(join(sandbox, '.next'))).toBe(false);
  });
});
