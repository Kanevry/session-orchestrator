/**
 * tests/skills/session-end-cleanup.test.mjs
 *
 * Vitest suite for #575 P3.2 — session-end Phase 4a Auto-Promoted Worktree Cleanup.
 *
 * Two test surfaces:
 *   1. Behavioural unit tests for `detectAutoPromotedWorktree()` and `isWorktreeClean()`
 *      extracted from skills/session-end/SKILL.md Phase 4a into
 *      scripts/lib/session-end/worktree-cleanup.mjs (helper module).
 *   2. Markdown-structure tests asserting Phase 4a is present in SKILL.md with the
 *      required structural elements (position, PSA-003 / #490 references, 3-option AUQ).
 *
 * Isolation strategy:
 *   - `node:child_process` is mocked at module level via vi.mock so no real git
 *     commands are ever issued.
 *   - Each test configures per-call behaviour via `setExecResponses()`.
 *   - The mock is applied BEFORE module import; all `execSync` calls in the SUT
 *     route through the configured mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Mock node:child_process BEFORE importing the module under test.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error(
      'session-end-cleanup test: execSync called without a per-test mock. ' +
        'This would shell out to a real git CLI — failing fast.',
    );
  }),
}));

const { execSync } = await import('node:child_process');
const { detectAutoPromotedWorktree, isWorktreeClean } = await import(
  '@lib/session-end/worktree-cleanup.mjs'
);

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKILL_PATH = join(PROJECT_ROOT, 'skills', 'session-end', 'SKILL.md');

// ---------------------------------------------------------------------------
// Helper: program a deterministic sequence of execSync responses.
// Each call consumes the next response in the array.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ok: boolean, stdout?: string} | ((cmd: string, callIndex: number) => string)>} responses
 */
function setExecResponses(responses) {
  let i = 0;
  execSync.mockImplementation((cmd) => {
    const spec = responses[i++];
    if (!spec) {
      throw new Error(
        `session-end-cleanup test: unexpected extra execSync call #${i} (${cmd})`,
      );
    }
    if (typeof spec === 'function') return spec(cmd, i - 1);
    if (spec.ok === false) {
      throw new Error(spec.stderr ?? 'git error');
    }
    return spec.stdout ?? '';
  });
}

