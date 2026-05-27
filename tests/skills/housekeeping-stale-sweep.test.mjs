/**
 * tests/skills/housekeeping-stale-sweep.test.mjs
 *
 * Vitest suite for Phase 4.5 Worktree-Stale-Sweep (#575 P3.2):
 *   - listAutoPromotedWorktrees(repoRoot, mainCheckoutRoot, opts?)
 *   - isWorktreeStale(wtPath, staleBranchDays)
 *   - skills/memory-cleanup/SKILL.md Phase 4.5 structure verification
 *
 * PRD: docs/prd/2026-05-26-parallel-aware-sessions.md §3 P3 Gherkin row 4
 *      + §3.A P3 EARS state-driven clause
 *
 * Testing strategy:
 *   - listAutoPromotedWorktrees: DI seam via opts.execFileFn — no vi.mock needed.
 *     #577 HARDEN-001: the SUT now invokes `execFileFn('git', ['-C', dir,
 *     'worktree', 'list', '--porcelain'])` (arg array, no shell). Each test
 *     passes a vi.fn() that returns the porcelain fixture only when the args
 *     array contains '--porcelain' — asserting the injection-safe call shape.
 *   - isWorktreeStale: real fs operations on tmp dirs created with mkdirSync +
 *     utimesSync. No mocking — the function is pure fs.
 *   - SKILL.md structure: file-content assertions via readFileSync.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, utimesSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listAutoPromotedWorktrees,
  isWorktreeStale,
} from '../../scripts/lib/memory-cleanup/worktree-sweep.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake `git worktree list --porcelain` output string.
 *
 * Each entry is `{ worktree, branch?, head? }`. Entries are separated by the
 * double-newline delimiter that the real git command uses.
 *
 * @param {Array<{worktree: string, branch?: string, head?: string}>} entries
 * @returns {string}
 */
function fakePorcelain(entries) {
  return (
    entries
      .map((e) => {
        const lines = [`worktree ${e.worktree}`];
        lines.push(`HEAD ${e.head ?? '0000000000000000000000000000000000000000'}`);
        if (e.branch) lines.push(`branch refs/heads/${e.branch}`);
        return lines.join('\n');
      })
      .join('\n\n') + '\n\n'
  );
}

// ---------------------------------------------------------------------------
// Group 1: listAutoPromotedWorktrees — #575 P3.2 detection
// ---------------------------------------------------------------------------

