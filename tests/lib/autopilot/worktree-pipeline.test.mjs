/**
 * tests/lib/autopilot/worktree-pipeline.test.mjs
 *
 * Unit tests for scripts/lib/autopilot/worktree-pipeline.mjs.
 * Covers: constants, custom error classes, setupWorktree, teardownWorktree,
 * and runStoryPipeline with DI seams via opts.{$, loopRunner, lockAcquire,
 * gcOnExit, draftMrCreator, nowMs}.
 *
 * Uses DI seams throughout — zero vi.mock() of actual modules (deep-2 #367 lesson).
 * Real filesystem via mkdtempSync for path-related tests; mocked everywhere else.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, realpathSync as realRealpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  WORKTREE_ROOT_DEFAULT,
  WorktreeBoundaryError,
  WorktreeLockedError,
  setupWorktree,
  teardownWorktree,
  runStoryPipeline,
  relativeWorktreePath,
} from '@lib/autopilot/worktree-pipeline.mjs';
import { assertErrorShape } from '../../_helpers/assert-error-shape.mjs';

// ---------------------------------------------------------------------------
// DI factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock for opts.$ in worktree-pipeline.
 *
 * The production code uses it directly as a tagged template literal:
 *   const exec = opts.$ ?? realZx;
 *   await exec`git -C ${repoRoot} worktree add ...`
 *
 * So opts.$ IS the tag function (not a function returning a tag function).
 * We return a vi.fn() that behaves as a tag fn and resolves/rejects based on
 * call count when firstThrows=true.
 */
function makeMockDollar({ firstThrows = false } = {}) {
  let callCount = 0;
  const tagFn = vi.fn().mockImplementation(() => {
    callCount += 1;
    if (firstThrows && callCount === 1) {
      return Promise.reject(new Error('git failure: origin/main not found'));
    }
    return Promise.resolve({ stdout: '' });
  });
  // Expose the tagFn itself as the $ DI seam.
  return tagFn;
}

function makeContext({ issueIid = 99, ...overrides } = {}) {
  return {
    issueIid,
    issueTitle: 'Test issue',
    branchName: `issue-${issueIid}`,
    parentRunId: 'parent-run-id',
    repoRoot: '/tmp/fake-repo',
    ...overrides,
  };
}

function makeLoopResult(overrides = {}) {
  return {
    autopilot_run_id: 'r1',
    kill_switch: null,
    kill_switch_detail: null,
    iterations_completed: 1,
    stall_recovery_count: 0,
    worktree_path: '/tmp/wt',
    ...overrides,
  };
}

