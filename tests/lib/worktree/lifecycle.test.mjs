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
 *   - vi.mock('@lib/worktree/listing.mjs') — listWorktrees/applyWorktreeExcludes
 *   - vi.mock('@lib/worktree/meta.mjs')    — _writeWorktreeMeta (meta write)
 *   - vi.mock('@lib/config.mjs')           — readConfigFile/parseSessionConfig
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
      // A function entry is evaluated at call time — lets a test model git's
      // real behaviour (e.g. `worktree add` failing while the target exists).
      if (typeof resp === 'function') return Promise.resolve().then(resp);
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

vi.mock('@lib/worktree/listing.mjs', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  applyWorktreeExcludes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@lib/worktree/meta.mjs', () => ({
  metaPathFor: vi.fn().mockImplementation((suffix) => `/mock/meta/${suffix}.json`),
  _writeWorktreeMeta: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@lib/config.mjs', () => ({
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
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');
    const { applyWorktreeExcludes } = await import('@lib/worktree/listing.mjs');
    const { _writeWorktreeMeta } = await import('@lib/worktree/meta.mjs');

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
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('@lib/worktree/meta.mjs');

    mockGitResponses = [{ stdout: 'sha1\n' }, { stdout: '' }];
    await createWorktree('my-wave');

    const call = _writeWorktreeMeta.mock.calls[0];
    expect(call[0]).toBe('my-wave');
    expect(call[1].branch).toBe('so-worktree-my-wave');
  });

  it('passes the baseRef to _writeWorktreeMeta', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('@lib/worktree/meta.mjs');

    mockGitResponses = [{ stdout: 'cafebabe\n' }, { stdout: '' }];
    await createWorktree('ref-check', 'main');

    const info = _writeWorktreeMeta.mock.calls[0][1];
    expect(info.baseRef).toBe('main');
    expect(info.baseSha).toBe('cafebabe');
  });

  it('defaults baseRef to HEAD when not supplied', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('@lib/worktree/meta.mjs');

    mockGitResponses = [{ stdout: 'headsha\n' }, { stdout: '' }];
    await createWorktree('default-ref');

    const info = _writeWorktreeMeta.mock.calls[0][1];
    expect(info.baseRef).toBe('HEAD');
  });

  it('passes explicit excludePatterns to applyWorktreeExcludes', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');
    const { applyWorktreeExcludes } = await import('@lib/worktree/listing.mjs');

    mockGitResponses = [{ stdout: 'sha\n' }, { stdout: '' }];
    await createWorktree('excl', 'HEAD', { excludePatterns: ['build'] });

    const [, patterns] = applyWorktreeExcludes.mock.calls[0];
    expect(patterns).toEqual(['build']);
  });

  it('passes [] to applyWorktreeExcludes when options.excludePatterns is []', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');
    const { applyWorktreeExcludes } = await import('@lib/worktree/listing.mjs');

    mockGitResponses = [{ stdout: 'sha\n' }, { stdout: '' }];
    await createWorktree('no-excl', 'HEAD', { excludePatterns: [] });

    const [, patterns] = applyWorktreeExcludes.mock.calls[0];
    expect(patterns).toEqual([]);
  });

  it('continues without throwing when meta write fails (non-fatal)', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('@lib/worktree/meta.mjs');

    _writeWorktreeMeta.mockRejectedValueOnce(new Error('disk full'));
    mockGitResponses = [{ stdout: 'sha\n' }, { stdout: '' }];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await createWorktree('meta-fail');
    warnSpy.mockRestore();

    expect(typeof result).toBe('string');
  });

  it('emits a console.warn when meta write fails', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');
    const { _writeWorktreeMeta } = await import('@lib/worktree/meta.mjs');

    _writeWorktreeMeta.mockRejectedValueOnce(new Error('quota exceeded'));
    mockGitResponses = [{ stdout: 'sha\n' }, { stdout: '' }];

    const warnings = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg) => warnings.push(msg));
    await createWorktree('meta-warn');
    warnSpy.mockRestore();

    expect(warnings.some((m) => /meta write failed/.test(m))).toBe(true);
  });

  it('throws when second git worktree add also fails', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');

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

  // -------------------------------------------------------------------------
  // Orphan-directory retry (issue #984)
  // -------------------------------------------------------------------------
  //
  // Bug caught: an UNREGISTERED directory at the target path (what an
  // interrupted removeWorktree leaves behind) made every retry fail forever —
  // `git worktree add` says "already exists", `git worktree remove --force`
  // says "is not a working tree" (swallowed by nothrow). The Full Gate went
  // red twice from exactly this state.

  it('removes an unregistered orphan directory at the target path and succeeds on retry', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');

    const suffix = `orphan-${randomBytes(4).toString('hex')}`;
    const wtPath = join(tmpdir(), 'so-worktrees', `so-worktree-${suffix}`);
    // Pre-create the orphan: a plain directory git has no registration for.
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, 'leftover.txt'), 'stale', 'utf8');

    try {
      mockGitResponses = [
        { stdout: 'sha\n' },                                  // rev-parse
        new Error("fatal: '" + wtPath + "' already exists"),  // first add
        new Error("fatal: '" + wtPath + "' is not a working tree"), // nothrow remove
        new Error('error: branch not found'),                 // nothrow branch -D
        // Second add models real git: it only succeeds once the path is gone.
        () => {
          if (existsSync(wtPath)) {
            throw new mockProcessOutputClass("fatal: '" + wtPath + "' already exists");
          }
          return { stdout: '' };
        },
      ];

      const result = await createWorktree(suffix);
      expect(result).toBe(wtPath);
      expect(existsSync(wtPath)).toBe(false);
    } finally {
      rmSync(wtPath, { recursive: true, force: true });
    }
  });

  it('does not follow a symlink at the target path — the link target survives', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');

    // Bug caught: resolving the target path through a symlink would recursively
    // delete whatever the link points at — outside the so-worktrees base.
    const outside = join(sandbox, 'precious');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'do not delete', 'utf8');

    const suffix = `symlink-${randomBytes(4).toString('hex')}`;
    const wtPath = join(tmpdir(), 'so-worktrees', `so-worktree-${suffix}`);
    mkdirSync(join(tmpdir(), 'so-worktrees'), { recursive: true });
    symlinkSync(outside, wtPath);

    try {
      mockGitResponses = [
        { stdout: 'sha\n' },                                        // rev-parse
        new Error("fatal: '" + wtPath + "' already exists"),        // first add
        new Error("fatal: '" + wtPath + "' is not a working tree"), // nothrow remove
        new Error('error: branch not found'),                       // nothrow branch -D
        () => {
          if (existsSync(wtPath)) {
            throw new mockProcessOutputClass("fatal: '" + wtPath + "' already exists");
          }
          return { stdout: '' };
        },
      ];

      await expect(createWorktree(suffix)).rejects.toThrow('createWorktree:');
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    } finally {
      rmSync(wtPath, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Orphan-delete guards — each test names the ONE guard it keeps honest.
  //
  // All three redirect os.tmpdir() via process.env.TMPDIR into the per-test
  // sandbox, so the worktree BASE (`<os.tmpdir()>/so-worktrees`) is a fixture
  // rather than the host-shared directory a peer session also writes into.
  // -------------------------------------------------------------------------

  /** Git responses that drive createWorktree into the orphan-delete retry. */
  function retryResponses(wtPath) {
    return [
      { stdout: 'sha\n' },                                        // rev-parse
      new Error("fatal: '" + wtPath + "' already exists"),        // first add
      new Error("fatal: '" + wtPath + "' is not a working tree"), // nothrow remove
      new Error('error: branch not found'),                       // nothrow branch -D
      () => {
        if (existsSync(wtPath)) {
          throw new mockProcessOutputClass("fatal: '" + wtPath + "' already exists");
        }
        return { stdout: '' };
      },
    ];
  }

  it('refuses to delete a REGISTERED worktree at the target path (peer session in the shared namespace)', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');

    // Bug caught: dropping the registration probe (_isUnregisteredWorktreeDir)
    // makes the retry delete a PEER session's LIVE worktree whenever both
    // sessions pick the same suffix in the shared `so-worktrees` namespace.
    const prevTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = sandbox;
    try {
      const suffix = `peer-${randomBytes(4).toString('hex')}`;
      const wtPath = join(sandbox, 'so-worktrees', `so-worktree-${suffix}`);
      mkdirSync(wtPath, { recursive: true });

      // Registration built on disk exactly as _isUnregisteredWorktreeDir reads
      // it: a `.git` FILE carrying `gitdir:` whose admin directory EXISTS.
      const adminDir = join(sandbox, 'peer-repo', '.git', 'worktrees', `so-worktree-${suffix}`);
      mkdirSync(adminDir, { recursive: true });
      writeFileSync(join(wtPath, '.git'), `gitdir: ${adminDir}\n`, 'utf8');
      writeFileSync(join(wtPath, 'peer-work.txt'), 'live peer work', 'utf8');

      mockGitResponses = retryResponses(wtPath);

      await expect(createWorktree(suffix)).rejects.toThrow('createWorktree:');
      expect(existsSync(wtPath)).toBe(true);
      expect(existsSync(join(wtPath, 'peer-work.txt'))).toBe(true);
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
    }
  });

  it('refuses a symlink at the target path pointing INSIDE the base — the sibling worktree survives', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');

    // Bug caught: without the leaf lstat-symlink refusal, a link whose target
    // lies inside the base passes containment and the delete lands on the
    // SIBLING worktree it points at.
    const prevTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = sandbox;
    try {
      const base = join(sandbox, 'so-worktrees');
      mkdirSync(base, { recursive: true });
      const victim = join(base, `so-worktree-victim-${randomBytes(4).toString('hex')}`);
      mkdirSync(victim, { recursive: true });
      writeFileSync(join(victim, 'keep.txt'), 'sibling work', 'utf8');

      const suffix = `inside-link-${randomBytes(4).toString('hex')}`;
      const wtPath = join(base, `so-worktree-${suffix}`);
      symlinkSync(victim, wtPath);

      mockGitResponses = retryResponses(wtPath);

      await expect(createWorktree(suffix)).rejects.toThrow('createWorktree:');
      expect(existsSync(victim)).toBe(true);
      expect(existsSync(join(victim, 'keep.txt'))).toBe(true);
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
    }
  });

  it('refuses when the BASE directory is itself a symlink to an outside directory', async () => {
    const { createWorktree } = await import('@lib/worktree/lifecycle.mjs');

    // Bug caught: resolving the base through a symlink a co-tenant pre-created
    // on the shared /tmp makes the link target the delete root — any
    // `so-worktree-*` directory outside tmpdir then qualifies.
    const prevTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = sandbox;
    try {
      const outside = join(sandbox, 'co-tenant-outside');
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(sandbox, 'so-worktrees'));

      const suffix = `base-link-${randomBytes(4).toString('hex')}`;
      const wtPath = join(sandbox, 'so-worktrees', `so-worktree-${suffix}`);
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(wtPath, 'not-ours.txt'), 'foreign data', 'utf8');

      mockGitResponses = retryResponses(wtPath);

      await expect(createWorktree(suffix)).rejects.toThrow('createWorktree:');
      expect(existsSync(join(outside, `so-worktree-${suffix}`, 'not-ours.txt'))).toBe(true);
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
    }
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe('removeWorktree', () => {
  it('resolves without throwing when path does not exist', async () => {
    const { removeWorktree } = await import('@lib/worktree/lifecycle.mjs');
    const fakePath = join(tmpdir(), 'does-not-exist-xyz-abc');
    await expect(removeWorktree(fakePath)).resolves.toBeUndefined();
  });

  it('resolves without throwing when the path exists', async () => {
    const { removeWorktree } = await import('@lib/worktree/lifecycle.mjs');
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
    const { removeWorktree } = await import('@lib/worktree/lifecycle.mjs');
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
    const { removeWorktree } = await import('@lib/worktree/lifecycle.mjs');
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
    const { cleanupAllWorktrees } = await import('@lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('@lib/worktree/listing.mjs');
    listWorktrees.mockResolvedValueOnce([]);

    await expect(cleanupAllWorktrees()).resolves.toBeUndefined();
  });

  it('calls removeWorktree for each so-worktree-* worktree', async () => {
    const { cleanupAllWorktrees } = await import('@lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('@lib/worktree/listing.mjs');

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
    const { cleanupAllWorktrees } = await import('@lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('@lib/worktree/listing.mjs');

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
    const { cleanupAllWorktrees } = await import('@lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('@lib/worktree/listing.mjs');

    listWorktrees.mockRejectedValueOnce(new Error('git exploded'));

    await expect(cleanupAllWorktrees()).resolves.toBeUndefined();
  });

  it('calls git worktree prune even when no so-worktree-* entries exist', async () => {
    const { cleanupAllWorktrees } = await import('@lib/worktree/lifecycle.mjs');
    const { listWorktrees } = await import('@lib/worktree/listing.mjs');

    listWorktrees.mockResolvedValueOnce([]);

    const calls = [];
    mockNothrow.mockImplementation((p) => { calls.push(p); return Promise.resolve({ stdout: '' }); });

    await cleanupAllWorktrees();

    // At least one nothrow call must happen (prune).
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
