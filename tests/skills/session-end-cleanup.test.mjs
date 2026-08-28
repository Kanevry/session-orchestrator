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
 *   - The mock is applied BEFORE module import; all `execFileSync` calls in the
 *     SUT route through the configured mock.
 *   - #577 HARDEN-001: the SUT now calls `execFileSync('git', [args…])` (arg
 *     array, no shell). The stubs below match on the args array, not a command
 *     string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Mock node:child_process BEFORE importing the module under test.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    throw new Error(
      'session-end-cleanup test: execFileSync called without a per-test mock. ' +
        'This would shell out to a real git CLI — failing fast.',
    );
  }),
}));

const { execFileSync } = await import('node:child_process');
const { detectAutoPromotedWorktree, isWorktreeClean } = await import(
  '@lib/session-end/worktree-cleanup.mjs'
);

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKILL_PATH = join(PROJECT_ROOT, 'skills', 'session-end', 'SKILL.md');

// ---------------------------------------------------------------------------
// Helper: program a deterministic sequence of execFileSync responses.
// Each call consumes the next response in the array.
//
// #577 HARDEN-001: the SUT invokes `execFileSync('git', ['-C', dir, 'worktree',
// 'list', '--porcelain'], …)` (arg array, no shell). The mock receives
// `(file, args, options)`. Object-spec responses are matched positionally
// (sequential consumption). Function-spec responses receive `(file, args,
// callIndex)` so a test can assert on the args array directly.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ok: boolean, stdout?: string} | ((file: string, args: string[], callIndex: number) => string)>} responses
 */
