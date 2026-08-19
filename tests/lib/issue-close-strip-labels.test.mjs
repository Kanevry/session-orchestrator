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
const { stripStatusLabels: stripStatusLabelsReal } = await import('@lib/issue-close-strip-labels.mjs');

// ---------------------------------------------------------------------------
// #839 host-pinning shim
//
// stripStatusLabels() now resolves a `-R`/`--repo` spec via an injectable
// `resolveRepoSpecFn` (default: the real `resolveRepoSpec`, which shells out
// to `git remote -v`). Every pre-#839 test below is unaware of this and
// asserts an EXACT execFileSync call sequence (count + args) for just the
// glab/gh calls — so this local wrapper injects a no-op resolver
// (`() => undefined`, matching pre-#839 "no -R appended" behaviour) as the
// DEFAULT, keeping every unmodified test's call sequence byte-for-byte
// identical. Tests that specifically exercise #839 host-pinning call
// `stripStatusLabelsReal` directly (bypassing this shim) with an explicit
// resolveRepoSpecFn override or the real default.
// ---------------------------------------------------------------------------
function stripStatusLabels(opts) {
  return stripStatusLabelsReal({ resolveRepoSpecFn: () => undefined, ...opts });
}

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
  it('strips a single status:* label, returns its name, and pins both calls to the resolved -R spec (#839)', async () => {
    const glabViewJson = JSON.stringify({
      iid: 42,
      labels: ['status:in-progress', 'priority:high'],
    });
    const spec = 'https://gitlab.example.com/group/session-orchestrator.git';

    setCliResponses([
      { ok: true, stdout: glabViewJson },  // glab issue view
      { ok: true, stdout: '' },             // glab issue update --unlabel
    ]);

    // Bypass the no-op shim: inject a resolvable spec so the -R host-pinning
    // args are exercised directly (#839).
    const result = await stripStatusLabelsReal({
      issueId: 42,
      vcs: 'gitlab',
      resolveRepoSpecFn: () => spec,
    });

    expect(result).toEqual({ stripped: ['status:in-progress'] });

    // Verify the first call is `glab issue view <id> --output json -R <spec>`
    const [viewCmd, viewArgs] = execFileSync.mock.calls[0];
    expect(viewCmd).toBe('glab');
    expect(viewArgs).toEqual(['issue', 'view', '42', '--output', 'json', '-R', spec]);

    // Verify the second call is `glab issue update <id> --unlabel <labels> -R <spec>`
    const [updateCmd, updateArgs] = execFileSync.mock.calls[1];
    expect(updateCmd).toBe('glab');
    expect(updateArgs[0]).toBe('issue');
    expect(updateArgs[1]).toBe('update');
    expect(updateArgs[2]).toBe('42');
    expect(updateArgs).toContain('--unlabel');
    const unlabelIdx = updateArgs.indexOf('--unlabel');
    expect(updateArgs[unlabelIdx + 1]).toBe('status:in-progress');
    // -R must be present on the write (update) call too — not just the read.
    expect(updateArgs).toEqual(['issue', 'update', '42', '--unlabel', 'status:in-progress', '-R', spec]);
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
  it('strips a status:* label via gh issue edit --remove-label, pinning both calls to -R (#839)', async () => {
    const ghViewJson = JSON.stringify({
      labels: [{ name: 'status:ready' }, { name: 'priority:high' }],
    });
    const spec = 'https://github.com/org/repo.git';

    setCliResponses([
      { ok: true, stdout: ghViewJson },  // gh issue view --json labels
      { ok: true, stdout: '' },           // gh issue edit --remove-label
    ]);

    // Bypass the no-op shim: inject a resolvable spec so the -R host-pinning
    // args are exercised directly (#839).
    const result = await stripStatusLabelsReal({
      issueId: 99,
      vcs: 'github',
      resolveRepoSpecFn: () => spec,
    });

    expect(result).toEqual({ stripped: ['status:ready'] });

    // Verify view call
    const [viewCmd, viewArgs] = execFileSync.mock.calls[0];
    expect(viewCmd).toBe('gh');
    expect(viewArgs).toEqual(['issue', 'view', '99', '--json', 'labels', '-R', spec]);

    // Verify edit call uses --remove-label (not --unlabel)
    const [editCmd, editArgs] = execFileSync.mock.calls[1];
    expect(editCmd).toBe('gh');
    expect(editArgs[0]).toBe('issue');
    expect(editArgs[1]).toBe('edit');
    expect(editArgs[2]).toBe('99');
    expect(editArgs).toContain('--remove-label');
    const removeIdx = editArgs.indexOf('--remove-label');
    expect(editArgs[removeIdx + 1]).toBe('status:ready');
    // -R must be present on the write (edit) call too — not just the read.
    expect(editArgs).toEqual(['issue', 'edit', '99', '--remove-label', 'status:ready', '-R', spec]);
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

// ---------------------------------------------------------------------------
// #839 — host-pinning regression + graceful degradation
//
// These tests exercise stripStatusLabelsReal directly (bypassing the no-op
// shim above) so the REAL default resolveRepoSpecFn (`resolveRepoSpec`,
// which shells out to `git remote -v`) runs. execFileSync therefore
// receives BOTH `git` and `glab`/`gh` calls in this section — distinguished
// by `cmd`, not by call order.
// ---------------------------------------------------------------------------

describe('stripStatusLabels — #839 wrong-host regression (RED-before/GREEN-after)', () => {
  const REAL_GITLAB_HOST = process.env.GITLAB_HOST;

  beforeEach(() => {
    // Simulate the live-verified failure mode: ambient GITLAB_HOST points at
    // a DIFFERENT GitLab instance than this repo's remotes.
    process.env.GITLAB_HOST = 'wrong.example.com';
  });

  afterEach(() => {
    if (REAL_GITLAB_HOST === undefined) delete process.env.GITLAB_HOST;
    else process.env.GITLAB_HOST = REAL_GITLAB_HOST;
  });

  it('strips status labels correctly even when GITLAB_HOST points at the wrong instance', async () => {
    const glabViewJson = JSON.stringify({ iid: 839, labels: ['status:in-progress', 'priority:high'] });

    execFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args.includes('remote') && args.includes('-v')) {
        // Real `git remote -v` — resolves this repo's actual remote,
        // independent of the (wrong) ambient GITLAB_HOST. Fictional host/path
        // (never the operator's real GitLab instance — #494 owner-leakage).
        // Shape is the #1039 protocol: ONE `git remote -v` call whose stdout
        // is `<name>\t<url> (fetch|push)` lines, not a bare url from one
        // `git remote get-url <name>` call per preference entry.
        const url = 'https://gitlab.example.com/example-group/example-project.git';
        return `gitlab\t${url} (fetch)\ngitlab\t${url} (push)\n`;
      }
      if (cmd === 'glab') {
        // Simulate real glab: WITHOUT -R/--repo it fails, honoring the wrong
        // ambient GITLAB_HOST — this mirrors the SHAPE of the error observed
        // live (#839), with fictional host/IP substituted (#494 owner-leakage).
        const hasRepoFlag = args.includes('-R') || args.includes('--repo');
        if (!hasRepoFlag) {
          throw cliError(
            [
              ' ERROR',
              ' Could not determine base repository: none of the git remotes configured for this repository correspond to the',
              ' GITLAB_HOST environment variable.',
              ' GITLAB_HOST is currently set to wrong.example.com',
              ' Configured remotes: 192.0.2.10, github.com.',
            ].join('\n'),
          );
        }
        if (args.includes('view')) return glabViewJson;
        if (args.includes('update')) return '';
      }
      throw new Error(`stripStatusLabels #839 test: unexpected cmd (${cmd} ${(args || []).join(' ')})`);
    });

    const result = await stripStatusLabelsReal({ issueId: 839, vcs: 'gitlab' });

    expect(result.stripped).toEqual(['status:in-progress']);
    expect(result.error).toBeUndefined();
  });
});

describe('stripStatusLabels — #839 graceful degradation (no remote resolves)', () => {
  it('appends no -R flag and behaves exactly as before #839 when git remote resolution fails entirely', async () => {
    const glabViewJson = JSON.stringify({ iid: 12, labels: ['status:ready'] });

    execFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'git') {
        throw cliError('fatal: no such remote');
      }
      if (cmd === 'glab') {
        if (args.includes('view')) return glabViewJson;
        if (args.includes('update')) return '';
      }
      throw new Error(`stripStatusLabels #839 test: unexpected cmd (${cmd} ${(args || []).join(' ')})`);
    });

    const result = await stripStatusLabelsReal({ issueId: 12, vcs: 'gitlab' });

    expect(result).toEqual({ stripped: ['status:ready'] });

    const glabCalls = execFileSync.mock.calls.filter(([cmd]) => cmd === 'glab');
    expect(glabCalls).toHaveLength(2);
    for (const [, args] of glabCalls) {
      expect(args).not.toContain('-R');
      expect(args).not.toContain('--repo');
    }
  });
});
