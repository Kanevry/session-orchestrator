/**
 * tests/lib/session-end/worktree-orphan-sweep.test.mjs
 *
 * Unit suite for the Phase 4b Worktree-Orphan Sweep (#831 / B5).
 *
 * The two load-bearing groups are the INVARIANT ones (Group E): the module
 * proposes, it never disposes. Every git call the injected fake receives is
 * asserted against a read-only allow-list, which is how "no mutating command
 * can ever have been issued" is proven mechanically rather than by inspection.
 *
 * `execFileFn` is ALWAYS injected — no test spawns real git. All fixture paths
 * are synthetic (`/sandbox/wt/...`) and all expected values are hard-coded
 * literals (no test-the-mock, no computed expectations).
 */

import { describe, it, expect } from 'vitest';

import * as sweepModule from '@lib/session-end/worktree-orphan-sweep.mjs';
import { checkWorktreeOrphans } from '@lib/session-end/worktree-orphan-sweep.mjs';

const MAIN = '/sandbox/wt/example-repo';
const WT_ONE = '/sandbox/wt/example-repo-session-1';
const WT_TWO = '/sandbox/wt/example-repo-session-2';

const ENABLED = { enabled: true, 'base-branch': 'main', mode: 'warn' };

/** Porcelain fixture: main checkout + two sibling worktrees. */
const PORCELAIN_TWO_SIBLINGS = [
  `worktree ${MAIN}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main`,
  `worktree ${WT_ONE}\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feat/example-one`,
  `worktree ${WT_TWO}\nHEAD 3333333333333333333333333333333333333333\nbranch refs/heads/fix/example-two`,
].join('\n\n');

/** Porcelain fixture: main checkout only. */
const PORCELAIN_MAIN_ONLY = `worktree ${MAIN}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main`;

/**
 * Build a fake `execFileFn` returning canned stdout and recording every call.
 *
 * @param {object} spec
 * @param {string} [spec.porcelain] - stdout for `worktree list --porcelain`
 * @param {Record<string, string>} [spec.counts] - range → `rev-list --count` stdout
 * @param {boolean} [spec.throwOnList] - make `worktree list` throw
 * @param {string[]} [spec.throwOnCountFor] - ranges whose `rev-list` throws
 */
function makeFakeGit({ porcelain, counts = {}, throwOnList = false, throwOnCountFor = [] }) {
  const calls = [];
  const fn = (file, args, options) => {
    calls.push({ file, args, options });
    const sub = args[2];
    if (sub === 'worktree') {
      if (throwOnList) throw new Error('fatal: not a git repository');
      return porcelain;
    }
    if (sub === 'rev-list') {
      const range = args[4];
      if (throwOnCountFor.includes(range)) {
        throw new Error(`fatal: bad revision '${range}'`);
      }
      return Object.hasOwn(counts, range) ? counts[range] : '0\n';
    }
    throw new Error(`unexpected git subcommand: ${sub}`);
  };
  fn.calls = calls;
  return fn;
}

describe('checkWorktreeOrphans — input guards', () => {
  it('returns null when called with no arguments at all', () => {
    expect(checkWorktreeOrphans()).toBe(null);
  });

  it('returns null when repoRoot is null', () => {
    expect(checkWorktreeOrphans({ repoRoot: null, config: ENABLED })).toBe(null);
  });

  it('returns null when repoRoot is a number', () => {
    expect(checkWorktreeOrphans({ repoRoot: 42, config: ENABLED })).toBe(null);
  });

  it('returns null when repoRoot is an empty string', () => {
    expect(checkWorktreeOrphans({ repoRoot: '', config: ENABLED })).toBe(null);
  });
});