function setExecResponses(responses) {
  let i = 0;
  execFileSync.mockImplementation((file, args) => {
    const spec = responses[i++];
    if (!spec) {
      throw new Error(
        `session-end-cleanup test: unexpected extra execFileSync call #${i} (${file} ${JSON.stringify(args)})`,
      );
    }
    if (typeof spec === 'function') return spec(file, args, i - 1);
    if (spec.ok === false) {
      throw new Error(spec.stderr ?? 'git error');
    }
    return spec.stdout ?? '';
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  execFileSync.mockImplementation(() => {
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
      // #1069: which KEY matched is part of the contract — a silent switch to
      // the legacy key is what made Phase 4a dead in the first place.
      source: 'basename',
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
    // No execFileSync expected — parseSessionId returns format:'uuid', function exits early.
    execFileSync.mockImplementation(() => {
      throw new Error('UUID path should not invoke execFileSync');
    });
    const result = detectAutoPromotedWorktree(
      '/tmp/parent/myrepo-550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440000',
    );
    expect(result).toBeNull();
  });

  it('returns null when sessionId does not match either known format', () => {
    // parseSessionId returns null for unrecognised strings → function exits early.
    execFileSync.mockImplementation(() => {
      throw new Error('null-parse path should not invoke execFileSync');
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
      // second execFileSync call is NOT made (short-circuits on first non-empty porcelain)
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

  // The marker `enterWorktree()` writes lives in `.orchestrator/`, which this
  // repo only PARTLY gitignores — so it surfaces as an untracked file. Left
  // unfiltered it would make EVERY promoted worktree dirty and turn the Phase 4a
  // clean path (auto-remove) into a permanent AUQ. Table: the one line that is
  // discounted, beside the near-misses that must still count as dirty.
  const porcelainCases = [
    ['bare untracked marker', '?? .orchestrator/promoted-from.json\n', true],
    ['quoted untracked marker', '?? ".orchestrator/promoted-from.json"\n', true],
    [
      'marker beside real untracked work',
      '?? .orchestrator/promoted-from.json\n?? notes.md\n',
      false,
    ],
    ['MODIFIED marker (not untracked)', ' M .orchestrator/promoted-from.json\n', false],
    ['STAGED marker (not untracked)', 'A  .orchestrator/promoted-from.json\n', false],
    ['a DIFFERENT untracked file in .orchestrator/', '?? .orchestrator/other.json\n', false],
    ['a path merely ENDING in the marker name', '?? nested/promoted-from.json\n', false],
  ];

  it.each(porcelainCases)('porcelain: %s', (_label, porcelain, expectedClean) => {
    setExecResponses([
      { ok: true, stdout: porcelain },
      { ok: true, stdout: '## main...origin/main\n' },
    ]);
    expect(isWorktreeClean('/tmp/marker-wt')).toBe(expectedClean);
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

// ===========================================================================
// Group 4 — marker-keyed detection across the #1069 process boundary
//
// The bug this group pins: since #1069 the session that RUNS in the promoted
// worktree is a NEW session with its OWN id, and since #1067 the worktree sits
// on `so/<sourceSessionId>`. The legacy key compares
// `basename(repoRoot) === <mainRepoName>-<CURRENT sessionId>`, which can then
// never hold — so Phase 4a was dead code in exactly the configuration it was
// written for. The marker written by `enterWorktree()` is the recorded fact
// that survives the boundary.
//
// Real files, real fs (only `node:child_process` is mocked) — the marker is a
// filesystem contract, and a mocked reader would pin the mock, not the format.
// ===========================================================================

describe('detectAutoPromotedWorktree() — promotion marker (#1069 boundary)', () => {
  const MARKER_RELPATH = join('.orchestrator', 'promoted-from.json');
  const SOURCE_ID = 'main-2026-08-28-session-2';
  const OTHER_ID = 'main-2026-08-28-session-9'; // the NEW session's id — never in the path
  let tmpRoot;
  let wtPath;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-marker-')));
    // Directory name deliberately carries the SOURCE id, so the legacy key can
    // only ever match for SOURCE_ID and never for OTHER_ID.
    wtPath = join(tmpRoot, `myrepo-${SOURCE_ID}`);
    mkdirSync(join(wtPath, '.orchestrator'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Write a raw marker payload (string written verbatim — corrupt cases too). */
  function writeMarker(raw) {
    writeFileSync(join(wtPath, MARKER_RELPATH), raw, 'utf8');
  }

  const validMarker = () =>
    JSON.stringify({
      source_root_hash: 'a'.repeat(64),
      source_root_basename: 'myrepo',
      source_session_id: SOURCE_ID,
      branch: `so/${SOURCE_ID}`,
      promoted_at: '2026-08-28T09:00:00.000Z',
    });

  it('detects the worktree from the marker when the CURRENT session id differs (#1069)', () => {
    writeMarker(validMarker());
    // Only one git call is expected: `git branch --show-current`.
    setExecResponses([{ ok: true, stdout: `so/${SOURCE_ID}\n` }]);

    const result = detectAutoPromotedWorktree(wtPath, OTHER_ID);

    expect(result).toEqual({
      wtPath,
      sessionId: SOURCE_ID,
      branch: `so/${SOURCE_ID}`,
      source: 'marker',
    });
    // The command actually issued — an args ARRAY, never a shell string (#577).
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', wtPath, 'branch', '--show-current'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('accepts the marker when the branch cannot be read at all (git error / detached HEAD)', () => {
    // Conservative in the SAFE direction: detection says "promoted", and the
    // destructive step stays gated by isWorktreeClean(), which fails closed.
    writeMarker(validMarker());
    setExecResponses([{ ok: false, stderr: 'fatal: not a git repository' }]);

    expect(detectAutoPromotedWorktree(wtPath, OTHER_ID)).toMatchObject({
      source: 'marker',
      branch: `so/${SOURCE_ID}`,
    });
  });

  // Table: every way a marker can fail to be usable. All of them must fall
  // through to the legacy key — which, with the CURRENT session id differing
  // from the directory name, yields null. None of them may throw.
  const unusableMarkers = [
    ['corrupt JSON', '{ not json at all'],
    ['empty file', ''],
    ['JSON array (wrong container)', '[]'],
    ['JSON null', 'null'],
    ['missing branch', JSON.stringify({ source_session_id: SOURCE_ID })],
    ['empty branch', JSON.stringify({ source_session_id: SOURCE_ID, branch: '' })],
    ['missing source_session_id', JSON.stringify({ branch: `so/${SOURCE_ID}` })],
    ['non-string branch', JSON.stringify({ source_session_id: SOURCE_ID, branch: 42 })],
  ];

  it.each(unusableMarkers)('falls back to the legacy key on an unusable marker: %s', (_label, raw) => {
    writeMarker(raw);
    // The legacy key runs and issues its own `git worktree list --porcelain`.
    setExecResponses([
      { ok: true, stdout: `worktree ${join(tmpRoot, 'myrepo')}\n\nworktree ${wtPath}\n` },
    ]);

    expect(() => detectAutoPromotedWorktree(wtPath, OTHER_ID)).not.toThrow();
  });

  it('falls back to the legacy key when the worktree sits on a DIFFERENT branch than the marker records', () => {
    // A stale marker copied into an unrelated checkout must not hijack detection.
    writeMarker(validMarker());
    setExecResponses([
      { ok: true, stdout: 'feature/unrelated\n' }, // branch --show-current
      { ok: true, stdout: `worktree ${join(tmpRoot, 'myrepo')}\n\nworktree ${wtPath}\n` },
    ]);

    // Legacy key: basename is `myrepo-<SOURCE_ID>`, current id is OTHER_ID → no match.
    expect(detectAutoPromotedWorktree(wtPath, OTHER_ID)).toBeNull();
  });

  it('legacy key still works (and is labelled) when the marker is absent', () => {
    // No marker written at all — the pre-#1069 same-session case.
    setExecResponses([
      { ok: true, stdout: `worktree ${join(tmpRoot, 'myrepo')}\n\nworktree ${wtPath}\n` },
    ]);

    expect(detectAutoPromotedWorktree(wtPath, SOURCE_ID)).toEqual({
      wtPath,
      sessionId: SOURCE_ID,
      branch: 'main',
      source: 'basename',
    });
  });

  it('marker wins over the legacy key when BOTH would match', () => {
    // Same directory, same session id — the marker still decides, and reports
    // the branch the worktree is really on (`so/…`), not the session label's
    // branch component (`main`) the legacy key infers.
    writeMarker(validMarker());
    setExecResponses([{ ok: true, stdout: `so/${SOURCE_ID}\n` }]);

    expect(detectAutoPromotedWorktree(wtPath, SOURCE_ID)).toEqual({
      wtPath,
      sessionId: SOURCE_ID,
      branch: `so/${SOURCE_ID}`,
      source: 'marker',
    });
  });
});
