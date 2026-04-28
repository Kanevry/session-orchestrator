/**
 * tests/lib/issue-close-strip-labels.test.mjs
 *
 * Unit tests for scripts/lib/issue-close-strip-labels.mjs (#308).
 *
 * Isolation strategy:
 *   - `node:child_process` is mocked at the module level via vi.mock so no
 *     real glab/gh CLI calls are ever made.
 *   - Each test configures per-call behavior via `setCliResponses()`.
 *   - The mock is applied before module import; all `execFileSync` calls
 *     in the module under test route through the configured mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:child_process BEFORE importing the module under test.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    throw new Error(
      'issue-close-strip-labels test: execFileSync called without a per-test mock. ' +
        'This would shell out to a real CLI — failing fast.',
    );
  }),
}));

const { execFileSync } = await import('node:child_process');
const { stripStatusLabels } = await import('../../scripts/lib/issue-close-strip-labels.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cliError(stderr = 'boom', stdout = '', status = 1) {
  const err = new Error(`Command failed: ${stderr}`);
  err.stderr = stderr;
  err.stdout = stdout;
  err.status = status;
  return err;
}

/**
 * Set up sequenced per-call responses for `execFileSync`.
 * Each element is either { ok, stdout, stderr } or a function(cmd, args, callIndex).
 *
 * @param {Array<{ok: boolean, stdout?: string, stderr?: string}>} responses
 */
