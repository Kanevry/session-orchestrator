/**
 * tests/lib/harness-audit/categories/category6.test.mjs
 *
 * Vitest suite for scripts/lib/harness-audit/categories/category6.mjs
 *
 * Category 6: Config Hygiene — checks claude-md-line-count,
 * no-dead-branch-refs, plugin-narrative-section, github-mirror-sync.
 *
 * Relies on resolveInstructionFile from common.mjs:
 *   - CLAUDE.md present → kind 'claude'
 *   - AGENTS.md present → kind 'agents' (only if CLAUDE.md absent)
 *   - neither present → null (checks should fail)
 *
 * node:child_process is mocked so github-mirror-sync tests never shell out to
 * real git — see .claude/rules/testing.md § Vitest Mocking Gotchas (vi.hoisted
 * for shared mock state; no vi.spyOn on ESM named exports).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import { runCategory6 } from '@lib/harness-audit/categories/category6.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'cat6-'));
}

/** Minimal valid CLAUDE.md content for a consumer repo (no plugin-specific heading). */
function minimalClaudeMd(extraLines = []) {
  const base = [
    '# Project Instructions',
    '',
    '## Session Config',
    'persistence: true',
    '',
  ];
  return [...base, ...extraLines].join('\n');
}

/** Build a string of exactly N lines. */
function nLines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runCategory6', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
    // Default: simulate "not a git repository" for every git invocation.
    // github-mirror-sync degrades to skip-as-pass in this state, matching
    // the real fixture dirs below (none of which contain a .git directory).
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    });
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Happy path — CLAUDE.md present, ≤250 lines, no dead refs, consumer repo
  // -------------------------------------------------------------------------
  it('returns 4 passing checks for a well-formed consumer repo CLAUDE.md', () => {
    writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());

    const checks = runCategory6(root);

    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(checks.map((c) => c.check_id)).toEqual([
      'claude-md-line-count',
      'no-dead-branch-refs',
      'plugin-narrative-section',
      'github-mirror-sync',
    ]);
  });

  // -------------------------------------------------------------------------
  // Edge case — AGENTS.md alias: resolveInstructionFile picks AGENTS.md
  // -------------------------------------------------------------------------
  it('uses AGENTS.md when CLAUDE.md is absent', () => {
    writeFileSync(join(root, 'AGENTS.md'), minimalClaudeMd());

    const checks = runCategory6(root);
    const lineCountCheck = checks.find((c) => c.check_id === 'claude-md-line-count');

    expect(lineCountCheck.status).toBe('pass');
    // Path reported in scorecard should be the AGENTS.md alias
    expect(lineCountCheck.path).toBe('AGENTS.md');
  });

  // -------------------------------------------------------------------------
  // Edge case — CLAUDE.md takes precedence over AGENTS.md when both present
  // -------------------------------------------------------------------------
  it('prefers CLAUDE.md over AGENTS.md when both are present', () => {
    writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());
    writeFileSync(join(root, 'AGENTS.md'), minimalClaudeMd());

    const checks = runCategory6(root);
    const lineCountCheck = checks.find((c) => c.check_id === 'claude-md-line-count');

    expect(lineCountCheck.path).toBe('CLAUDE.md');
  });

  // -------------------------------------------------------------------------
  // Edge case — neither CLAUDE.md nor AGENTS.md present → checks fail
  // -------------------------------------------------------------------------
  it('fails all instruction-file checks when neither CLAUDE.md nor AGENTS.md exists', () => {
    // Do not write any instruction file

    const checks = runCategory6(root);
    const lineCountCheck = checks.find((c) => c.check_id === 'claude-md-line-count');
    const deadRefsCheck = checks.find((c) => c.check_id === 'no-dead-branch-refs');

    expect(lineCountCheck.status).toBe('fail');
    expect(deadRefsCheck.status).toBe('fail');
    expect(lineCountCheck.message).toContain('missing');
  });

  // -------------------------------------------------------------------------
  // Failure case — CLAUDE.md exceeds 250 lines
  // -------------------------------------------------------------------------
  it('fails claude-md-line-count when CLAUDE.md exceeds 250 lines', () => {
    writeFileSync(join(root, 'CLAUDE.md'), nLines(260));

    const checks = runCategory6(root);
    const lineCountCheck = checks.find((c) => c.check_id === 'claude-md-line-count');

    expect(lineCountCheck.status).toBe('fail');
    expect(lineCountCheck.evidence.lineCount).toBe(260);
    expect(lineCountCheck.message).toContain('> 250 limit');
  });

  // -------------------------------------------------------------------------
  // Failure case — dead branch ref detected in CLAUDE.md
  // -------------------------------------------------------------------------
  it('fails no-dead-branch-refs when CLAUDE.md contains a dead branch reference', () => {
    writeFileSync(
      join(root, 'CLAUDE.md'),
      minimalClaudeMd(['See branch feat/v3-refactor for prior work.']),
    );

    const checks = runCategory6(root);
    const deadRefsCheck = checks.find((c) => c.check_id === 'no-dead-branch-refs');

    expect(deadRefsCheck.status).toBe('fail');
    expect(deadRefsCheck.evidence.deadRefsFound).toContain('feat/v3-');
  });

  // -------------------------------------------------------------------------
  // github-mirror-sync — no .git dir at all (real filesystem, not mocked git)
  // -------------------------------------------------------------------------
  describe('github-mirror-sync', () => {
    it('skips as pass with full points when the root is not a git repository', () => {
      writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());

      const checks = runCategory6(root);
      const mirrorCheck = checks.find((c) => c.check_id === 'github-mirror-sync');

      expect(mirrorCheck.status).toBe('pass');
      expect(mirrorCheck.points).toBe(2);
      expect(mirrorCheck.max_points).toBe(2);
      expect(mirrorCheck.evidence.hasGithubRemote).toBe(false);
      expect(mirrorCheck.message).toContain('no github mirror remote configured');
    });

    it('skips as pass with full points when no github remote is configured', () => {
      writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());
      execFileSyncMock.mockImplementation((cmd, args) => {
        if (args[0] === 'remote') return 'origin\n';
        throw new Error('unexpected git invocation in this test');
      });

      const checks = runCategory6(root);
      const mirrorCheck = checks.find((c) => c.check_id === 'github-mirror-sync');

      expect(mirrorCheck.status).toBe('pass');
      expect(mirrorCheck.points).toBe(2);
      expect(mirrorCheck.evidence.hasGithubRemote).toBe(false);
    });

    it('skips as pass with full points when neither github/HEAD nor the local-branch fallback verifies', () => {
      writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());
      execFileSyncMock.mockImplementation((cmd, args) => {
        if (args[0] === 'remote') return 'origin\ngithub\n';
        // Both the github/HEAD lookup and the local-branch fallback lookup
        // resolve a branch name (--abbrev-ref matches both), but neither
        // verifies against an existing github/<branch> tracking ref.
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n';
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          throw new Error('fatal: Needed a single revision');
        }
        throw new Error('unexpected git invocation in this test');
      });

      const checks = runCategory6(root);
      const mirrorCheck = checks.find((c) => c.check_id === 'github-mirror-sync');

      expect(mirrorCheck.status).toBe('pass');
      expect(mirrorCheck.points).toBe(2);
      expect(mirrorCheck.max_points).toBe(2);
      expect(mirrorCheck.evidence.mirrorBranch).toBe(null);
      expect(mirrorCheck.message).toContain('not fetched locally');
    });

    // -----------------------------------------------------------------------
    // Local-branch fallback (the KEY hardening test) — a normal
    // `git push github HEAD` never sets the `github/HEAD` symbolic ref, so
    // freshly bootstrapped repos must fall back to resolving the mirror
    // branch via the local current branch + a verified `github/<branch>`
    // tracking ref.
    // -----------------------------------------------------------------------
    it('falls back to the local current branch when github/HEAD is unresolved, and reports partial credit', () => {
      writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());
      execFileSyncMock.mockImplementation((cmd, args) => {
        if (args[0] === 'remote') return 'origin\ngithub\n';
        // Strategy 1 fails: github/HEAD is not set (unfetched symbolic ref).
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'github/HEAD') {
          throw new Error("fatal: ambiguous argument 'github/HEAD': unknown revision or path not in the working tree.");
        }
        // Strategy 2: local current branch resolves to 'main'.
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return 'main\n';
        }
        // The mirror DOES have a github/main tracking ref (pushed, no set-head).
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3] === 'github/main') {
          return '';
        }
        if (args[0] === 'rev-list' && args[2] === 'github/main..HEAD') {
          return '2\n';
        }
        throw new Error('unexpected git invocation in this test');
      });

      const checks = runCategory6(root);
      const mirrorCheck = checks.find((c) => c.check_id === 'github-mirror-sync');

      expect(mirrorCheck.status).toBe('pass');
      expect(mirrorCheck.points).toBe(1);
      expect(mirrorCheck.max_points).toBe(2);
      expect(mirrorCheck.evidence.mirrorBranch).toBe('main');
      expect(mirrorCheck.evidence.resolvedVia).toBe('local-branch-fallback');
      expect(mirrorCheck.evidence.aheadCount).toBe(2);
      expect(mirrorCheck.message).toBe(
        '2 local commit(s) not pushed to github mirror (github/main). Run: git push github HEAD',
      );
    });

    // -----------------------------------------------------------------------
    // Unparseable ahead-count — rev-list returns a non-numeric string.
    // -----------------------------------------------------------------------
    it('skips as pass when the ahead-count cannot be parsed as a number', () => {
      writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());
      execFileSyncMock.mockImplementation((cmd, args) => {
        if (args[0] === 'remote') return 'origin\ngithub\n';
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'github/main\n';
        if (args[0] === 'rev-parse' && args[1] === '--verify') return '';
        if (args[0] === 'rev-list') return 'unknown\n';
        throw new Error('unexpected git invocation in this test');
      });

      const checks = runCategory6(root);
      const mirrorCheck = checks.find((c) => c.check_id === 'github-mirror-sync');

      expect(mirrorCheck.status).toBe('pass');
      expect(mirrorCheck.points).toBe(2);
      expect(mirrorCheck.max_points).toBe(2);
      expect(mirrorCheck.evidence.aheadCount).toBe(null);
      expect(mirrorCheck.message).toContain('unable to determine ahead-count');
    });

    it('passes with full points when HEAD is fully mirrored (0 ahead)', () => {
      writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());
      execFileSyncMock.mockImplementation((cmd, args) => {
        if (args[0] === 'remote') return 'origin\ngithub\n';
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'github/main\n';
        if (args[0] === 'rev-parse' && args[1] === '--verify') return '';
        if (args[0] === 'rev-list') return '0\n';
        throw new Error('unexpected git invocation in this test');
      });

      const checks = runCategory6(root);
      const mirrorCheck = checks.find((c) => c.check_id === 'github-mirror-sync');

      expect(mirrorCheck.status).toBe('pass');
      expect(mirrorCheck.points).toBe(2);
      expect(mirrorCheck.max_points).toBe(2);
      expect(mirrorCheck.evidence.aheadCount).toBe(0);
      expect(mirrorCheck.message).toContain('fully mirrored');
    });

    it('reports partial credit when local commits are not yet pushed to the mirror', () => {
      writeFileSync(join(root, 'CLAUDE.md'), minimalClaudeMd());
      execFileSyncMock.mockImplementation((cmd, args) => {
        if (args[0] === 'remote') return 'origin\ngithub\n';
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'github/main\n';
        if (args[0] === 'rev-parse' && args[1] === '--verify') return '';
        if (args[0] === 'rev-list') return '3\n';
        throw new Error('unexpected git invocation in this test');
      });

      const checks = runCategory6(root);
      const mirrorCheck = checks.find((c) => c.check_id === 'github-mirror-sync');

      expect(mirrorCheck.status).toBe('pass');
      expect(mirrorCheck.points).toBe(1);
      expect(mirrorCheck.max_points).toBe(2);
      expect(mirrorCheck.evidence.aheadCount).toBe(3);
      expect(mirrorCheck.message).toBe(
        '3 local commit(s) not pushed to github mirror (github/main). Run: git push github HEAD',
      );
    });
  });
});
