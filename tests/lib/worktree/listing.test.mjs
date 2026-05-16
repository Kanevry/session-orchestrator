/**
 * tests/lib/worktree/listing.test.mjs
 *
 * Unit tests for scripts/lib/worktree/listing.mjs.
 * Covers listWorktrees (porcelain parsing) and applyWorktreeExcludes (fs removal).
 *
 * listWorktrees tests inject a mock $ executor via the opts.$ parameter, so
 * these tests do NOT depend on vi.mock('zx') — making them safe under
 * pool: 'forks' where vi.mock factory closures are re-evaluated per fork
 * (GitLab issue #367).
 *
 * fs operations in applyWorktreeExcludes tests use real tmpdir fixtures.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorktrees, applyWorktreeExcludes } from '@lib/worktree/listing.mjs';

// ---------------------------------------------------------------------------
// Mock-executor factory — no vi.mock('zx') needed
// ---------------------------------------------------------------------------

/**
 * Build a mock zx-compatible $ executor for listWorktrees DI injection.
 *
 * @param {object} [opts]
 * @param {string}  [opts.stdout='']        Porcelain output to resolve with.
 * @param {boolean} [opts.shouldThrow=false] If true, the tag-fn rejects with Error('git failure').
 * @returns {Function}  A vi.fn() that behaves like zx's $({ cwd })`` pattern.
 */
function makeMockDollar({ stdout = '', shouldThrow = false } = {}) {
  const tagFn = vi.fn().mockImplementation(() =>
    shouldThrow
      ? Promise.reject(new Error('git failure'))
      : Promise.resolve({ stdout })
  );
  return Object.assign(
    vi.fn().mockImplementation(() => tagFn),
    { verbose: false, quiet: true }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'listing-test-'));
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
    const $mock = makeMockDollar({ shouldThrow: true });
    const result = await listWorktrees({ $: $mock });
    expect(result).toEqual([]);
  });

  it('returns an empty array when output is empty', async () => {
    const $mock = makeMockDollar({ stdout: '' });
    const result = await listWorktrees({ $: $mock });
    expect(result).toEqual([]);
  });

  it('parses a single worktree record from porcelain output', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc123def456abc123def456abc123def456abc12',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const $mock = makeMockDollar({ stdout: porcelain });
    const result = await listWorktrees({ $: $mock });

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/repo');
    expect(result[0].head).toBe('abc123def456abc123def456abc123def456abc12');
    expect(result[0].branch).toBe('main');
  });

  it('strips refs/heads/ prefix from branch field', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD aaaa',
      'branch refs/heads/feature/my-branch',
      '',
    ].join('\n');

    const $mock = makeMockDollar({ stdout: porcelain });
    const result = await listWorktrees({ $: $mock });

    expect(result[0].branch).toBe('feature/my-branch');
  });

  it('parses two worktree records correctly', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /tmp/so-worktrees/so-worktree-wave1',
      'HEAD bbb',
      'branch refs/heads/so-worktree-wave1',
      '',
    ].join('\n');

    const $mock = makeMockDollar({ stdout: porcelain });
    const result = await listWorktrees({ $: $mock });

    expect(result).toHaveLength(2);
    expect(result[1].branch).toBe('so-worktree-wave1');
    expect(result[1].path).toBe('/tmp/so-worktrees/so-worktree-wave1');
  });

  it('handles trailing record without trailing blank line', async () => {
    // No trailing newline — tests the flush-after-loop logic.
    const $mock = makeMockDollar({ stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main' });
    const result = await listWorktrees({ $: $mock });

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/repo');
  });

  it('returns empty branch string when branch line is absent', async () => {
    const $mock = makeMockDollar({ stdout: 'worktree /repo\nHEAD abc\n\n' });
    const result = await listWorktrees({ $: $mock });

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

    await applyWorktreeExcludes(sandbox, ['node_modules']);

    expect(existsSync(targetDir)).toBe(false);
  });

  it('preserves directories not in patterns', async () => {
    mkdirSync(join(sandbox, 'src'));
    mkdirSync(join(sandbox, 'node_modules'));

    await applyWorktreeExcludes(sandbox, ['node_modules']);

    expect(existsSync(join(sandbox, 'src'))).toBe(true);
    expect(existsSync(join(sandbox, 'node_modules'))).toBe(false);
  });

  it('resolves without throwing when patterns is empty', async () => {
    mkdirSync(join(sandbox, 'node_modules'));

    await expect(applyWorktreeExcludes(sandbox, [])).resolves.toBeUndefined();

    expect(existsSync(join(sandbox, 'node_modules'))).toBe(true);
  });

  it('resolves without throwing when a pattern does not exist', async () => {
    await expect(applyWorktreeExcludes(sandbox, ['does-not-exist'])).resolves.toBeUndefined();
  });

  it('does not descend — nested node_modules inside src survives', async () => {
    const nestedDir = join(sandbox, 'src', 'node_modules');
    mkdirSync(nestedDir, { recursive: true });

    await applyWorktreeExcludes(sandbox, ['node_modules']);

    // Top-level does not exist, nested must survive.
    expect(existsSync(nestedDir)).toBe(true);
  });

  it('removes multiple matching directories', async () => {
    mkdirSync(join(sandbox, 'dist'));
    mkdirSync(join(sandbox, '.next'));

    await applyWorktreeExcludes(sandbox, ['dist', '.next']);

    expect(existsSync(join(sandbox, 'dist'))).toBe(false);
    expect(existsSync(join(sandbox, '.next'))).toBe(false);
  });
});