function setCliResponses(responses) {
  let i = 0;
  execFileSync.mockImplementation((cmd, args) => {
    const spec = typeof responses === 'function' ? responses(cmd, args, i++) : responses[i++];
    if (!spec) {
      throw new Error(
        `issue-close-strip-labels test: unexpected extra execFileSync call #${i} ` +
          `(${cmd} ${(args || []).join(' ')})`,
      );
    }
    if (spec.ok === false) {
      throw cliError(spec.stderr ?? 'cli failure', spec.stdout ?? '', spec.status ?? 1);
    }
    return spec.stdout ?? '';
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  execFileSync.mockImplementation(() => {
    throw new Error('issue-close-strip-labels test: no per-test mock configured');
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GitLab path
// ---------------------------------------------------------------------------

describe('stripStatusLabels (gitlab)', () => {
  it('strips a single status:* label and returns its name', async () => {
    const glabViewJson = JSON.stringify({
      iid: 42,
      labels: ['status:in-progress', 'priority:high'],
    });

    setCliResponses([
      { ok: true, stdout: glabViewJson },  // glab issue view
      { ok: true, stdout: '' },             // glab issue update --unlabel
    ]);

    const result = await stripStatusLabels({ issueId: 42, vcs: 'gitlab' });

    expect(result).toEqual({ stripped: ['status:in-progress'] });

    // Verify the first call is `glab issue view <id> --output json`
    const [viewCmd, viewArgs] = execFileSync.mock.calls[0];
    expect(viewCmd).toBe('glab');
    expect(viewArgs).toEqual(['issue', 'view', '42', '--output', 'json']);

    // Verify the second call is `glab issue update <id> --unlabel <labels>`
    const [updateCmd, updateArgs] = execFileSync.mock.calls[1];
    expect(updateCmd).toBe('glab');
    expect(updateArgs[0]).toBe('issue');
    expect(updateArgs[1]).toBe('update');
    expect(updateArgs[2]).toBe('42');
    expect(updateArgs).toContain('--unlabel');
    const unlabelIdx = updateArgs.indexOf('--unlabel');
    expect(updateArgs[unlabelIdx + 1]).toBe('status:in-progress');
  });

  it('strips multiple status:* labels in one call, leaving non-status labels intact', async () => {
    const glabViewJson = JSON.stringify({
      iid: 7,
      labels: ['status:ready', 'status:in-progress', 'priority:medium', 'area:backend'],
    });

    setCliResponses([
      { ok: true, stdout: glabViewJson },
      { ok: true, stdout: '' },
    ]);

    const result = await stripStatusLabels({ issueId: 7, vcs: 'gitlab' });

    // Both status:* labels stripped; non-status labels not in the result
    expect(result.stripped).toHaveLength(2);
    expect(result.stripped).toContain('status:ready');
    expect(result.stripped).toContain('status:in-progress');
    expect(result.error).toBeUndefined();

    // --unlabel value must include both labels as comma-separated string
    const updateArgs = execFileSync.mock.calls[1][1];
    const unlabelIdx = updateArgs.indexOf('--unlabel');
    const unlabelValue = updateArgs[unlabelIdx + 1];
    expect(unlabelValue).toContain('status:ready');
    expect(unlabelValue).toContain('status:in-progress');
    // Non-status labels must NOT appear in the unlabel call
    expect(unlabelValue).not.toContain('priority:medium');
    expect(unlabelValue).not.toContain('area:backend');
  });

  it('is a no-op when issue has no status:* labels (only one CLI call — fetch)', async () => {
    const glabViewJson = JSON.stringify({
      iid: 5,
      labels: ['priority:high', 'type:enhancement'],
    });

    setCliResponses([{ ok: true, stdout: glabViewJson }]);

    const result = await stripStatusLabels({ issueId: 5, vcs: 'gitlab' });

    expect(result).toEqual({ stripped: [] });
    expect(result.error).toBeUndefined();
    // Only the view call; no update call
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when issue has an empty labels array', async () => {
    setCliResponses([{ ok: true, stdout: JSON.stringify({ iid: 1, labels: [] }) }]);

    const result = await stripStatusLabels({ issueId: 1, vcs: 'gitlab' });

    expect(result).toEqual({ stripped: [] });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GitHub path
// ---------------------------------------------------------------------------

describe('stripStatusLabels (github)', () => {
  it('strips a status:* label via gh issue edit --remove-label', async () => {
    const ghViewJson = JSON.stringify({
      labels: [{ name: 'status:ready' }, { name: 'priority:high' }],
    });

    setCliResponses([
      { ok: true, stdout: ghViewJson },  // gh issue view --json labels
      { ok: true, stdout: '' },           // gh issue edit --remove-label
    ]);

    const result = await stripStatusLabels({ issueId: 99, vcs: 'github' });

    expect(result).toEqual({ stripped: ['status:ready'] });

    // Verify view call
    const [viewCmd, viewArgs] = execFileSync.mock.calls[0];
    expect(viewCmd).toBe('gh');
    expect(viewArgs).toEqual(['issue', 'view', '99', '--json', 'labels']);

    // Verify edit call uses --remove-label (not --unlabel)
    const [editCmd, editArgs] = execFileSync.mock.calls[1];
    expect(editCmd).toBe('gh');
    expect(editArgs[0]).toBe('issue');
    expect(editArgs[1]).toBe('edit');
    expect(editArgs[2]).toBe('99');
    expect(editArgs).toContain('--remove-label');
    const removeIdx = editArgs.indexOf('--remove-label');
    expect(editArgs[removeIdx + 1]).toBe('status:ready');
  });

  it('is a no-op on github when no status:* labels present', async () => {
    const ghViewJson = JSON.stringify({
      labels: [{ name: 'priority:low' }],
    });

    setCliResponses([{ ok: true, stdout: ghViewJson }]);

    const result = await stripStatusLabels({ issueId: 10, vcs: 'github' });

    expect(result).toEqual({ stripped: [] });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Error handling — fail-open contract
// ---------------------------------------------------------------------------

describe('stripStatusLabels — error handling', () => {
  it('returns error string (not throw) when glab view call fails', async () => {
    setCliResponses([{ ok: false, stderr: 'glab: not authenticated' }]);

    const result = await stripStatusLabels({ issueId: 3, vcs: 'gitlab' });

    expect(result.stripped).toEqual([]);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('not authenticated');
    // No update call attempted
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('returns error string when glab update (unlabel) call fails', async () => {
    const glabViewJson = JSON.stringify({ iid: 3, labels: ['status:blocked'] });

    setCliResponses([
      { ok: true, stdout: glabViewJson },
      { ok: false, stderr: 'glab: project not found' },
    ]);

    const result = await stripStatusLabels({ issueId: 3, vcs: 'gitlab' });

    expect(result.stripped).toEqual([]);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('project not found');
  });

  it('returns error string when issueId is missing or invalid (no CLI call)', async () => {
    const r1 = await stripStatusLabels({ vcs: 'gitlab' });
    const r2 = await stripStatusLabels({ issueId: null, vcs: 'gitlab' });
    const r3 = await stripStatusLabels({ issueId: '', vcs: 'gitlab' });

    for (const r of [r1, r2, r3]) {
      expect(r.stripped).toEqual([]);
      expect(typeof r.error).toBe('string');
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('returns error string when glab view returns invalid JSON (no update call)', async () => {
    setCliResponses([{ ok: true, stdout: '<<not valid json>>' }]);

    const result = await stripStatusLabels({ issueId: 8, vcs: 'gitlab' });

    expect(result.stripped).toEqual([]);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('JSON parse failed');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
