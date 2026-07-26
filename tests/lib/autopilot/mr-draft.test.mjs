/**
 * tests/lib/autopilot/mr-draft.test.mjs
 *
 * Unit tests for scripts/lib/autopilot/mr-draft.mjs (W3 P-MR-Draft).
 * All execFile calls use vi.fn() mocks — zero real glab/gh subprocess invocations.
 *
 * Coverage:
 *   - MrDraftError class contract
 *   - validateMrInputs: shell-metachar rejection + length limits
 *   - buildMrBody: output shape, WIP marker, truncation
 *   - checkExistingMR: glab + gh paths, field mapping
 *   - maybeCreateDraftMR: policy off/on-green/on-loop-start, vcs unsupported,
 *     collision skip, ENOENT handling, execFile called with shell:false
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #872 Gap-3 fixture — mock ONLY `execFileSync` (the sync git-remote layer
// `vcs-repo-spec.mjs`'s default `resolveRepoSpec` shells out through) so the
// production-default-wiring tests below can control `git remote get-url`
// without ever touching a real repo. `execFile` (the async fn mr-draft.mjs
// itself uses) stays the REAL implementation — every test in this file
// always supplies `opts.execFile` as a mock, so it is never invoked for real.
// Uses top-level await + dynamic import (precedent:
// tests/lib/spiral-carryover.test.mjs:22-41) so the mock registers before the
// module under test is imported.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn() };
});

const { execFileSync } = await import('node:child_process');
const {
  MrDraftError,
  validateMrInputs,
  checkExistingMR: checkExistingMRReal,
  buildMrBody,
  buildEvidenceBlock,
  maybeCreateDraftMR: maybeCreateDraftMRReal,
} = await import('@lib/autopilot/mr-draft.mjs');

// ---------------------------------------------------------------------------
// #872 host-pinning shim
//
// checkExistingMR/maybeCreateDraftMR now resolve a `-R`/`--repo` spec via an
// injectable `resolveRepoSpecFn` (default: the real `resolveRepoSpec`, which
// shells out to `git remote get-url`). The tests below this shim block
// predate #872 and assert an EXACT/arrayContaining execFile call shape
// without any `-R` — so these local wrappers inject a no-op resolver
// (`() => undefined`, matching pre-#872 "no -R appended" behaviour) as the
// DEFAULT, keeping every existing test's call shape byte-for-byte identical
// without editing a single one of them. Precedent:
// tests/lib/spiral-carryover.test.mjs:57-67. The "#872 host pinning" describe
// blocks further down call the `*Real` functions directly with an explicit
// resolveRepoSpecFn (or omit it to exercise the production default).
// ---------------------------------------------------------------------------
function checkExistingMR(opts) {
  return checkExistingMRReal({ resolveRepoSpecFn: () => undefined, ...opts });
}
function maybeCreateDraftMR(loop, opts = {}) {
  return maybeCreateDraftMRReal(loop, { resolveRepoSpecFn: () => undefined, ...opts });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal valid loop object for maybeCreateDraftMR tests. */
function makeLoop(overrides = {}) {
  return {
    vcs: 'gitlab',
    issueIid: 7,
    issueTitle: 'Fix login bug',
    branchName: 'issue-7-fix-login-bug',
    parentRunId: 'run-abc',
    worktreePath: '/tmp/wt/issue-7',
    draftMrPolicy: 'on-loop-start',
    ...overrides,
  };
}

/** Mock execFile that returns an empty MR list — no collision. */
function makeEmptyListExec() {
  return vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
}

