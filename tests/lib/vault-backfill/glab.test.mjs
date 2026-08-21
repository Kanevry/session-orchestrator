/**
 * tests/lib/vault-backfill/glab.test.mjs
 *
 * Vitest suite for scripts/lib/vault-backfill/glab.mjs.
 *
 * Covers:
 *   assertGlabExists — glab found → no dieFn call; glab missing → dieFn(1, ...)
 *   glabRun          — success path: argv assertion + return shape; failure: non-zero exit throws-like ok:false
 *   parseRepoList    — project arrays and page arrays; valid [] stays empty; malformed response shapes → null
 *   setVerbose       — verbose=true causes stderr to log via process.stderr.write
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:child_process so spawnSync never shells out
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import {
  assertGlabExists,
  glabRun,
  listGroupRepos,
  parseRepoList,
  setVerbose,
} from '@lib/vault-backfill/glab.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake spawnSync result for a successful invocation. */
function successResult(stdout = '') {
  return { status: 0, stdout, stderr: '', error: null };
}

/** Build a fake spawnSync result for a failed invocation. */
function failResult({ status = 1, stdout = '', stderr = 'something went wrong', error = null } = {}) {
  return { status, stdout, stderr, error };
}

/** Build a fake spawnSync result where the spawn itself errored (e.g. ENOENT). */
function spawnError(message = 'spawn glab ENOENT') {
  return { status: null, stdout: null, stderr: null, error: new Error(message) };
}

// ---------------------------------------------------------------------------
// assertGlabExists
// ---------------------------------------------------------------------------