describe('checkWorktreeOrphans — config gate', () => {
  it('returns null AND invokes no git call when enabled is false', () => {
    const git = makeFakeGit({ porcelain: PORCELAIN_TWO_SIBLINGS });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      config: { enabled: false, 'base-branch': 'main', mode: 'warn' },
      execFileFn: git,
    });

    expect(result).toBe(null);
    expect(git.calls).toHaveLength(0);
  });

  it('returns null AND invokes no git call when mode is off', () => {
    const git = makeFakeGit({ porcelain: PORCELAIN_TWO_SIBLINGS });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      config: { enabled: true, 'base-branch': 'main', mode: 'off' },
      execFileFn: git,
    });

    expect(result).toBe(null);
    expect(git.calls).toHaveLength(0);
  });
});

describe('checkWorktreeOrphans — detection', () => {
  it('returns null when the main checkout is the only worktree', () => {
    const git = makeFakeGit({ porcelain: PORCELAIN_MAIN_ONLY });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result).toBe(null);
  });

  it('never reports the main checkout as a candidate', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..feat/example-one': '0\n', 'main..fix/example-two': '0\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result.candidates.map((c) => c.wtPath)).toEqual([WT_ONE, WT_TWO]);
    expect(result.candidates.map((c) => c.branch)).not.toContain('main');
  });

  it('does NOT report a worktree that has commits ahead of the base branch', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..feat/example-one': '3\n', 'main..fix/example-two': '0\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result.candidates).toEqual([
      {
        wtPath: WT_TWO,
        branch: 'fix/example-two',
        sessionId: 'session-2',
        aheadCount: 0,
      },
    ]);
  });

  it('reports a 0-ahead worktree with the exact {severity, message, candidates} shape', () => {
    const git = makeFakeGit({
      porcelain: `${`worktree ${MAIN}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main`}\n\n${`worktree ${WT_ONE}\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feat/example-one`}`,
      counts: { 'main..feat/example-one': '0\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(Object.keys(result).sort()).toEqual(['candidates', 'message', 'severity']);
    expect(result.severity).toBe('warn');
    expect(result.candidates).toEqual([
      {
        wtPath: WT_ONE,
        branch: 'feat/example-one',
        sessionId: 'session-1',
        aheadCount: 0,
      },
    ]);
    expect(result.message).toBe(
      '⚠ worktree-orphans: 1 worktree branch has 0 commits ahead of the base branch — ' +
        'example-repo-session-1 (feat/example-one) — ' +
        'review via the cleanup prompt; nothing was removed.',
    );
  });

  it('derives the main checkout from the first porcelain line when not injected', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..feat/example-one': '0\n', 'main..fix/example-two': '0\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: WT_ONE,
      config: ENABLED,
      execFileFn: git,
    });

    // The main checkout is excluded even though repoRoot was a sibling worktree.
    expect(result.candidates.map((c) => c.wtPath)).toEqual([WT_ONE, WT_TWO]);
    // rev-list is anchored at the DERIVED main checkout, not at repoRoot.
    const revListCalls = git.calls.filter((c) => c.args[2] === 'rev-list');
    expect(revListCalls.every((c) => c.args[1] === MAIN)).toBe(true);
  });

  it('honours a non-default base-branch from config in the rev-list range', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'develop..feat/example-one': '0\n', 'develop..fix/example-two': '7\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: { enabled: true, 'base-branch': 'develop', mode: 'warn' },
      execFileFn: git,
    });

    expect(result.candidates.map((c) => c.branch)).toEqual(['feat/example-one']);
  });
});