describe('listAutoPromotedWorktrees() — #575 P3.2 detection', () => {
  it('returns list of matching auto-promoted worktrees', () => {
    // Mock git worktree list --porcelain to return:
    //   worktree /tmp/base/myrepo          (main checkout — filtered out)
    //   worktree /tmp/base/myrepo-main-2026-05-27-deep-2  (auto-promoted ✓)
    //   worktree /tmp/base/myrepo-issue-42-fix            (NOT semantic — excluded)
    const porcelain = fakePorcelain([
      { worktree: '/tmp/base/myrepo' },
      { worktree: '/tmp/base/myrepo-main-2026-05-27-deep-2', branch: 'main' },
      { worktree: '/tmp/base/myrepo-issue-42-fix', branch: 'issue-42-fix' },
    ]);
    // #577 HARDEN-001: assert the SUT calls execFileFn('git', [..,'--porcelain']).
    const execFileFn = vi.fn((file, args) =>
      file === 'git' && args.includes('--porcelain') ? porcelain : '',
    );

    const result = listAutoPromotedWorktrees('/tmp/some-cwd', '/tmp/base/myrepo', {
      execFileFn,
    });

    expect(execFileFn).toHaveBeenCalledWith(
      'git',
      ['-C', '/tmp/base/myrepo', 'worktree', 'list', '--porcelain'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(result).toEqual([
      {
        wtPath: '/tmp/base/myrepo-main-2026-05-27-deep-2',
        sessionId: 'main-2026-05-27-deep-2',
        branch: 'main',
      },
    ]);
  });

  it('returns ALL matching auto-promoted siblings when multiple exist (#579 Gap 1)', () => {
    // Two auto-promoted siblings + the main checkout + one non-semantic worktree.
    // A regression returning only the FIRST match would silently leave the
    // second stale worktree uncleaned in a batch sweep — this asserts both are
    // surfaced, in porcelain order (deep-1 before deep-2).
    const porcelain = fakePorcelain([
      { worktree: '/tmp/base/myrepo' }, // main checkout — filtered out
      { worktree: '/tmp/base/myrepo-main-2026-05-27-deep-1', branch: 'main' }, // sibling ✓
      { worktree: '/tmp/base/myrepo-main-2026-05-27-deep-2', branch: 'main' }, // sibling ✓
      { worktree: '/tmp/base/myrepo-issue-42-fix', branch: 'issue-42-fix' }, // non-semantic — excluded
    ]);
    const execFileFn = vi.fn((file, args) =>
      file === 'git' && args.includes('--porcelain') ? porcelain : '',
    );

    const result = listAutoPromotedWorktrees('/tmp/cwd', '/tmp/base/myrepo', {
      execFileFn,
    });

    // Hardcoded literal: exactly the two semantic siblings, in encounter order.
    expect(result).toEqual([
      {
        wtPath: '/tmp/base/myrepo-main-2026-05-27-deep-1',
        sessionId: 'main-2026-05-27-deep-1',
        branch: 'main',
      },
      {
        wtPath: '/tmp/base/myrepo-main-2026-05-27-deep-2',
        sessionId: 'main-2026-05-27-deep-2',
        branch: 'main',
      },
    ]);
    expect(result).toHaveLength(2);
    // Both expected sibling paths are present (guards against silent first-only return).
    expect(result.map((r) => r.wtPath)).toEqual([
      '/tmp/base/myrepo-main-2026-05-27-deep-1',
      '/tmp/base/myrepo-main-2026-05-27-deep-2',
    ]);
  });

  it('filters out non-semantic suffixes (issue-42, random-uuid, etc)', () => {
    // All worktree paths in the mock have non-semantic suffixes — none qualify
    const porcelain = fakePorcelain([
      { worktree: '/tmp/base/myrepo' },
      { worktree: '/tmp/base/myrepo-issue-42-fix', branch: 'issue-42-fix' },
      {
        worktree: '/tmp/base/myrepo-550e8400-e29b-41d4-a716-446655440000',
        branch: 'unused',
      },
      { worktree: '/tmp/base/myrepo-randomstuff', branch: 'randomstuff' },
    ]);
    const execFileFn = vi.fn((file, args) =>
      file === 'git' && args.includes('--porcelain') ? porcelain : '',
    );

    const result = listAutoPromotedWorktrees('/tmp/cwd', '/tmp/base/myrepo', {
      execFileFn,
    });

    expect(result).toEqual([]);
  });

  it('returns empty list when only main checkout exists', () => {
    // Mock git worktree list returns only the main checkout
    const porcelain = fakePorcelain([{ worktree: '/tmp/base/myrepo' }]);
    const execFileFn = vi.fn((file, args) =>
      file === 'git' && args.includes('--porcelain') ? porcelain : '',
    );

    const result = listAutoPromotedWorktrees('/tmp/cwd', '/tmp/base/myrepo', {
      execFileFn,
    });

    expect(result).toEqual([]);
  });

  it('returns empty list on git error', () => {
    // Mock execFileFn to throw — simulates git not available or not a repo
    const execFileFn = vi.fn().mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    const result = listAutoPromotedWorktrees('/not-a-repo', '/not-a-repo', {
      execFileFn,
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group 2: isWorktreeStale — #575 P3.2 staleness threshold
// ---------------------------------------------------------------------------

describe('isWorktreeStale() — #575 P3.2 staleness threshold', () => {
  let tmp;

  beforeEach(() => {
    tmp = path.join(
      os.tmpdir(),
      `stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true when worktree mtime is older than threshold', () => {
    const wtPath = path.join(tmp, 'old-wt');
    mkdirSync(wtPath);
    // 10 days ago; threshold = 7 → should be stale
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(wtPath, tenDaysAgo, tenDaysAgo);

    expect(isWorktreeStale(wtPath, 7)).toBe(true);
  });

  it('returns false when worktree mtime is within threshold', () => {
    const wtPath = path.join(tmp, 'fresh-wt');
    mkdirSync(wtPath);
    // 3 days ago; threshold = 7 → not stale
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(wtPath, threeDaysAgo, threeDaysAgo);

    expect(isWorktreeStale(wtPath, 7)).toBe(false);
  });

  it('returns false when wtPath does not exist (conservative no-op)', () => {
    // Path that was never created — should not throw, must return false
    expect(isWorktreeStale('/tmp/nonexistent-path-xyz-housekeeping-sweep', 7)).toBe(false);
  });

  it('respects staleBranchDays parameter (configurable threshold)', () => {
    const wtPath = path.join(tmp, 'days-test');
    mkdirSync(wtPath);
    // 5 days ago
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    utimesSync(wtPath, fiveDaysAgo, fiveDaysAgo);

    // threshold 3: 5 days > 3 days → stale
    expect(isWorktreeStale(wtPath, 3)).toBe(true);
    // threshold 7: 5 days < 7 days → not stale
    expect(isWorktreeStale(wtPath, 7)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 3: Phase 4.5 SKILL.md structure — #575 P3.2 documentation contract
// ---------------------------------------------------------------------------

describe('Phase 4.5 SKILL.md structure — #575 P3.2 documentation contract', () => {
  let content;

  beforeEach(() => {
    content = readFileSync(
      path.join(PROJECT_ROOT, 'skills', 'memory-cleanup', 'SKILL.md'),
      'utf8',
    );
  });

  it('memory-cleanup/SKILL.md contains Phase 4.5 section', () => {
    expect(content).toMatch(/## Phase 4\.5: Worktree-Stale-Sweep/);
  });

  it('Phase 4.5 cites stale-branch-days config', () => {
    const p45Start = content.indexOf('## Phase 4.5:');
    expect(p45Start).toBeGreaterThan(-1);
    const p45Block = content.slice(p45Start);
    expect(p45Block).toMatch(/stale-branch-days/);
  });

  it('Phase 4.5 cites PSA-003 compliance', () => {
    const p45Start = content.indexOf('## Phase 4.5:');
    expect(p45Start).toBeGreaterThan(-1);
    const p45Block = content.slice(p45Start);
    expect(p45Block).toMatch(/PSA-003/);
  });

  it('Phase 4.5 documents 2-option AUQ (Behalten/Entfernen)', () => {
    const p45Start = content.indexOf('## Phase 4.5:');
    expect(p45Start).toBeGreaterThan(-1);
    const p45Block = content.slice(p45Start);
    expect(p45Block).toMatch(/Behalten/);
    expect(p45Block).toMatch(/Entfernen/);
  });
});