describe('assertGlabExists', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call dieFn when glab is found on PATH (status 0)', () => {
    spawnSync.mockReturnValue(successResult('glab version 1.45.0'));
    const dieFn = vi.fn();

    assertGlabExists(dieFn);

    expect(dieFn).not.toHaveBeenCalled();
    // Verify glab was called with --version
    expect(spawnSync).toHaveBeenCalledWith('glab', ['--version'], { encoding: 'utf8' });
  });

  it('calls dieFn(1, message) when spawnSync returns a non-zero status', () => {
    spawnSync.mockReturnValue(failResult({ status: 127, stderr: '' }));
    const dieFn = vi.fn();

    assertGlabExists(dieFn);

    expect(dieFn).toHaveBeenCalledOnce();
    const [code, message] = dieFn.mock.calls[0];
    expect(code).toBe(1);
    expect(message).toContain('glab CLI not found');
    expect(message).toContain('brew install glab');
  });

  it('calls dieFn(1, message) when spawnSync itself errors (ENOENT — glab not on PATH)', () => {
    spawnSync.mockReturnValue(spawnError('spawn glab ENOENT'));
    const dieFn = vi.fn();

    assertGlabExists(dieFn);

    expect(dieFn).toHaveBeenCalledOnce();
    const [code] = dieFn.mock.calls[0];
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// glabRun
// ---------------------------------------------------------------------------

describe('glabRun', () => {
  afterEach(() => {
    setVerbose(false);
    vi.restoreAllMocks();
  });

  it('calls spawnSync with the provided glabArgs and the correct options', () => {
    spawnSync.mockReturnValue(successResult('{"id":1}'));
    const args = ['api', 'projects/42'];

    glabRun(args);

    expect(spawnSync).toHaveBeenCalledWith('glab', args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  });

  it('returns { ok: true, stdout, stderr } when glab exits with status 0', () => {
    const fakeStdout = 'some output';
    spawnSync.mockReturnValue(successResult(fakeStdout));

    const result = glabRun(['repo', 'list']);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(fakeStdout);
    expect(result.stderr).toBe('');
  });

  it('returns { ok: false } when glab exits with non-zero status', () => {
    spawnSync.mockReturnValue(failResult({ status: 1, stderr: 'error: unauthorized', stdout: '' }));

    const result = glabRun(['api', 'projects/secret']);

    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('error: unauthorized');
    expect(result.stdout).toBe('');
  });

  it('returns { ok: false } and includes the error message when spawnSync itself errors', () => {
    const errMsg = 'spawn glab ENOENT';
    spawnSync.mockReturnValue(spawnError(errMsg));

    const result = glabRun(['repo', 'list']);

    expect(result.ok).toBe(false);
    expect(result.stderr).toBe(errMsg);
    expect(result.stdout).toBe('');
  });

  it('logs the command argv to process.stderr when verbose mode is enabled', () => {
    spawnSync.mockReturnValue(successResult(''));
    setVerbose(true);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    glabRun(['repo', 'list', '-g', 'mygroup']);

    expect(writeSpy).toHaveBeenCalledWith('[vault-backfill:verbose] glab repo list -g mygroup\n');

    // Reset verbose to avoid polluting other tests
    setVerbose(false);
  });

  it('does not log a raw project object returned on stdout in verbose mode', () => {
    const rawProject = JSON.stringify({
      path_with_namespace: 'platform/secret-project',
      private_token: 'project-object-secret',
    });
    spawnSync.mockReturnValue(successResult(rawProject));
    setVerbose(true);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = glabRun(['api', 'groups/platform/projects?simple=true&per_page=100']);

    expect(result.stdout).toBe(rawProject);
    expect(writeSpy).toHaveBeenCalledWith(
      '[vault-backfill:verbose] glab api groups/platform/projects?simple=true&per_page=100\n',
    );
    setVerbose(false);
  });

  it('redacts URL userinfo in verbose argv and normalized glab errors', () => {
    spawnSync.mockReturnValue(failResult({
      stderr: 'request to https://gitlab-ci-token:super-secret@example.test/api failed',
    }));
    setVerbose(true);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = glabRun(['api', 'https://gitlab-ci-token:super-secret@example.test/api']);

    expect(writeSpy).toHaveBeenCalledWith(
      '[vault-backfill:verbose] glab api https://***@example.test/api\n',
    );
    expect(result).toEqual({
      ok: false,
      stdout: '',
      stderr: 'request to https://***@example.test/api failed',
    });
    setVerbose(false);
  });
});

// ---------------------------------------------------------------------------
// listGroupRepos
// ---------------------------------------------------------------------------

describe('listGroupRepos', () => {
  beforeEach(() => {
    spawnSync.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the simple paginated group endpoint without a project-detail request', () => {
    spawnSync.mockReturnValue(successResult(JSON.stringify([[
      {
        id: 99,
        path_with_namespace: 'platform/observability/collector',
        name: 'collector',
        visibility: 'internal',
        created_at: '2026-06-15T08:00:00Z',
        namespace: { full_path: 'platform/observability' },
        private_token: 'must-not-escape-the-normalized-representation',
      },
    ]])));

    const repos = listGroupRepos('platform/observability');

    expect(spawnSync).toHaveBeenCalledWith('glab', [
      'api',
      'groups/platform%2Fobservability/projects?simple=true&per_page=100',
      '--paginate',
      '--slurp',
    ], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(repos).toEqual([{
      id: 99,
      path: 'platform/observability/collector',
      visibility: 'internal',
      createdAt: '2026-06-15',
    }]);
  });

  it('returns null and emits a bounded diagnostic for an exit-zero non-list response', () => {
    const rawResponse = JSON.stringify({
      message: 'upstream failure',
      private_token: 'must-not-escape-the-shape-diagnostic',
    });
    spawnSync.mockReturnValue(successResult(rawResponse));
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const repos = listGroupRepos('platform/observability');

    expect(repos).toBeNull();
    expect(writeSpy).toHaveBeenCalledWith(
      "[vault-backfill] WARN: glab api groups/<group>/projects returned an unexpected project-list response shape for group 'platform/observability'\n",
    );
    expect(writeSpy).not.toHaveBeenCalledWith(expect.stringContaining('must-not-escape-the-shape-diagnostic'));
  });
});

// ---------------------------------------------------------------------------
// parseRepoList
// ---------------------------------------------------------------------------

describe('parseRepoList', () => {
  it.each(['', '   \n  '])('returns null for blank output %j', (input) => {
    expect(parseRepoList(input)).toBeNull();
  });

  it('preserves id with path, visibility, and date while dropping response extras', () => {
    const input = JSON.stringify([
      {
        id: 42,
        path_with_namespace: 'group/my-repo',
        name: 'my-repo',
        visibility: 'private',
        created_at: '2026-01-15T08:00:00Z',
        namespace: { full_path: 'group' },
        web_url: 'https://gitlab.example.test/group/my-repo',
        private_token: 'must-not-escape-the-normalized-representation',
      },
    ]);

    const result = parseRepoList(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 42,
      path: 'group/my-repo',
      visibility: 'private',
      createdAt: '2026-01-15',
    });
  });

  it('distinguishes a valid empty project list from invalid exit-zero response shapes', () => {
    expect(parseRepoList('[]')).toEqual([]);
  });

  it.each([
    ['a single project segment', 'project'],
    ['a leading separator', '/group/project'],
    ['a trailing separator', 'group/project/'],
    ['an empty nested segment', 'group//project'],
    ['a dot segment', 'group/./project'],
    ['a traversal segment', 'group/../project'],
    ['a backslash', 'group\\project'],
    ['whitespace', 'group/repo name'],
    ['a URI query delimiter', 'group/repo?query'],
    ['a URI escape delimiter', 'group/repo%2Fother'],
    ['a colon delimiter', 'group/repo:tag'],
    ['a control character', 'group/repo\nother'],
  ])('rejects %s in GitLab project output', (_description, pathWithNamespace) => {
    const result = parseRepoList(JSON.stringify([{
      id: 1065,
      path_with_namespace: pathWithNamespace,
      visibility: 'private',
      created_at: '2026-08-21T00:00:00Z',
    }]));

    expect(result).toBeNull();
  });

  it('preserves valid nested GitLab namespace paths and standard slug characters', () => {
    const result = parseRepoList(JSON.stringify([{
      id: 1065,
      path_with_namespace: 'platform_1/observability.v2/collector-rc.1',
      visibility: 'private',
      created_at: '2026-08-21T00:00:00Z',
    }]));

    expect(result).toEqual([{
      id: 1065,
      path: 'platform_1/observability.v2/collector-rc.1',
      visibility: 'private',
      createdAt: '2026-08-21',
    }]);
  });

  // Regression: a malformed projected field used to either throw during
  // normalization or leak an unvalidated value into the downstream manifest.
  it.each([
    ['a numeric created_at', { created_at: 42 }],
    ['a null created_at', { created_at: null }],
    ['a date-only created_at', { created_at: '2026-06-15' }],
    ['a nonexistent calendar date', { created_at: '2026-02-30T08:00:00Z' }],
    ['a numeric visibility', { visibility: 42 }],
  ])('fails the complete response closed for %s', (_description, malformedFields) => {
    const validProject = {
      id: 1,
      path_with_namespace: 'group/valid-repo',
      visibility: 'private',
      created_at: '2026-06-15T08:00:00Z',
    };
    const malformedProject = {
      ...validProject,
      id: 2,
      path_with_namespace: 'group/malformed-repo',
      ...malformedFields,
    };

    expect(parseRepoList(JSON.stringify([[validProject, malformedProject]]))).toBeNull();
  });

  it.each([
    ['a top-level object', JSON.stringify({ message: 'upstream failure' })],
    ['a malformed page list', JSON.stringify([
      [{ id: 1, path_with_namespace: 'group/repo-one' }],
      { message: 'not a page' },
    ])],
    ['a page containing a non-project envelope', JSON.stringify([[
      { id: 1, path_with_namespace: 'group/repo-one' },
      { message: 'not a project' },
    ]])],
    ['a project object without an id', JSON.stringify([{ path_with_namespace: 'group/repo-one' }])],
    ['JSONL, which is not emitted by the --slurp production call', [
      JSON.stringify({ id: 1, path_with_namespace: 'group/repo-one' }),
      JSON.stringify({ id: 2, path_with_namespace: 'group/repo-two' }),
    ].join('\n')],
  ])('returns null for %s', (_description, stdout) => {
    expect(parseRepoList(stdout)).toBeNull();
  });
});