beforeEach(() => {
  execSync.mockReset();
  execSync.mockImplementation(() => {
    throw new Error('session-end-cleanup test: no per-test mock configured');
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Group 1 — detectAutoPromotedWorktree(repoRoot, sessionId)
// ===========================================================================

describe('detectAutoPromotedWorktree() — #575 P3.2 detection', () => {
  // Bug-fix note (W3 T2 → coordinator-direct fix):
  //   The original SKILL.md code computed `path.basename(repoRoot) === ${repoName}-${sessionId}`
  //   where `repoName = path.basename(repoRoot)` — structurally impossible for non-empty sessionId.
  //   Fixed by deriving `repoName` from the main checkout (first entry of `git worktree list --porcelain`)
  //   instead of from the promoted worktree's own basename.

  it('returns {wtPath, sessionId, branch} for a properly-promoted sibling worktree', () => {
    // Main checkout at /tmp/parent/myrepo, promoted sibling at /tmp/parent/myrepo-main-2026-05-27-deep-2.
    // git worktree list --porcelain lists main first, then promoted.
    setExecResponses([
      {
        ok: true,
        stdout:
          'worktree /tmp/parent/myrepo\n\nworktree /tmp/parent/myrepo-main-2026-05-27-deep-2\n',
      },
    ]);
    const result = detectAutoPromotedWorktree(
      '/tmp/parent/myrepo-main-2026-05-27-deep-2',
      'main-2026-05-27-deep-2',
    );
    expect(result).toEqual({
      wtPath: '/tmp/parent/myrepo-main-2026-05-27-deep-2',
      sessionId: 'main-2026-05-27-deep-2',
      branch: 'main',
    });
  });

  it('returns null when repoRoot IS the main checkout (not auto-promoted)', () => {
    setExecResponses([{ ok: true, stdout: 'worktree /tmp/parent/myrepo\n' }]);
    const result = detectAutoPromotedWorktree(
      '/tmp/parent/myrepo',
      'main-2026-05-27-deep-2',
    );
    expect(result).toBeNull();
  });

  it('returns null when sessionId is UUID-v4 (not semantic)', () => {
    // No execSync expected — parseSessionId returns format:'uuid', function exits early.
    execSync.mockImplementation(() => {
      throw new Error('UUID path should not invoke execSync');
    });
    const result = detectAutoPromotedWorktree(
      '/tmp/parent/myrepo-550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440000',
    );
    expect(result).toBeNull();
  });

  it('returns null when sessionId does not match either known format', () => {
    // parseSessionId returns null for unrecognised strings → function exits early.
    execSync.mockImplementation(() => {
      throw new Error('null-parse path should not invoke execSync');
    });
    const result = detectAutoPromotedWorktree(
      '/tmp/parent/myrepo',
      'not-a-valid-session-id-format',
    );
    expect(result).toBeNull();
  });

  it('returns null when basename does not match <main-repo-name>-<sessionId> pattern', () => {
    // repoRoot is /tmp/parent/some-other-dir (basename "some-other-dir"), main checkout is /tmp/parent/myrepo.
    // expectedBasename would be "myrepo-main-2026-05-27-deep-2" — does NOT match "some-other-dir".
    setExecResponses([
      {
        ok: true,
        stdout: 'worktree /tmp/parent/myrepo\n\nworktree /tmp/parent/some-other-dir\n',
      },
    ]);
    const result = detectAutoPromotedWorktree(
      '/tmp/parent/some-other-dir',
      'main-2026-05-27-deep-2',
    );
    expect(result).toBeNull();
  });

  it('returns null when git worktree list fails (not a git repo)', () => {
    setExecResponses([{ ok: false, stderr: 'fatal: not a git repository' }]);
    const result = detectAutoPromotedWorktree('/not-a-repo', 'main-2026-05-27-deep-2');
    expect(result).toBeNull();
  });
});

// ===========================================================================
// Group 2 — isWorktreeClean(wtPath)
// ===========================================================================

describe('isWorktreeClean() — #575 P3.2 clean-check', () => {
  it('returns true when porcelain is empty AND branch status has no `ahead`', () => {
    setExecResponses([
      { ok: true, stdout: '' }, // git status --porcelain → empty
      { ok: true, stdout: '## main...origin/main\n' }, // branch status → no `ahead`
    ]);
    const result = isWorktreeClean('/tmp/clean-wt');
    expect(result).toBe(true);
  });

  it('returns false when porcelain shows modified files', () => {
    setExecResponses([
      { ok: true, stdout: ' M src/foo.js\n' }, // dirty
      // second execSync call is NOT made (short-circuits on first non-empty porcelain)
    ]);
    const result = isWorktreeClean('/tmp/dirty-wt');
    expect(result).toBe(false);
  });

  it('returns false when porcelain shows untracked files', () => {
    setExecResponses([
      { ok: true, stdout: '?? newfile.js\n' }, // untracked
    ]);
    const result = isWorktreeClean('/tmp/untracked-wt');
    expect(result).toBe(false);
  });

  it('returns false when branch is ahead of remote (unpushed commits)', () => {
    setExecResponses([
      { ok: true, stdout: '' }, // porcelain empty (no dirty/untracked)
      { ok: true, stdout: '## main...origin/main [ahead 2]\n' }, // unpushed
    ]);
    const result = isWorktreeClean('/tmp/unpushed-wt');
    expect(result).toBe(false);
  });

  it('returns false on git error (conservative PSA-003 default)', () => {
    setExecResponses([{ ok: false, stderr: 'fatal: not a git repository' }]);
    const result = isWorktreeClean('/tmp/error-wt');
    expect(result).toBe(false);
  });

  it('returns true when porcelain is empty AND branch status shows `behind` only (not ahead)', () => {
    // Verifies the `ahead` word-boundary check does NOT false-positive on `behind`.
    setExecResponses([
      { ok: true, stdout: '' },
      { ok: true, stdout: '## main...origin/main [behind 3]\n' },
    ]);
    const result = isWorktreeClean('/tmp/behind-wt');
    expect(result).toBe(true);
  });
});

// ===========================================================================
// Group 3 — Phase 4a SKILL.md structure verification
// ===========================================================================

describe('Phase 4a SKILL.md structure — #575 P3.2 documentation contract', () => {
  const content = readFileSync(SKILL_PATH, 'utf8');

  it('SKILL.md contains Phase 4a section positioned between Phase 4 and Phase 5', () => {
    const p4Idx = content.indexOf('## Phase 4: Commit & Push');
    const p4aIdx = content.indexOf('## Phase 4a: Auto-Promoted Worktree Cleanup');
    const p5Idx = content.indexOf('## Phase 5: Issue Cleanup');
    expect(p4Idx).toBeGreaterThan(-1);
    expect(p4aIdx).toBeGreaterThan(p4Idx);
    expect(p5Idx).toBeGreaterThan(p4aIdx);
  });

  it('Phase 4a section title references issue #575 P3.2', () => {
    expect(content).toContain('## Phase 4a: Auto-Promoted Worktree Cleanup (#575 P3.2)');
  });

  it('Phase 4a documents PSA-003 compliance', () => {
    const p4aIdx = content.indexOf('## Phase 4a');
    const p5Idx = content.indexOf('## Phase 5');
    const p4aBlock = content.slice(p4aIdx, p5Idx);
    expect(p4aBlock).toContain('PSA-003');
  });

  it('Phase 4a references #490 durableCommit ordering', () => {
    const p4aIdx = content.indexOf('## Phase 4a');
    const p5Idx = content.indexOf('## Phase 5');
    const p4aBlock = content.slice(p4aIdx, p5Idx);
    expect(p4aBlock).toContain('#490');
    expect(p4aBlock).toContain('durableCommit');
  });

  it('Phase 4a includes 3-option AUQ (Behalten / Löschen / Manuell)', () => {
    const p4aIdx = content.indexOf('## Phase 4a');
    const p5Idx = content.indexOf('## Phase 5');
    const p4aBlock = content.slice(p4aIdx, p5Idx);
    expect(p4aBlock).toContain('Behalten');
    expect(p4aBlock).toContain('Löschen');
    expect(p4aBlock).toContain('Manuell');
  });

  it('Phase 4a documents PSA-003 destructive-action authorisation for git worktree remove --force', () => {
    const p4aIdx = content.indexOf('## Phase 4a');
    const p5Idx = content.indexOf('## Phase 5');
    const p4aBlock = content.slice(p4aIdx, p5Idx);
    // The AUQ must be required for `--force` removal — verify the rationale text exists.
    expect(p4aBlock).toMatch(/git worktree remove --force/);
    expect(p4aBlock).toMatch(/PSA-003.*destructive action safeguards|destructive action safeguards.*PSA-003/s);
  });

  it('Phase 4a references parseSessionId() from session-id.mjs', () => {
    const p4aIdx = content.indexOf('## Phase 4a');
    const p5Idx = content.indexOf('## Phase 5');
    const p4aBlock = content.slice(p4aIdx, p5Idx);
    expect(p4aBlock).toContain('parseSessionId');
    expect(p4aBlock).toContain('scripts/lib/session-id.mjs');
  });
});