function makeOpts(overrides = {}) {
  return {
    $: makeMockDollar(),
    loopRunner: vi.fn().mockResolvedValue(makeLoopResult()),
    lockAcquire: vi.fn().mockReturnValue({
      ok: true,
      lock: { session_id: 'test-lock' },
      release: vi.fn(),
    }),
    gcOnExit: vi.fn().mockResolvedValue({}),
    draftMrCreator: vi.fn().mockResolvedValue({ created: false }),
    nowMs: () => 2_000_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wp-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. WORKTREE_ROOT_DEFAULT
// ---------------------------------------------------------------------------

describe('WORKTREE_ROOT_DEFAULT', () => {
  it('is a string ending with .so-worktrees', () => {
    expect(typeof WORKTREE_ROOT_DEFAULT).toBe('string');
    expect(WORKTREE_ROOT_DEFAULT.endsWith('.so-worktrees')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. WorktreeBoundaryError
// ---------------------------------------------------------------------------

describe('WorktreeBoundaryError', () => {
  it('carries the Error prototype chain, .name and .message', () => {
    assertErrorShape(new WorktreeBoundaryError('test message'), {
      ctor: WorktreeBoundaryError,
      name: 'WorktreeBoundaryError',
      message: 'test message',
    });
  });

  it('carries the message and meta fields', () => {
    const err = new WorktreeBoundaryError('bad path', {
      computed: '/evil/../etc/passwd',
      root: '/safe-root',
    });
    expect(err.message).toBe('bad path');
    expect(err.computed).toBe('/evil/../etc/passwd');
    expect(err.root).toBe('/safe-root');
  });
});

// ---------------------------------------------------------------------------
// 3. WorktreeLockedError
// ---------------------------------------------------------------------------

describe('WorktreeLockedError', () => {
  it('carries the Error prototype chain, .name and .message', () => {
    assertErrorShape(new WorktreeLockedError('locked'), {
      ctor: WorktreeLockedError,
      name: 'WorktreeLockedError',
      message: 'locked',
    });
  });

  it('stores existingLock and lockReason from meta', () => {
    const existingLock = { session_id: 'old-session' };
    const err = new WorktreeLockedError('locked', {
      existingLock,
      reason: 'already-running',
    });
    expect(err.existingLock).toEqual({ session_id: 'old-session' });
    expect(err.lockReason).toBe('already-running');
  });
});

// ---------------------------------------------------------------------------
// 4. setupWorktree
// ---------------------------------------------------------------------------

describe('setupWorktree', () => {
  it('computes wtPath as worktreeRoot / repoBasename / issueIid', async () => {
    const worktreeRoot = path.join(tmp, 'wt-root');
    mkdirSync(worktreeRoot, { recursive: true });

    const repoRoot = path.join(tmp, 'my-repo');
    const $mock = makeMockDollar();

    const ctx = makeContext({ repoRoot, worktreeRoot, issueIid: 42 });
    const result = await setupWorktree(ctx, { $: $mock });

    // Use the resolved worktreeRoot because setupWorktree now resolves symlinks
    // (macOS /var → /private/var gotcha — mirrors #374/#375 fix).
    const resolvedRoot = realRealpathSync(worktreeRoot);
    const expectedPath = path.join(resolvedRoot, 'my-repo', '42');
    expect(result.wtPath).toBe(expectedPath);
  });

  it('returns reused: false and calls $ git worktree add when path does not exist', async () => {
    const worktreeRoot = path.join(tmp, 'wt-root');
    mkdirSync(worktreeRoot, { recursive: true });

    const repoRoot = path.join(tmp, 'proj');
    const $mock = makeMockDollar();

    const ctx = makeContext({ repoRoot, worktreeRoot, issueIid: 7 });
    const result = await setupWorktree(ctx, { $: $mock });

    expect(result.reused).toBe(false);
    expect($mock).toHaveBeenCalled();
  });

  it('returns reused: true and does NOT call $ when wtPath already has a .git file', async () => {
    const worktreeRoot = path.join(tmp, 'wt-root');
    mkdirSync(worktreeRoot, { recursive: true });
    const repoRoot = path.join(tmp, 'my-proj');
    // Use resolved root so the fixture path matches the resolved wtPath the
    // production code derives after realpathSync (macOS /var→/private/var).
    const resolvedRoot = realRealpathSync(worktreeRoot);
    const wtPath = path.join(resolvedRoot, 'my-proj', '55');

    mkdirSync(wtPath, { recursive: true });
    writeFileSync(path.join(wtPath, '.git'), 'gitdir: ../.git/worktrees/55');

    const $mock = makeMockDollar();
    const ctx = makeContext({ repoRoot, worktreeRoot, issueIid: 55 });
    const result = await setupWorktree(ctx, { $: $mock });

    expect(result.reused).toBe(true);
    expect(result.wtPath).toBe(wtPath);
    expect($mock).not.toHaveBeenCalled();
  });

  it('throws WorktreeBoundaryError when computed path escapes worktreeRoot via traversal', async () => {
    // path.basename('/some/path/..') === '..'
    // So: wtPath = join(worktreeRoot, '..', issueIid) which normalises to
    // join(dirname(worktreeRoot), issueIid) — one level above worktreeRoot.
    // validateWorkspacePath uses isPathInside which returns false → WorktreeBoundaryError.
    const worktreeRoot = path.join(tmp, 'safe-root');
    mkdirSync(worktreeRoot, { recursive: true });

    const escapingCtx = {
      issueIid: 1,
      issueTitle: 'x',
      branchName: 'b',
      parentRunId: 'p',
      repoRoot: '/some/path/..', // basename === '..'
      worktreeRoot,
    };

    await expect(setupWorktree(escapingCtx, { $: makeMockDollar() }))
      .rejects.toBeInstanceOf(WorktreeBoundaryError);
  });

  it('falls back to HEAD when git worktree add with origin/main fails', async () => {
    const worktreeRoot = path.join(tmp, 'wt-root');
    mkdirSync(worktreeRoot, { recursive: true });

    const repoRoot = path.join(tmp, 'repo');
    const $mock = makeMockDollar({ firstThrows: true });

    const ctx = makeContext({ repoRoot, worktreeRoot, issueIid: 10 });
    const result = await setupWorktree(ctx, { $: $mock });

    // Should not throw and should still return a result
    expect(result.reused).toBe(false);
    // $ should have been called at least twice (first throw, then HEAD fallback)
    expect($mock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('adversarial: realpathSync returning an out-of-tree path causes WorktreeBoundaryError', async () => {
    // Verify the security invariant: when realpathSync resolves wtPath to a path
    // outside worktreeRoot (symlink-escape scenario), setupWorktree MUST throw
    // WorktreeBoundaryError and NOT proceed to git worktree add.
    //
    // Pattern: vi.doMock + dynamic re-import (mirrors #374 / deep-1 #370 approach).
    // We intercept node:fs to inject an adversarial realpathSync that returns an
    // out-of-tree path while keeping fs.existsSync returning false (no-op path).
    //
    // Observable invariants verified:
    //  1. WorktreeBoundaryError is thrown (guard fires)
    //  2. The error message contains the resolved out-of-tree path
    //  3. git worktree add (opts.$) is NOT called (attack blocked before FS write)
    //  4. Stderr contains the symlink-escape warning
    const worktreeRoot = path.join(tmp, 'safe-root');
    mkdirSync(worktreeRoot, { recursive: true });
    // Resolve the real worktreeRoot to handle macOS /var→/private/var before
    // injecting the mock (the production code resolves it with realpathSync too).
    const resolvedWorktreeRoot = realRealpathSync(worktreeRoot);
    const outOfTreePath = path.join(tmp, 'EVIL-OUTSIDE-ROOT', 'escaped');

    // Spy on stderr to capture the rejection message.
    const stderrChunks = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      return {
        ...actual,
        realpathSync: (p) => {
          // For the worktreeRoot resolution call, return the real resolved root.
          if (p === worktreeRoot) return resolvedWorktreeRoot;
          // For the wtPath resolution call, simulate a symlink escape.
          return outOfTreePath;
        },
      };
    });

    const { setupWorktree: freshSetupWorktree, WorktreeBoundaryError: FreshWBE } =
      await import('@lib/autopilot/worktree-pipeline.mjs?adv-test-1');

    const repoRoot = path.join(tmp, 'my-repo');
    const ctx = {
      issueIid: 1,
      issueTitle: 'adv-test',
      branchName: 'issue-1',
      parentRunId: 'p',
      repoRoot,
      worktreeRoot,
    };
    const $mock = makeMockDollar();

    const thrownError = await freshSetupWorktree(ctx, { $: $mock }).catch((e) => e);

    // 1. Guard fires: WorktreeBoundaryError is thrown.
    expect(thrownError).toBeInstanceOf(FreshWBE);

    // 2. Error message contains the out-of-tree resolved path (not the raw wtPath).
    expect(thrownError.message).toContain(outOfTreePath);

    // 3. git worktree add must NOT have been called (attack blocked before FS write).
    expect($mock).not.toHaveBeenCalled();

    // 4. Stderr warning mirrors gc-stale-worktrees #374 format:
    //    "refusing to setup symlink-escape: <wtPath> → <resolved>"
    const stderrOutput = stderrChunks.join('');
    expect(stderrOutput).toMatch(/refusing to setup symlink-escape:/);
    expect(stderrOutput).toContain(outOfTreePath);

    stderrSpy.mockRestore();
    vi.doUnmock('node:fs');
  });
});

// ---------------------------------------------------------------------------
// 5. teardownWorktree
// ---------------------------------------------------------------------------

describe('teardownWorktree', () => {
  it('calls gcOnExit with apply:true when killSwitch is null', async () => {
    const gcOnExit = vi.fn().mockResolvedValue({});
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: tmp });
    const result = { killSwitch: null, worktreePath: '/tmp/wt', _lockSessionId: null };

    await teardownWorktree(ctx, result, { gcOnExit });

    expect(gcOnExit).toHaveBeenCalledOnce();
    expect(gcOnExit).toHaveBeenCalledWith(
      expect.objectContaining({ apply: true }),
    );
  });

  it('does NOT call gcOnExit when killSwitch is stall-timeout', async () => {
    const gcOnExit = vi.fn().mockResolvedValue({});
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: tmp });
    const result = { killSwitch: 'stall-timeout', worktreePath: '/tmp/wt', _lockSessionId: null };

    await teardownWorktree(ctx, result, { gcOnExit });

    expect(gcOnExit).not.toHaveBeenCalled();
  });

  it('swallows gcOnExit exceptions and does not re-throw', async () => {
    const gcOnExit = vi.fn().mockRejectedValue(new Error('gc crashed'));
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: tmp });
    const result = { killSwitch: null, worktreePath: '/tmp/wt', _lockSessionId: null };

    await expect(teardownWorktree(ctx, result, { gcOnExit })).resolves.toBeUndefined();
  });

  it('calls gcOnExit when killSwitch is peer-abort (non-stall-timeout)', async () => {
    const gcOnExit = vi.fn().mockResolvedValue({});
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: tmp });
    const result = { killSwitch: 'peer-abort', worktreePath: '/tmp/wt', _lockSessionId: null };

    await teardownWorktree(ctx, result, { gcOnExit });

    expect(gcOnExit).toHaveBeenCalledOnce();
  });

  it('writes a REPO-RELATIVE worktree_path into the real events.jsonl record (#957)', async () => {
    // Bug caught: both lock-release emission sites wrote the ABSOLUTE worktree
    // path. events.jsonl records get quoted into issues and MR descriptions,
    // and this repo mirrors to a PUBLIC GitHub remote — so every such record
    // shipped `/Users/<operator>/…` into a public artefact.
    //
    // Asserted through the production call shape (real emitEvent, real file),
    // not against the helper in isolation: the defect was at the CALL SITE, so
    // a unit test of the formatter would have stayed green through it.
    const gcOnExit = vi.fn().mockResolvedValue({});
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: tmp, issueIid: 957 });
    // Default layout: the worktree root is `~/.so-worktrees`, i.e. OUTSIDE the
    // repo — so the honest relative form is a `../` chain, not a bare name.
    const worktreePath = path.join(path.dirname(tmp), 'so-worktrees', 'myrepo', '957');
    // No lock on disk ⇒ release() reports `no-lock` ⇒ the `released` branch.
    const result = { killSwitch: null, worktreePath, _lockSessionId: 'sess-957' };

    await teardownWorktree(ctx, result, { gcOnExit });

    const raw = readFileSync(path.join(tmp, '.orchestrator', 'metrics', 'events.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim().split('\n').at(-1));

    expect(record.event).toBe('orchestrator.session.lock.released');
    expect(record.worktree_path).toBe(path.join('..', 'so-worktrees', 'myrepo', '957'));
    // The load-bearing assertion: no absolute host path survives anywhere in
    // the record, however the fields are shaped.
    expect(path.isAbsolute(record.worktree_path)).toBe(false);
    expect(raw).not.toContain(tmp);
  });
});

