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

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MrDraftError,
  validateMrInputs,
  checkExistingMR,
  buildMrBody,
  maybeCreateDraftMR,
} from '../../../scripts/lib/autopilot/mr-draft.mjs';

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
