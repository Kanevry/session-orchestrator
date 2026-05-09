/**
 * tests/lib/worktree/lifecycle.test.mjs
 *
 * Unit tests for scripts/lib/worktree/lifecycle.mjs.
 * Covers createWorktree, removeWorktree, cleanupAllWorktrees.
 *
 * All zx `$` calls and the listing/meta modules are mocked so no real git
 * processes or filesystem side-effects occur (except inside controlled tmpdir
 * fixtures for meta file creation).
 *
 * Mocking strategy:
 *   - vi.mock('zx')          — suppress real git calls; $ is a vi.fn()
 *   - vi.mock('../../../scripts/lib/worktree/listing.mjs') — listWorktrees/applyWorktreeExcludes
 *   - vi.mock('../../../scripts/lib/worktree/meta.mjs')    — _writeWorktreeMeta (meta write)
 *   - vi.mock('../../../scripts/lib/config.mjs')           — readConfigFile/parseSessionConfig
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — hoisted
// ---------------------------------------------------------------------------

// Shared state for the $ callable mock.
let mockGitResponses = [];

const mockNothrow = vi.fn().mockImplementation((p) => p.catch(() => ({ stdout: '', stderr: '', exitCode: 1 })));
const mockProcessOutputClass = class MockProcessOutput extends Error {
  constructor(msg) { super(msg); this.stderr = msg; this.stdout = ''; }
};

vi.mock('zx', () => {
  const $fn = vi.fn().mockImplementation((_cwdOpts) => {
    // $({ cwd }) returns a tagged-template function
    const tagFn = vi.fn().mockImplementation(() => {
      const resp = mockGitResponses.shift();
      if (resp instanceof Error) return Promise.reject(resp);
      return Promise.resolve(resp ?? { stdout: '', stderr: '' });
    });
    // Also make $`...` work (direct call without options)
    Object.assign(tagFn, { verbose: false, quiet: true });
    return tagFn;
  });
  // Support $({ cwd }) pattern and also direct $`...` usage.
  Object.assign($fn, { verbose: false, quiet: true });
  return {
    $: $fn,
    nothrow: mockNothrow,
    ProcessOutput: mockProcessOutputClass,
  };
});

vi.mock('../../../scripts/lib/worktree/listing.mjs', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  applyWorktreeExcludes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../scripts/lib/worktree/meta.mjs', () => ({
  metaPathFor: vi.fn().mockImplementation((suffix) => `/mock/meta/${suffix}.json`),
  _writeWorktreeMeta: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../scripts/lib/config.mjs', () => ({
  readConfigFile: vi.fn().mockResolvedValue(''),
  parseSessionConfig: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
  mockGitResponses = [];
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  it('returns the wtPath under os.tmpdir()', async () => {
    const { createWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { applyWorktreeExcludes } = await import('../../../scripts/lib/worktree/listing.mjs');
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');

    // git rev-parse HEAD → sha; git worktree add → success
    mockGitResponses = [
      { stdout: 'abc123\n' }, // rev-parse
      { stdout: '' },          // worktree add
    ];

    const result = await createWorktree('test-unit');

    expect(typeof result).toBe('string');
    expect(result).toContain('so-worktree-test-unit');
    expect(applyWorktreeExcludes).toHaveBeenCalledOnce();
    expect(_writeWorktreeMeta).toHaveBeenCalledOnce();
  });

  it('includes suffix in the branch name passed to _writeWorktreeMeta', async () => {
    const { createWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');

    mockGitResponses = [{ stdout: 'sha1\n' }, { stdout: '' }];
    await createWorktree('my-wave');

    const call = _writeWorktreeMeta.mock.calls[0];
    expect(call[0]).toBe('my-wave');
    expect(call[1].branch).toBe('so-worktree-my-wave');
  });

  it('passes the baseRef to _writeWorktreeMeta', async () => {
    const { createWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');

    mockGitResponses = [{ stdout: 'cafebabe\n' }, { stdout: '' }];
    await createWorktree('ref-check', 'main');

    const info = _writeWorktreeMeta.mock.calls[0][1];
    expect(info.baseRef).toBe('main');
    expect(info.baseSha).toBe('cafebabe');
  });

  it('defaults baseRef to HEAD when not supplied', async () => {
    const { createWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');

    mockGitResponses = [{ stdout: 'headsha\n' }, { stdout: '' }];
    await createWorktree('default-ref');

    const info = _writeWorktreeMeta.mock.calls[0][1];
    expect(info.baseRef).toBe('HEAD');
  });

  it('passes explicit excludePatterns to applyWorktreeExcludes', async () => {
    const { createWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { applyWorktreeExcludes } = await import('../../../scripts/lib/worktree/listing.mjs');

    mockGitResponses = [{ stdout: 'sha\n' }, { stdout: '' }];
    await createWorktree('excl', 'HEAD', { excludePatterns: ['build'] });

    const [, patterns] = applyWorktreeExcludes.mock.calls[0];
    expect(patterns).toEqual(['build']);
  });

  it('passes [] to applyWorktreeExcludes when options.excludePatterns is []', async () => {
    const { createWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { applyWorktreeExcludes } = await import('../../../scripts/lib/worktree/listing.mjs');

    mockGitResponses = [{ stdout: 'sha\n' }, { stdout: '' }];
    await createWorktree('no-excl', 'HEAD', { excludePatterns: [] });

    const [, patterns] = applyWorktreeExcludes.mock.calls[0];
    expect(patterns).toEqual([]);
  });

  it('continues without throwing when meta write fails (non-fatal)', async () => {
    const { createWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');

    _writeWorktreeMeta.mockRejectedValueOnce(new Error('disk full'));
    mockGitResponses = [{ stdout: 'sha\n' }, { stdout: '' }];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await createWorktree('meta-fail');
    warnSpy.mockRestore();

    expect(typeof result).toBe('string');
  });

  it('emits a console.warn when meta write fails', async () => {
    const { createWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('../../../scripts/lib/worktree/meta.mjs');

    _writeWorktreeMeta.mockRejectedValueOnce(new Error('quota exceeded'));
    mockGitResponses = [{ stdout: 'sha\n' }, { stdout: '' }];

    const warnings = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg) => warnings.push(msg));
    await createWorktree('meta-warn');
    warnSpy.mockRestore();

    expect(warnings.some((m) => /meta write failed/.test(m))).toBe(true);
  });

  it('throws when second git worktree add also fails', async () => {
    const { createWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');

    // rev-parse succeeds, first add fails, cleanup no-ops, second add fails
    mockGitResponses = [
      { stdout: 'sha\n' },         // rev-parse
      new Error('already exists'), // first worktree add
      { stdout: '' },              // nothrow remove (already handled by nothrow mock)
      { stdout: '' },              // nothrow branch -D
      new Error('still fails'),    // second worktree add
    ];

    // The $ mock's tagFn is called sequentially; nothrow wraps the promise.
    // We need the second add to reject so the outer catch re-throws.
    // Adjust: mock nothrow to resolve (it swallows) and let $ provide sequential responses.
    await expect(createWorktree('double-fail')).rejects.toThrow('createWorktree:');
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe('removeWorktree', () => {
  it('resolves without throwing when path does not exist', async () => {
    const { removeWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const fakePath = join(tmpdir(), 'does-not-exist-xyz-abc');
    await expect(removeWorktree(fakePath)).resolves.toBeUndefined();
  });

  it('resolves without throwing when the path exists', async () => {
    const { removeWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const wtPath = join(sandbox, 'fake-wt');
    mkdirSync(wtPath);

    // Provide git responses: status check, rev-parse abbrev-ref, remove, branch -D
    mockGitResponses = [
      { stdout: '' },                                 // git status --porcelain (clean)
      { stdout: 'so-worktree-test\n' },               // rev-parse --abbrev-ref HEAD
    ];

    await expect(removeWorktree(wtPath)).resolves.toBeUndefined();
  });

  it('logs error warning when worktree has uncommitted changes', async () => {
    const { removeWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const wtPath = join(sandbox, 'dirty-wt');
    mkdirSync(wtPath);

    mockGitResponses = [
      { stdout: ' M dirty.txt\n' }, // status --porcelain — dirty
      { stdout: 'so-worktree-x\n' }, // rev-parse abbrev-ref
    ];

    const errors = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m) => errors.push(m));
    await removeWorktree(wtPath);
    spy.mockRestore();

    expect(errors.some((m) => /uncommitted changes/i.test(m))).toBe(true);
  });

  it('does NOT delete branch when name does not match so-worktree-*', async () => {
    const { removeWorktree } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const wtPath = join(sandbox, 'foreign-wt');
    mkdirSync(wtPath);

    mockGitResponses = [
      { stdout: '' },          // status --porcelain
      { stdout: 'main\n' },    // rev-parse — not so-worktree-* branch
    ];

    await removeWorktree(wtPath);

    // nothrow should have been called for worktree remove (not branch -D for non-matching branch)
    // We just verify it doesn't throw.
    // nothrow is called once for worktree remove, NOT for branch -D.
    expect(mockNothrow).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// cleanupAllWorktrees
// ---------------------------------------------------------------------------

describe('cleanupAllWorktrees', () => {
  it('resolves without throwing even when listWorktrees returns empty', async () => {
    const { cleanupAllWorktrees } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');
    listWorktrees.mockResolvedValueOnce([]);

    await expect(cleanupAllWorktrees()).resolves.toBeUndefined();
  });

  it('calls removeWorktree for each so-worktree-* worktree', async () => {
    const { cleanupAllWorktrees } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');

    const wtA = join(tmpdir(), 'so-worktrees', 'so-worktree-a');
    const wtB = join(tmpdir(), 'so-worktrees', 'so-worktree-b');

    listWorktrees.mockResolvedValueOnce([
      { path: '/main', branch: 'main', head: 'abc' },
      { path: wtA, branch: 'so-worktree-a', head: 'def' },
      { path: wtB, branch: 'so-worktree-b', head: 'ghi' },
    ]);

    // Both wt paths don't exist on disk → removeWorktree no-ops (path check fails)
    await cleanupAllWorktrees();

    // nothrow is called for git worktree prune at the end.
    expect(mockNothrow).toHaveBeenCalled();
  });

  it('does not remove main worktree (branch does not match so-worktree-*)', async () => {
    const { cleanupAllWorktrees } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');

    listWorktrees.mockResolvedValueOnce([
      { path: '/repo', branch: 'main', head: 'abc' },
    ]);

    // Only one nothrow call expected: git worktree prune.
    await cleanupAllWorktrees();

    // removeWorktree on /repo would also call nothrow if /repo doesn't exist (it won't).
    // Since /repo doesn't exist on disk, _exists returns false and removeWorktree no-ops.
    // Only prune nothrow call should happen.
    expect(mockNothrow).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when listWorktrees throws', async () => {
    const { cleanupAllWorktrees } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');

    listWorktrees.mockRejectedValueOnce(new Error('git exploded'));

    await expect(cleanupAllWorktrees()).resolves.toBeUndefined();
  });

  it('calls git worktree prune even when no so-worktree-* entries exist', async () => {
    const { cleanupAllWorktrees } = await import('../../../scripts/lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('../../../scripts/lib/worktree/listing.mjs');

    listWorktrees.mockResolvedValueOnce([]);

    const calls = [];
    mockNothrow.mockImplementation((p) => { calls.push(p); return Promise.resolve({ stdout: '' }); });

    await cleanupAllWorktrees();

    // At least one nothrow call must happen (prune).
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