describe('checkWorktreeOrphans — conservative failure posture', () => {
  it('returns null when git throws on worktree list', () => {
    const git = makeFakeGit({ porcelain: PORCELAIN_TWO_SIBLINGS, throwOnList: true });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result).toBe(null);
  });

  it('drops only the failing worktree when rev-list throws for one of them', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..fix/example-two': '0\n' },
      throwOnCountFor: ['main..feat/example-one'],
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    // Failing sibling excluded; healthy sibling still reported.
    expect(result.candidates.map((c) => c.wtPath)).toEqual([WT_TWO]);
  });

  it('does NOT report a worktree whose rev-list output is unparseable', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..feat/example-one': 'not-a-number\n', 'main..fix/example-two': '0\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result.candidates.map((c) => c.wtPath)).toEqual([WT_TWO]);
  });

  it('does NOT report a detached-HEAD worktree (branch unresolvable)', () => {
    const git = makeFakeGit({
      porcelain: [
        `worktree ${MAIN}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main`,
        `worktree ${WT_ONE}\nHEAD 2222222222222222222222222222222222222222\ndetached`,
      ].join('\n\n'),
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result).toBe(null);
  });

  it('returns null (never throws) when the porcelain output is empty', () => {
    const git = makeFakeGit({ porcelain: '' });

    expect(
      checkWorktreeOrphans({
        repoRoot: MAIN,
        mainCheckoutRoot: MAIN,
        config: ENABLED,
        execFileFn: git,
      }),
    ).toBe(null);
  });
});

describe('checkWorktreeOrphans — message contract', () => {
  it('pins the literal "⚠ worktree-orphans: " prefix', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..feat/example-one': '0\n', 'main..fix/example-two': '0\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result.message.startsWith('⚠ worktree-orphans: ')).toBe(true);
  });

  it('always carries the literal "nothing was removed" no-delete clause', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..feat/example-one': '0\n', 'main..fix/example-two': '0\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result.message).toContain('nothing was removed');
    expect(result.message.endsWith('nothing was removed.')).toBe(true);
  });
});

describe('checkWorktreeOrphans — no-delete invariants (PSA-003)', () => {
  /** Read-only allow-list: the ONLY two git shapes this module may ever issue. */
  function assertReadOnly(calls) {
    for (const call of calls) {
      expect(call.file).toBe('git');
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.args[0]).toBe('-C');

      const shape = call.args.slice(2).join(' ');
      const isList = shape === 'worktree list --porcelain';
      const isRevList = call.args[2] === 'rev-list' && call.args[3] === '--count';
      expect(isList || isRevList).toBe(true);
    }
  }

  it('issues ONLY read-only git invocations across a full sweep', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..feat/example-one': '0\n', 'main..fix/example-two': '0\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result.candidates).toHaveLength(2);
    expect(git.calls.length).toBeGreaterThan(0);
    assertReadOnly(git.calls);
  });

  it('never issues a mutating subcommand or destructive flag', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..feat/example-one': '0\n', 'main..fix/example-two': '5\n' },
    });

    checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    const banned = [
      'remove',
      'prune',
      'branch',
      'reset',
      'clean',
      'stash',
      'checkout',
      'push',
      '-d',
      '-D',
      '--delete',
      '--force',
      '-f',
    ];
    for (const call of git.calls) {
      for (const arg of call.args) {
        expect(banned).not.toContain(arg);
      }
    }
  });

  it('exports no function whose name suggests removal', () => {
    const exported = Object.keys(sweepModule);
    expect(exported).toEqual(['checkWorktreeOrphans']);
    for (const name of exported) {
      expect(/remove|delete|prune|destroy|clean|rm/i.test(name)).toBe(false);
    }
  });

  it('returns a result object with no removed/deleted fields', () => {
    const git = makeFakeGit({
      porcelain: PORCELAIN_TWO_SIBLINGS,
      counts: { 'main..feat/example-one': '0\n', 'main..fix/example-two': '0\n' },
    });

    const result = checkWorktreeOrphans({
      repoRoot: MAIN,
      mainCheckoutRoot: MAIN,
      config: ENABLED,
      execFileFn: git,
    });

    expect(result).not.toHaveProperty('removed');
    expect(result).not.toHaveProperty('deleted');
    expect(result).not.toHaveProperty('pruned');
    for (const candidate of result.candidates) {
      expect(Object.keys(candidate).sort()).toEqual([
        'aheadCount',
        'branch',
        'sessionId',
        'wtPath',
      ]);
    }
  });
});