// ---------------------------------------------------------------------------
// relativeWorktreePath — the #957 formatter contract
// ---------------------------------------------------------------------------

describe('relativeWorktreePath', () => {
  it('strips the shared host prefix and reports null rather than falling back to an absolute path', () => {
    // Bug caught: a fallback to the absolute path when the base is unusable
    // would reinstate exactly the leak this function exists to prevent, on the
    // one code path nobody looks at. Unknown must mean null, not "raw".
    const repo = path.join(path.sep, 'Users', 'alice', 'Projects', 'myrepo');

    // Default layout (`~/.so-worktrees`): escapes the repo, keeps no username.
    const homeWt = path.join(path.sep, 'Users', 'alice', '.so-worktrees', 'myrepo', '957');
    expect(relativeWorktreePath(repo, homeWt)).toBe(path.join('..', '..', '.so-worktrees', 'myrepo', '957'));
    expect(relativeWorktreePath(repo, homeWt)).not.toContain('alice');

    // Sibling of the repo root, and inside it — both host-agnostic.
    expect(relativeWorktreePath(repo, `${repo}-wt/957`)).toBe(path.join('..', 'myrepo-wt', '957'));
    expect(relativeWorktreePath(repo, path.join(repo, '.claude', 'worktrees', '957')))
      .toBe(path.join('.claude', 'worktrees', '957'));

    // Unusable inputs ⇒ null (the field's existing "unknown" value).
    expect(relativeWorktreePath(repo, null)).toBeNull();
    expect(relativeWorktreePath(repo, '')).toBeNull();
    expect(relativeWorktreePath(repo, undefined)).toBeNull();
    expect(relativeWorktreePath('', homeWt)).toBeNull();
    expect(relativeWorktreePath(undefined, homeWt)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. runStoryPipeline
// ---------------------------------------------------------------------------

describe('runStoryPipeline', () => {
  it('happy path: calls lockAcquire, loopRunner, gcOnExit, returns StoryResult', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts();
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot });

    const result = await runStoryPipeline(ctx, opts);

    expect(result.killSwitch).toBeNull();
    expect(result.issueIid).toBe(99);
    expect(opts.lockAcquire).toHaveBeenCalledOnce();
    expect(opts.loopRunner).toHaveBeenCalledOnce();
    expect(opts.gcOnExit).toHaveBeenCalledOnce();
  });

  it('result does not contain internal _lockSessionId field', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts();
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot });

    const result = await runStoryPipeline(ctx, opts);

    expect(Object.prototype.hasOwnProperty.call(result, '_lockSessionId')).toBe(false);
  });

  it('throws WorktreeLockedError when lockAcquire returns ok:false', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts({
      lockAcquire: vi.fn().mockReturnValue({
        ok: false,
        reason: 'already-running',
        existingLock: { session_id: 'other' },
      }),
    });
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot });

    await expect(runStoryPipeline(ctx, opts)).rejects.toBeInstanceOf(WorktreeLockedError);
  });

  it('does NOT call draftMrCreator when draftMrPolicy is off', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts();
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot, draftMrPolicy: 'off' });

    await runStoryPipeline(ctx, opts);

    expect(opts.draftMrCreator).not.toHaveBeenCalled();
  });

  it('does NOT call draftMrCreator when draftMrPolicy is absent', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts();
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot });
    // no draftMrPolicy field

    await runStoryPipeline(ctx, opts);

    expect(opts.draftMrCreator).not.toHaveBeenCalled();
  });

  it('DOES call draftMrCreator when draftMrPolicy is on-loop-start', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts();
    const ctx = makeContext({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      draftMrPolicy: 'on-loop-start',
    });

    await runStoryPipeline(ctx, opts);

    expect(opts.draftMrCreator).toHaveBeenCalledOnce();
    expect(opts.draftMrCreator).toHaveBeenCalledWith(
      expect.objectContaining({ draftMrPolicy: 'on-loop-start', issueIid: 99 }),
    );
  });

  it('does NOT abort pipeline when draftMrCreator throws', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts({
      draftMrCreator: vi.fn().mockRejectedValue(new Error('MR API down')),
    });
    const ctx = makeContext({
      repoRoot: tmp,
      worktreeRoot: wtRoot,
      draftMrPolicy: 'on-loop-start',
    });

    const result = await runStoryPipeline(ctx, opts);

    // Pipeline completed despite draftMrCreator throwing.
    expect(result.killSwitch).toBeNull();
    expect(opts.loopRunner).toHaveBeenCalledOnce();
  });

  it('propagates killSwitch from loopRunner result to StoryResult', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts({
      loopRunner: vi.fn().mockResolvedValue(
        makeLoopResult({ kill_switch: 'token-budget-exceeded', kill_switch_detail: 'over limit' }),
      ),
    });
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot });

    const result = await runStoryPipeline(ctx, opts);

    expect(result.killSwitch).toBe('token-budget-exceeded');
    expect(result.killSwitchDetail).toBe('over limit');
  });

  it('sets abortedByCohort: true when killSwitch is peer-abort', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts({
      loopRunner: vi.fn().mockResolvedValue(
        makeLoopResult({ kill_switch: 'peer-abort' }),
      ),
    });
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot });

    const result = await runStoryPipeline(ctx, opts);

    expect(result.abortedByCohort).toBe(true);
  });

  it('re-throws loopRunner error only after teardown (gcOnExit is still called)', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts({
      loopRunner: vi.fn().mockRejectedValue(new Error('loop crashed')),
    });
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot });

    await expect(runStoryPipeline(ctx, opts)).rejects.toThrow('loop crashed');
    // gcOnExit must have been called before the re-throw.
    expect(opts.gcOnExit).toHaveBeenCalledOnce();
  });

  // #905: fallback-to-manual propagation from loop.mjs's `fallback_to_manual`
  // state field through to StoryResult.fallbackToManual — the missing link in
  // the "fallback counts as complete" bug chain (loop.mjs -> worktree-pipeline
  // -> autopilot-multi.mjs classification).
  it('propagates fallback_to_manual:true from loopRunner result to StoryResult.fallbackToManual', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts({
      loopRunner: vi.fn().mockResolvedValue(
        makeLoopResult({ kill_switch: null, fallback_to_manual: true, iterations_completed: 0 }),
      ),
    });
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot });

    const result = await runStoryPipeline(ctx, opts);

    expect(result.fallbackToManual).toBe(true);
  });

  it('defaults StoryResult.fallbackToManual to false (not undefined) for a normal loopRunner result', async () => {
    const wtRoot = path.join(tmp, 'wt-root');
    mkdirSync(wtRoot, { recursive: true });

    const opts = makeOpts(); // makeLoopResult() default has no fallback_to_manual field
    const ctx = makeContext({ repoRoot: tmp, worktreeRoot: wtRoot });

    const result = await runStoryPipeline(ctx, opts);

    expect(result.fallbackToManual).toBe(false);
  });
});