/** Mock execFile that returns one existing MR for glab. */
function makeExistingGlabExec(iid = 42, web_url = 'https://gitlab.example.com/-/mr/42') {
  return vi.fn().mockResolvedValue({
    stdout: JSON.stringify([{ iid, web_url }]),
    stderr: '',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// MrDraftError
// ---------------------------------------------------------------------------

describe('MrDraftError', () => {
  it('is instanceof Error', () => {
    const e = new MrDraftError('something failed', 'VALIDATION');
    expect(e).toBeInstanceOf(Error);
  });

  it('stores the provided code on .code', () => {
    const e = new MrDraftError('msg', 'EXEC_FAILURE');
    expect(e.code).toBe('EXEC_FAILURE');
  });

  it('has .name === MrDraftError', () => {
    const e = new MrDraftError('msg', 'POLICY_OFF');
    expect(e.name).toBe('MrDraftError');
  });

  it('stores the message', () => {
    const e = new MrDraftError('custom message', 'UNSUPPORTED_VCS');
    expect(e.message).toBe('custom message');
  });
});

// ---------------------------------------------------------------------------
// validateMrInputs — dangerous shell metacharacters
// ---------------------------------------------------------------------------

describe('validateMrInputs — CLI-arg-boundary rejection (SEC-PD-MED-1 narrowed)', () => {
  // Per W4 Q6 security-reviewer finding SEC-PD-MED-1: the original broad
  // shell-metacharacter regex was over-broad — `execFile(..., {shell: false})`
  // already prevents shell interpretation, so only CLI-arg-boundary chars
  // (newlines, null bytes) need rejection. Common GitLab issue titles like
  // "Fix nav bug (closes #123)" or "Add [WIP] layout" must now be accepted.
  it.each([
    ['newline in title', 'fix bug\nrm -rf /'],
    ['CR in title', 'fix bug\rmalicious'],
    ['null byte in title', 'fix bug\0extra'],
  ])('rejects title containing %s', (_name, title) => {
    expect(() => validateMrInputs(title, 'clean desc')).toThrow(MrDraftError);
  });

  it.each([
    ['null byte in desc', 'ok title', 'desc\0malicious'],
  ])('rejects description containing %s', (_name, title, desc) => {
    expect(() => validateMrInputs(title, desc)).toThrow(MrDraftError);
  });

  // Regression canary: titles previously rejected by SHELL_DANGEROUS regex
  // are now ACCEPTED. These are legitimate GitLab issue titles.
  it.each([
    ['parentheses', 'Fix nav bug (closes #123)'],
    ['square brackets', 'Add [WIP] layout module'],
    ['exclamation', 'Critical fix!'],
    ['ampersand', 'Auth & session refactor'],
    ['semicolon', 'feat: add foo; deprecate bar'],
    ['dollar sign', 'Format $100 currency display'],
    ['less-greater', 'Compare a < b > c logic'],
    ['backtick', 'Replace `eval` calls'],
    ['pipe', 'CI: rg | head fix'],
    ['curly braces', 'Refactor {context} prop'],
  ])('accepts legitimate title with %s (regression canary)', (_name, title) => {
    expect(() => validateMrInputs(title, 'clean desc')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateMrInputs — length + newline rules
// ---------------------------------------------------------------------------

describe('validateMrInputs — length and newline rules', () => {
  it('accepts a clean title and clean description without throwing', () => {
    expect(() => validateMrInputs('Fix login bug', 'Simple description.')).not.toThrow();
  });

  it('accepts empty string description', () => {
    expect(() => validateMrInputs('Fix login bug', '')).not.toThrow();
  });

  it('throws VALIDATION when title exceeds 200 chars', () => {
    const longTitle = 'x'.repeat(201);
    expect(() => validateMrInputs(longTitle, '')).toThrow(MrDraftError);
  });

  it('throws VALIDATION when title contains newline', () => {
    expect(() => validateMrInputs('line1\nline2', '')).toThrow(MrDraftError);
  });

  it('throws VALIDATION when description exceeds 10000 chars', () => {
    const longDesc = 'a'.repeat(10_001);
    expect(() => validateMrInputs('ok', longDesc)).toThrow(MrDraftError);
  });

  it('thrown error has code VALIDATION for oversized title', () => {
    try {
      validateMrInputs('x'.repeat(201), '');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('VALIDATION');
    }
  });

  it('thrown error has code VALIDATION for newline title char', () => {
    try {
      validateMrInputs('bad\ntitle', '');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// buildMrBody
// ---------------------------------------------------------------------------

describe('buildMrBody', () => {
  it('returns an object with title and description as non-empty strings', () => {
    const result = buildMrBody({
      issueTitle: 'Add feature X',
      issueIid: 55,
      parentRunId: 'run-001',
      worktreePath: '/tmp/wt',
    });
    expect(typeof result.title).toBe('string');
    expect(typeof result.description).toBe('string');
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.description.length).toBeGreaterThan(0);
  });

  it('title starts with [WIP]', () => {
    const { title } = buildMrBody({
      issueTitle: 'Refactor auth',
      issueIid: 10,
      parentRunId: 'p-1',
      worktreePath: '/w',
    });
    expect(title.startsWith('[WIP]')).toBe(true);
  });

  it('title contains the issueTitle', () => {
    const { title } = buildMrBody({
      issueTitle: 'My Specific Issue',
      issueIid: 99,
      parentRunId: 'p-99',
      worktreePath: '/w',
    });
    expect(title).toContain('My Specific Issue');
  });

  it('description contains the issueIid as #<number>', () => {
    const { description } = buildMrBody({
      issueTitle: 'Some issue',
      issueIid: 42,
      parentRunId: 'p-42',
      worktreePath: '/w',
    });
    expect(description).toContain('#42');
  });

  it('description contains the parentRunId', () => {
    const { description } = buildMrBody({
      issueTitle: 'Some issue',
      issueIid: 1,
      parentRunId: 'run-xyz-789',
      worktreePath: '/w',
    });
    expect(description).toContain('run-xyz-789');
  });

  it('description contains TODO checkboxes', () => {
    const { description } = buildMrBody({
      issueTitle: 'Some issue',
      issueIid: 1,
      parentRunId: 'p-1',
      worktreePath: '/w',
    });
    expect(description).toContain('- [ ]');
  });

  it('truncates title to ≤200 chars when issueTitle is very long', () => {
    const longTitle = 'A'.repeat(180);
    const { title } = buildMrBody({
      issueTitle: longTitle,
      issueIid: 1,
      parentRunId: 'p',
      worktreePath: '/w',
    });
    expect(title.length).toBeLessThanOrEqual(200);
  });

  it('truncated title ends with the ellipsis character', () => {
    const longTitle = 'B'.repeat(180);
    const { title } = buildMrBody({
      issueTitle: longTitle,
      issueIid: 1,
      parentRunId: 'p',
      worktreePath: '/w',
    });
    // Title was truncated — last character must be the ellipsis
    expect(title[title.length - 1]).toBe('…');
  });
});

// ---------------------------------------------------------------------------
// buildEvidenceBlock — sub-section rendering (issue #669)
// ---------------------------------------------------------------------------

describe('buildEvidenceBlock — sub-section rendering', () => {
  it('renders the ## Evidence header and a collapsible <details> wrapper', () => {
    const md = buildEvidenceBlock({}).join('\n');
    expect(md).toContain('## Evidence');
    expect(md).toContain('<details>');
    expect(md).toContain('</details>');
  });

  it('renders all four sub-section headers', () => {
    const md = buildEvidenceBlock({}).join('\n');
    expect(md).toContain('### Decision trace (per wave)');
    expect(md).toContain('### Quality gates');
    expect(md).toContain('### Changed files');
    expect(md).toContain('### Carryover');
  });

  it('renders per-wave decision trace from a {wave, summary} array', () => {
    const md = buildEvidenceBlock({
      waveSummary: [
        { wave: 'W1', summary: 'Discovery: mapped 4 callers' },
        { wave: 'W2', summary: 'Impl: added evidence block' },
      ],
    }).join('\n');
    expect(md).toContain('- **W1:** Discovery: mapped 4 callers');
    expect(md).toContain('- **W2:** Impl: added evidence block');
  });

  it('renders quality-gate exit codes and summaries in a table row', () => {
    const md = buildEvidenceBlock({
      gateResults: {
        test: { exitCode: 0, summary: '9303 passed / 0 failed' },
        typecheck: { exitCode: 0, summary: '0 errors' },
        lint: { exitCode: 1, summary: '2 warnings' },
      },
    }).join('\n');
    expect(md).toContain('| test | 0 | 9303 passed / 0 failed |');
    expect(md).toContain('| typecheck | 0 | 0 errors |');
    expect(md).toContain('| lint | 1 | 2 warnings |');
  });

  it('renders a non-zero gate exit code (e.g. 1) — not coerced to n/a', () => {
    const md = buildEvidenceBlock({
      gateResults: { test: { exitCode: 1, summary: '5 failed' } },
    }).join('\n');
    expect(md).toContain('| test | 1 | 5 failed |');
  });

  it('renders changed-files as a count line plus backticked paths', () => {
    const md = buildEvidenceBlock({
      changedFiles: ['scripts/lib/autopilot/mr-draft.mjs', 'tests/lib/autopilot/mr-draft.test.mjs'],
    }).join('\n');
    expect(md).toContain('2 file(s) changed:');
    expect(md).toContain('- `scripts/lib/autopilot/mr-draft.mjs`');
    expect(md).toContain('- `tests/lib/autopilot/mr-draft.test.mjs`');
  });

  it('renders carryover items from a {ref, note} array', () => {
    const md = buildEvidenceBlock({
      carryover: [{ ref: '#670', note: 'follow-up: vault naming' }],
    }).join('\n');
    expect(md).toContain('- #670 — follow-up: vault naming');
  });

  it('renders "n/a" for every sub-section when no evidence fields are supplied', () => {
    const lines = buildEvidenceBlock({});
    // Each of the four sub-sections must contribute an "n/a" placeholder.
    const naCount = lines.filter((l) => l === 'n/a').length;
    expect(naCount).toBe(3); // wave, changed-files, carryover (gates render as table rows)
    // Gates table renders n/a exit codes when no gateResults passed.
    const md = lines.join('\n');
    expect(md).toContain('| test | n/a | n/a |');
  });
});

// ---------------------------------------------------------------------------
// buildMrBody — evidence block default-ON + SO_MR_EVIDENCE opt-out (issue #669)
// ---------------------------------------------------------------------------

describe('buildMrBody — evidence block (default ON, SO_MR_EVIDENCE opt-out)', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.SO_MR_EVIDENCE;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.SO_MR_EVIDENCE;
    } else {
      process.env.SO_MR_EVIDENCE = savedEnv;
    }
  });

  it('includes the ## Evidence block by default (env unset)', () => {
    delete process.env.SO_MR_EVIDENCE;
    const { description } = buildMrBody({
      issueTitle: 'Add evidence block',
      issueIid: 669,
      parentRunId: 'run-1',
      worktreePath: '/tmp/wt',
    });
    expect(description).toContain('## Evidence');
    expect(description).toContain('### Quality gates');
  });

  it('renders supplied gate exit codes inside the MR body by default', () => {
    delete process.env.SO_MR_EVIDENCE;
    const { description } = buildMrBody({
      issueTitle: 'Add evidence block',
      issueIid: 669,
      parentRunId: 'run-1',
      worktreePath: '/tmp/wt',
      gateResults: { test: { exitCode: 0, summary: '12 passed' } },
    });
    expect(description).toContain('| test | 0 | 12 passed |');
  });

  it('OMITS the ## Evidence block when SO_MR_EVIDENCE=off', () => {
    process.env.SO_MR_EVIDENCE = 'off';
    const { description } = buildMrBody({
      issueTitle: 'Add evidence block',
      issueIid: 669,
      parentRunId: 'run-1',
      worktreePath: '/tmp/wt',
      gateResults: { test: { exitCode: 0, summary: '12 passed' } },
    });
    expect(description).not.toContain('## Evidence');
    expect(description).not.toContain('### Quality gates');
  });

  it('keeps the Autopilot Draft section regardless of the opt-out', () => {
    process.env.SO_MR_EVIDENCE = 'off';
    const { description } = buildMrBody({
      issueTitle: 'Add evidence block',
      issueIid: 669,
      parentRunId: 'run-1',
      worktreePath: '/tmp/wt',
    });
    expect(description).toContain('## Autopilot Draft');
    expect(description).toContain('### Code Review');
  });

  it('includes an all-"n/a" evidence block for legacy callers that pass no evidence fields', () => {
    delete process.env.SO_MR_EVIDENCE;
    // Mirrors mr-opener.mjs / worktree-pipeline.mjs call shape (no evidence fields).
    const { description } = buildMrBody({
      issueTitle: 'Legacy caller',
      issueIid: 1,
      parentRunId: 'p-1',
      worktreePath: '/w',
    });
    expect(description).toContain('## Evidence');
    expect(description).toContain('| test | n/a | n/a |');
  });
});

// ---------------------------------------------------------------------------
// checkExistingMR — glab path
// ---------------------------------------------------------------------------

describe('checkExistingMR — glab', () => {
  it('returns {hasMR: false, mrIid: null, mrUrl: null} when list is empty', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const result = await checkExistingMR({
      vcs: 'glab',
      branchName: 'issue-1',
      execFile: mockExec,
    });
    expect(result).toEqual({ hasMR: false, mrIid: null, mrUrl: null });
  });

  it('calls execFile with shell:false (security invariant)', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMR({ vcs: 'glab', branchName: 'issue-1', execFile: mockExec });
    expect(mockExec).toHaveBeenCalledWith(
      'glab',
      expect.arrayContaining(['mr', 'list']),
      expect.objectContaining({ shell: false }),
    );
  });

  it('returns {hasMR: true} with correct iid and mrUrl when MR exists (glab)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ iid: 42, web_url: 'https://gitlab.example.com/-/mr/42' }]),
      stderr: '',
    });
    const result = await checkExistingMR({
      vcs: 'glab',
      branchName: 'issue-1',
      execFile: mockExec,
    });
    expect(result).toEqual({
      hasMR: true,
      mrIid: 42,
      mrUrl: 'https://gitlab.example.com/-/mr/42',
    });
  });
});

// ---------------------------------------------------------------------------
// checkExistingMR — gh path
// ---------------------------------------------------------------------------

describe('checkExistingMR — gh', () => {
  it('returns {hasMR: false} for empty PR list', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const result = await checkExistingMR({
      vcs: 'gh',
      branchName: 'issue-5',
      execFile: mockExec,
    });
    expect(result).toEqual({ hasMR: false, mrIid: null, mrUrl: null });
  });

  it('maps number+url fields for gh (not iid+web_url)', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ number: 17, url: 'https://github.com/org/repo/pull/17' }]),
      stderr: '',
    });
    const result = await checkExistingMR({
      vcs: 'gh',
      branchName: 'issue-5',
      execFile: mockExec,
    });
    expect(result).toEqual({
      hasMR: true,
      mrIid: 17,
      mrUrl: 'https://github.com/org/repo/pull/17',
    });
  });

  it('calls execFile with shell:false for gh as well', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMR({ vcs: 'gh', branchName: 'issue-5', execFile: mockExec });
    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'list']),
      expect.objectContaining({ shell: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// checkExistingMR — unsupported vcs
// ---------------------------------------------------------------------------

describe('checkExistingMR — unsupported vcs', () => {
  it('throws MrDraftError(UNSUPPORTED_VCS) for an unknown vcs string', async () => {
    const mockExec = vi.fn();
    await expect(
      checkExistingMR({ vcs: 'bitbucket', branchName: 'b', execFile: mockExec }),
    ).rejects.toThrow(MrDraftError);
  });

  it('thrown error has code UNSUPPORTED_VCS', async () => {
    const mockExec = vi.fn();
    try {
      await checkExistingMR({ vcs: 'bitbucket', branchName: 'b', execFile: mockExec });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('UNSUPPORTED_VCS');
    }
  });
});

// ---------------------------------------------------------------------------
// maybeCreateDraftMR — policy gates
// ---------------------------------------------------------------------------

describe('maybeCreateDraftMR — policy gates', () => {
  it('policy=off returns {created: false} without calling execFile', async () => {
    const mockExec = vi.fn();
    const result = await maybeCreateDraftMR(makeLoop({ draftMrPolicy: 'off' }), {
      execFile: mockExec,
    });
    expect(result.created).toBe(false);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('policy=on-green returns {created: false, deferred: true} without calling execFile', async () => {
    const mockExec = vi.fn();
    const result = await maybeCreateDraftMR(makeLoop({ draftMrPolicy: 'on-green' }), {
      execFile: mockExec,
    });
    expect(result.created).toBe(false);
    expect(result.deferred).toBe(true);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('unknown policy throws MrDraftError(VALIDATION)', async () => {
    const mockExec = vi.fn();
    await expect(
      maybeCreateDraftMR(makeLoop({ draftMrPolicy: 'when-feeling-lucky' }), {
        execFile: mockExec,
      }),
    ).rejects.toThrow(MrDraftError);
  });

  it('unknown policy error has code VALIDATION', async () => {
    const mockExec = vi.fn();
    try {
      await maybeCreateDraftMR(makeLoop({ draftMrPolicy: 'invalid' }), { execFile: mockExec });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// maybeCreateDraftMR — unsupported vcs
// ---------------------------------------------------------------------------

describe('maybeCreateDraftMR — unsupported vcs', () => {
  it('throws MrDraftError(UNSUPPORTED_VCS) for an unknown vcs value with on-loop-start', async () => {
    const mockExec = vi.fn();
    await expect(
      maybeCreateDraftMR(makeLoop({ vcs: 'bitbucket', draftMrPolicy: 'on-loop-start' }), {
        execFile: mockExec,
      }),
    ).rejects.toThrow(MrDraftError);
  });

  it('thrown error has code UNSUPPORTED_VCS for unknown vcs', async () => {
    const mockExec = vi.fn();
    try {
      await maybeCreateDraftMR(makeLoop({ vcs: 'svn', draftMrPolicy: 'on-loop-start' }), {
        execFile: mockExec,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('UNSUPPORTED_VCS');
    }
  });
});

// ---------------------------------------------------------------------------
// maybeCreateDraftMR — happy path on-loop-start
// ---------------------------------------------------------------------------

describe('maybeCreateDraftMR — on-loop-start happy path', () => {
  it('returns {created: true, mrUrl} when execFile succeeds (gitlab)', async () => {
    // First call: glab mr list → empty (no collision)
    // Second call: glab mr create → returns URL
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/-/mr/99\n', stderr: '' });

    const result = await maybeCreateDraftMR(makeLoop(), { execFile: mockExec });

    expect(result.created).toBe(true);
    expect(result.mrUrl).toBe('https://gitlab.example.com/-/mr/99');
  });

  it('create execFile call uses shell:false (security invariant)', async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/-/mr/1\n', stderr: '' });

    await maybeCreateDraftMR(makeLoop(), { execFile: mockExec });

    // Both calls must have shell: false
    for (const call of mockExec.mock.calls) {
      expect(call[2]).toMatchObject({ shell: false });
    }
  });

  it('returns {created: false, existing: true} when collision detected — skips create call', async () => {
    const mockExec = makeExistingGlabExec(77, 'https://gitlab.example.com/-/mr/77');
    const result = await maybeCreateDraftMR(makeLoop(), { execFile: mockExec });

    expect(result.created).toBe(false);
    expect(result.existing).toBe(true);
    expect(result.mrUrl).toBe('https://gitlab.example.com/-/mr/77');
    // Only one execFile call (the list check), not two (no create attempt)
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// maybeCreateDraftMR — error handling
// ---------------------------------------------------------------------------

describe('maybeCreateDraftMR — error handling (never throws upward)', () => {
  it('returns {created: false, error: "binary not found"} when execFile rejects with ENOENT on create', async () => {
    const enoentError = Object.assign(new Error('glab not found'), { code: 'ENOENT' });
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' }) // list: no collision
      .mockRejectedValueOnce(enoentError); // create: ENOENT

    const result = await maybeCreateDraftMR(makeLoop(), { execFile: mockExec });

    expect(result.created).toBe(false);
    expect(result.error).toBe('binary not found');
  });

  it('returns {created: false, error: <message>} for non-ENOENT create failure', async () => {
    const genericError = new Error('network timeout');
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockRejectedValueOnce(genericError);

    const result = await maybeCreateDraftMR(makeLoop(), { execFile: mockExec });

    expect(result.created).toBe(false);
    expect(result.error).toBe('network timeout');
  });

  it('does not throw when execFile rejects — always returns an object', async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockRejectedValueOnce(new Error('unexpected failure'));

    await expect(maybeCreateDraftMR(makeLoop(), { execFile: mockExec })).resolves.toBeTypeOf(
      'object',
    );
  });

  it('returns {created: false, error} when the collision-check execFile itself rejects', async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error('glab list failed'));
    const result = await maybeCreateDraftMR(makeLoop(), { execFile: mockExec });

    expect(result.created).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// checkExistingMR — JSON.parse safety (#669 hardening)
// ---------------------------------------------------------------------------
//
// glab/gh can prepend a warning line to JSON output when credentials are
// degraded. A raw JSON.parse throws SyntaxError in that case. The fix wraps
// the parse in try/catch and re-throws as a typed MrDraftError(EXEC_FAILURE).

describe('checkExistingMR — JSON.parse safety (#669)', () => {
  it('throws MrDraftError(EXEC_FAILURE) when glab stdout is warning-prefixed non-JSON', async () => {
    // Simulates: glab mr list prepends a warning line before the JSON payload
    const mockExec = vi.fn().mockResolvedValue({
      stdout: 'WARNING: token expiring soon\n[{"iid":1,"web_url":"http://example.com"}]',
      stderr: '',
    });
    let caught;
    try {
      await checkExistingMR({ vcs: 'glab', branchName: 'feat-x', execFile: mockExec });
    } catch (err) {
      caught = err;
    }
    // Must be a typed MrDraftError, not a raw SyntaxError
    expect(caught).toBeInstanceOf(MrDraftError);
    expect(caught.code).toBe('EXEC_FAILURE');
  });

  it('throws MrDraftError(EXEC_FAILURE) when glab stdout is plain garbage', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: 'fatal: not logged in\nPlease run glab auth login',
      stderr: '',
    });
    let caught;
    try {
      await checkExistingMR({ vcs: 'glab', branchName: 'feat-x', execFile: mockExec });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MrDraftError);
    expect(caught.code).toBe('EXEC_FAILURE');
  });

  it('throws MrDraftError(EXEC_FAILURE) when gh stdout is warning-prefixed non-JSON', async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: 'WARNING: gh update available\n[{"number":5,"url":"http://example.com/5"}]',
      stderr: '',
    });
    let caught;
    try {
      await checkExistingMR({ vcs: 'gh', branchName: 'feat-y', execFile: mockExec });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MrDraftError);
    expect(caught.code).toBe('EXEC_FAILURE');
  });

  it('does NOT throw MrDraftError on valid JSON (regression: guard must not break happy path)', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const result = await checkExistingMR({ vcs: 'glab', branchName: 'feat-z', execFile: mockExec });
    expect(result.hasMR).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeCreateDraftMR — validateMrInputs integration
// ---------------------------------------------------------------------------

describe('maybeCreateDraftMR — issueTitle validation boundary', () => {
  it('issueTitle with newline causes validateMrInputs to fire before execFile (never calls execFile)', async () => {
    const mockExec = vi.fn();
    // issueTitle with embedded newline — corrupts CLI arg semantics
    await expect(
      maybeCreateDraftMR(makeLoop({ issueTitle: 'Fix bug\nmalicious second line' }), {
        execFile: mockExec,
      }),
    ).rejects.toThrow(MrDraftError);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('safe issueTitle with normal text (no brackets/parens) is accepted', async () => {
    const mockExec = makeEmptyListExec();
    // Stub the create call too
    mockExec.mockResolvedValueOnce({ stdout: '[]', stderr: '' }).mockResolvedValueOnce({
      stdout: 'https://gitlab.example.com/-/mr/5\n',
      stderr: '',
    });

    // A normal issue title should NOT throw — validateMrInputs is for raw user input,
    // not for the assembled body which contains template-controlled '()' and '[ ]'
    await expect(
      maybeCreateDraftMR(makeLoop({ issueTitle: 'Fix login regression in auth module' }), {
        execFile: mockExec,
      }),
    ).resolves.toMatchObject({ created: true });
  });
});

// ---------------------------------------------------------------------------
// checkExistingMR — #872 -R/--repo host-pinning wiring
// ---------------------------------------------------------------------------

describe('checkExistingMR — #872 host pinning (glab)', () => {
  it('appends -R <spec> to the glab mr list call when resolveRepoSpecFn resolves', async () => {
    const spec = 'https://gitlab.example.com/example-group/example-project.git';
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMRReal({
      vcs: 'glab',
      branchName: 'issue-1',
      execFile: mockExec,
      resolveRepoSpecFn: () => spec,
    });
    const [, args] = mockExec.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining(['mr', 'list', '--source-branch', 'issue-1', '-R', spec]),
    );
    expect(args[args.indexOf('-R') + 1]).toBe(spec);
  });

  it('omits -R entirely when resolveRepoSpecFn returns undefined (never emits "-R undefined")', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMRReal({
      vcs: 'glab',
      branchName: 'issue-1',
      execFile: mockExec,
      resolveRepoSpecFn: () => undefined,
    });
    const [, args] = mockExec.mock.calls[0];
    expect(args).not.toContain('-R');
  });

  it('calls resolveRepoSpecFn exactly once for a single checkExistingMR call', async () => {
    const spec = 'https://gitlab.example.com/example-group/example-project.git';
    const resolveRepoSpecFn = vi.fn(() => spec);
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMRReal({
      vcs: 'glab',
      branchName: 'issue-1',
      execFile: mockExec,
      resolveRepoSpecFn,
    });
    expect(resolveRepoSpecFn).toHaveBeenCalledTimes(1);
    expect(resolveRepoSpecFn).toHaveBeenCalledWith({ repoRoot: process.cwd(), vcs: 'gitlab' });
  });
});

describe('checkExistingMR — #872 host pinning (gh)', () => {
  it('appends -R <spec> to the gh pr list call when resolveRepoSpecFn resolves', async () => {
    const spec = 'https://github.example.com/example-org/example-repo.git';
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMRReal({
      vcs: 'gh',
      branchName: 'issue-5',
      execFile: mockExec,
      resolveRepoSpecFn: () => spec,
    });
    const [, args] = mockExec.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['pr', 'list', '--head', 'issue-5', '-R', spec]));
    expect(args[args.indexOf('-R') + 1]).toBe(spec);
  });

  it('omits -R entirely when resolveRepoSpecFn returns undefined', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMRReal({
      vcs: 'gh',
      branchName: 'issue-5',
      execFile: mockExec,
      resolveRepoSpecFn: () => undefined,
    });
    const [, args] = mockExec.mock.calls[0];
    expect(args).not.toContain('-R');
  });

  it('resolveRepoSpecFn receives vcs: "github" (token-mapped from the glab/gh CLI-bin value)', async () => {
    const resolveRepoSpecFn = vi.fn(() => undefined);
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMRReal({
      vcs: 'gh',
      branchName: 'issue-5',
      execFile: mockExec,
      resolveRepoSpecFn,
    });
    expect(resolveRepoSpecFn).toHaveBeenCalledWith({ repoRoot: process.cwd(), vcs: 'github' });
  });
});

// ---------------------------------------------------------------------------
// maybeCreateDraftMR — #872 -R/--repo host-pinning wiring
// ---------------------------------------------------------------------------

describe('maybeCreateDraftMR — #872 host pinning (gitlab)', () => {
  it('pins both the glab mr list AND the glab mr create call to -R <spec>', async () => {
    const spec = 'https://gitlab.example.com/example-group/example-project.git';
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/-/mr/99\n', stderr: '' });

    const result = await maybeCreateDraftMRReal(makeLoop(), {
      execFile: mockExec,
      resolveRepoSpecFn: () => spec,
    });

    expect(result.created).toBe(true);

    const [listCmd, listArgs] = mockExec.mock.calls[0];
    expect(listCmd).toBe('glab');
    expect(listArgs).toContain('-R');
    expect(listArgs[listArgs.indexOf('-R') + 1]).toBe(spec);

    const [createCmd, createArgs] = mockExec.mock.calls[1];
    expect(createCmd).toBe('glab');
    expect(createArgs).toContain('-R');
    expect(createArgs[createArgs.indexOf('-R') + 1]).toBe(spec);
  });

  it('resolves the -R spec exactly ONCE per run, reusing it for both the list and create call', async () => {
    const spy = vi.fn(() => 'https://gitlab.example.com/example-group/example-project.git');
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/-/mr/1\n', stderr: '' });

    await maybeCreateDraftMRReal(makeLoop(), { execFile: mockExec, resolveRepoSpecFn: spy });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('still resolves the spec exactly once when the collision check short-circuits (existing MR found)', async () => {
    const spy = vi.fn(() => 'https://gitlab.example.com/example-group/example-project.git');
    const mockExec = makeExistingGlabExec(77, 'https://gitlab.example.com/-/mr/77');

    const result = await maybeCreateDraftMRReal(makeLoop(), {
      execFile: mockExec,
      resolveRepoSpecFn: spy,
    });

    expect(result.existing).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // Only the list call happened (collision short-circuit) — it must still
    // carry -R, proving the spec was resolved BEFORE the collision check.
    const [, listArgs] = mockExec.mock.calls[0];
    expect(listArgs).toContain('-R');
  });

  it('appends no -R at all when resolveRepoSpecFn returns undefined (graceful degradation)', async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/-/mr/1\n', stderr: '' });

    await maybeCreateDraftMRReal(makeLoop(), {
      execFile: mockExec,
      resolveRepoSpecFn: () => undefined,
    });

    for (const [, args] of mockExec.mock.calls) {
      expect(args).not.toContain('-R');
    }
  });
});

describe('maybeCreateDraftMR — #872 host pinning (github)', () => {
  it('pins both the gh pr list AND the gh pr create call to -R <spec>', async () => {
    const spec = 'https://github.example.com/example-org/example-repo.git';
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://github.example.com/example-org/example-repo/pull/9\n', stderr: '' });

    const result = await maybeCreateDraftMRReal(makeLoop({ vcs: 'github' }), {
      execFile: mockExec,
      resolveRepoSpecFn: () => spec,
    });

    expect(result.created).toBe(true);

    const [listCmd, listArgs] = mockExec.mock.calls[0];
    expect(listCmd).toBe('gh');
    expect(listArgs).toContain('-R');
    expect(listArgs[listArgs.indexOf('-R') + 1]).toBe(spec);

    const [createCmd, createArgs] = mockExec.mock.calls[1];
    expect(createCmd).toBe('gh');
    expect(createArgs).toContain('-R');
    expect(createArgs[createArgs.indexOf('-R') + 1]).toBe(spec);
  });
});

// ---------------------------------------------------------------------------
// #872 Gap 3 (QA follow-up, mirrors tests/lib/spiral-carryover.test.mjs's
// "default resolveRepoSpecFn wires the REAL module" block) — every #872 test
// above injects an explicit resolveRepoSpecFn stub, so a mis-wired production
// DEFAULT (e.g. the wrong import, or a default that silently swallows its own
// vcs argument) would pass every test above without detection. These tests
// call the `*Real` functions with resolveRepoSpecFn OMITTED so the production
// default (`resolveRepoSpec`, imported at module top) runs for real — through
// to the mocked `execFileSync('git', ...)` call (see the file-top mock).
// ---------------------------------------------------------------------------

describe('checkExistingMR — default resolveRepoSpecFn wires the REAL module (Gap 3)', () => {
  // execFileSync is a vi.fn() created inside the vi.mock('node:child_process')
  // factory. Per .claude/rules/testing.md's Vitest Mocking Gotchas, mock
  // history for factory-scoped vi.fn()s is not reliably wiped by the file's
  // global `afterEach(() => vi.restoreAllMocks())` — clear it explicitly at
  // the top of every Gap-3 test so `.mock.calls` assertions are call-count
  // exact, not a leak from a sibling test's git-call sequence.
  beforeEach(() => {
    execFileSync.mockClear();
  });

  it('derives the -R spec through the real resolveRepoSpec → git remote get-url chain when resolveRepoSpecFn is omitted', async () => {
    const remoteUrl = 'https://gitlab.example.com/example-group/example-project.git';
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args.at(-1) === 'gitlab') return `${remoteUrl}\n`;
      const err = new Error('fatal: no such remote');
      err.stderr = 'fatal: no such remote';
      throw err;
    });

    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMRReal({ vcs: 'glab', branchName: 'issue-1', execFile: mockExec });

    // The real chain actually shelled out to `git remote get-url` — proof
    // the default parameter is wired to the real module, not a no-op.
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['remote', 'get-url', 'gitlab']),
      expect.anything(),
    );

    const [, args] = mockExec.mock.calls[0];
    expect(args).toContain('-R');
    expect(args[args.indexOf('-R') + 1]).toBe(remoteUrl);
  });

  it('appends no -R at all when the real chain finds no matching remote (graceful degradation, default resolver)', async () => {
    execFileSync.mockImplementation(() => {
      const err = new Error('fatal: no such remote');
      err.stderr = 'fatal: no such remote';
      throw err;
    });

    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await checkExistingMRReal({ vcs: 'glab', branchName: 'issue-1', execFile: mockExec });

    const [, args] = mockExec.mock.calls[0];
    expect(args).not.toContain('-R');
  });
});

describe('maybeCreateDraftMR — default resolveRepoSpecFn wires the REAL module (Gap 3)', () => {
  // See the sibling checkExistingMR Gap-3 describe block above for why this
  // explicit clear is needed (factory-scoped vi.fn() mock-history gotcha).
  beforeEach(() => {
    execFileSync.mockClear();
  });

  it('derives the -R spec through the real resolveRepoSpec chain and pins BOTH the list and create call when resolveRepoSpecFn is omitted', async () => {
    const remoteUrl = 'https://gitlab.example.com/example-group/example-project.git';
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args.at(-1) === 'gitlab') return `${remoteUrl}\n`;
      const err = new Error('fatal: no such remote');
      err.stderr = 'fatal: no such remote';
      throw err;
    });

    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'https://gitlab.example.com/-/mr/1\n', stderr: '' });

    const result = await maybeCreateDraftMRReal(makeLoop(), { execFile: mockExec });

    expect(result.created).toBe(true);

    // Exactly one real `git remote get-url gitlab` spawn — the resolve-once
    // contract holds even through the production default.
    const gitCalls = execFileSync.mock.calls.filter(([cmd]) => cmd === 'git');
    expect(gitCalls).toHaveLength(1);

    const [, listArgs] = mockExec.mock.calls[0];
    expect(listArgs).toContain('-R');
    expect(listArgs[listArgs.indexOf('-R') + 1]).toBe(remoteUrl);

    const [, createArgs] = mockExec.mock.calls[1];
    expect(createArgs).toContain('-R');
    expect(createArgs[createArgs.indexOf('-R') + 1]).toBe(remoteUrl);
  });
});
