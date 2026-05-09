/**
 * tests/lib/vault-backfill/glab.test.mjs
 *
 * Vitest suite for scripts/lib/vault-backfill/glab.mjs.
 *
 * Covers:
 *   assertGlabExists — glab found → no dieFn call; glab missing → dieFn(1, ...)
 *   glabRun          — success path: argv assertion + return shape; failure: non-zero exit throws-like ok:false
 *   parseRepoList    — JSON array; JSONL multi-line; empty input → []; malformed JSON → [] (skipped per JSONL path)
 *   setVerbose       — verbose=true causes stderr to log via process.stderr.write
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

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
  parseRepoList,
  setVerbose,
} from '../../../scripts/lib/vault-backfill/glab.mjs';

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

  it('logs to process.stderr when verbose mode is enabled', () => {
    spawnSync.mockReturnValue(successResult(''));
    setVerbose(true);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    glabRun(['repo', 'list', '-g', 'mygroup']);

    expect(writeSpy).toHaveBeenCalled();
    const loggedText = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(loggedText).toContain('repo list -g mygroup');

    // Reset verbose to avoid polluting other tests
    setVerbose(false);
  });
});

// ---------------------------------------------------------------------------
// parseRepoList
// ---------------------------------------------------------------------------

describe('parseRepoList', () => {
  it('returns an empty array for empty input', () => {
    expect(parseRepoList('')).toEqual([]);
  });

  it('returns an empty array for whitespace-only input', () => {
    expect(parseRepoList('   \n  ')).toEqual([]);
  });

  it('parses a JSON array of repos into the expected shape', () => {
    const input = JSON.stringify([
      {
        id: 42,
        path_with_namespace: 'group/my-repo',
        name: 'my-repo',
        visibility: 'private',
        created_at: '2026-01-15T08:00:00Z',
      },
    ]);

    const result = parseRepoList(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 42,
      path: 'group/my-repo',
      name: 'my-repo',
      visibility: 'private',
      createdAt: '2026-01-15',
    });
  });

  it('parses JSONL (one JSON object per line) into a repo array', () => {
    const line1 = JSON.stringify({
      id: 1,
      path_with_namespace: 'group/repo-one',
      name: 'repo-one',
      visibility: 'public',
      created_at: '2026-02-01T00:00:00Z',
    });
    const line2 = JSON.stringify({
      id: 2,
      path_with_namespace: 'group/repo-two',
      name: 'repo-two',
      visibility: 'internal',
      created_at: '2026-03-10T12:00:00Z',
    });
    const input = `${line1}\n${line2}`;

    // JSON.parse of JSONL fails → fallback to line-by-line parsing
    const result = parseRepoList(input);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[0].path).toBe('group/repo-one');
    expect(result[1].id).toBe(2);
    expect(result[1].createdAt).toBe('2026-03-10');
  });

  it('skips malformed JSONL lines and returns only parseable entries', () => {
    const goodLine = JSON.stringify({ id: 99, name: 'ok-repo', visibility: 'private', created_at: '' });
    const input = `not-valid-json\n${goodLine}\nalso-bad`;

    const result = parseRepoList(input);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(99);
  });

  it('returns an empty array when the JSON value is not an array', () => {
    // JSON object instead of array → treated as invalid
    const result = parseRepoList(JSON.stringify({ id: 1, name: 'foo' }));
    expect(result).toEqual([]);
  });

  it('applies defaults for missing fields (id→0, visibility→private, createdAt→empty)', () => {
    const input = JSON.stringify([{ name: 'minimal' }]);

    const result = parseRepoList(input);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(0);
    expect(result[0].path).toBe('');
    expect(result[0].visibility).toBe('private');
    expect(result[0].createdAt).toBe('');
  });
});
