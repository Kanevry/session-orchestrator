/**
 * tests/lib/fetch-baseline.test.mjs
 *
 * Vitest tests for scripts/lib/fetch-baseline.mjs
 * Imports the module directly; all HTTP is mocked via vi.spyOn(globalThis, 'fetch').
 * No live network requests. Cache isolated to os.tmpdir() per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { fetchBaselineFile } from '../../scripts/lib/fetch-baseline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const FETCH_BASELINE_MJS = join(REPO_ROOT, 'scripts/lib/fetch-baseline.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Response-like object that globalThis.fetch returns.
 */
function makeFetchResponse({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body ?? ''),
  };
}

/**
 * Derive the cache key the module uses (mirrors _cacheKey in the module).
 * Used to pre-populate or assert paths without duplicating logic.
 *
 * Cache key: `${projectId}-${ref}-${filePath}` with /. replaced by _
 */
function cacheKey(projectId, ref, filePath) {
  return `${projectId}-${ref}-${filePath}`.replace(/[/.]/g, '_');
}

// ---------------------------------------------------------------------------
// Per-test setup: isolated tmp dir, BASELINE_CACHE_DIR override, fetch spy
// ---------------------------------------------------------------------------

let tmpBase;
let cacheDir;
let fetchSpy;
let stderrSpy;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'fetch-baseline-test-'));
  cacheDir = join(tmpBase, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  process.env.BASELINE_CACHE_DIR = cacheDir;

  fetchSpy = vi.spyOn(globalThis, 'fetch');
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BASELINE_CACHE_DIR;
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// 1. Happy path 200
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — 200 OK', () => {
  it('returns ok:true with body and status 200 when fetch succeeds', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: 'file body content' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.ok).toBe(true);
    expect(result.body).toBe('file body content');
    expect(result.status).toBe(200);
  });

  it('sets fromCache to false on a network 200 hit', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: 'content' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    // The module does not set fromCache on 200 — it is absent (falsy), not explicitly false.
    // Assert it is not truthy (no cache hit).
    expect(result.fromCache).toBeFalsy();
  });

  it('writes the response body to the cache file after a 200', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: 'cached content' }));

    await fetchBaselineFile({
      filePath: 'rules/testing.md',
      token: 'test-token',
      projectId: '99',
      baselineRef: 'main',
    });

    // Cache file must exist with the right content
    const key = cacheKey('99', 'main', 'rules/testing.md');
    const cacheFile = join(cacheDir, key);
    const { readFileSync } = await import('node:fs');
    const written = readFileSync(cacheFile, 'utf8');
    expect(written).toBe('cached content');
  });
});

// ---------------------------------------------------------------------------
// 2. 404 with cache hit
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — 404 with cache hit', () => {
  it('returns ok:true with cached body when fetch 404s and cache is present', async () => {
    const key = cacheKey('52', 'main', '.claude/rules/security.md');
    writeFileSync(join(cacheDir, key), 'cached fallback', 'utf8');

    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 404, body: '' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.ok).toBe(true);
    expect(result.body).toBe('cached fallback');
    expect(result.fromCache).toBe(true);
  });

  it('emits a WARNING to stderr when falling back to cache on 404', async () => {
    const key = cacheKey('52', 'main', '.claude/rules/security.md');
    writeFileSync(join(cacheDir, key), 'cached fallback', 'utf8');

    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 404, body: '' }));

    await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderrOutput).toMatch(/WARNING/);
    expect(stderrOutput).toMatch(/cache/i);
  });
});

// ---------------------------------------------------------------------------
// 3. 404 without cache
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — 404 without cache', () => {
  it('returns ok:false with status 404 when fetch 404s and no cache', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 404, body: '' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/missing.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });

  it('includes a descriptive error message for 404 with no cache', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 404, body: '' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/missing.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    // Must mention the file or "not found" concept
    expect(result.error).toMatch(/not found|missing\.md/i);
  });
});

// ---------------------------------------------------------------------------
// 4. 401 NEVER falls back to cache
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — 401 auth failure', () => {
  it('returns ok:false even when cache is present', async () => {
    const key = cacheKey('52', 'main', '.claude/rules/security.md');
    writeFileSync(join(cacheDir, key), 'cached content', 'utf8');

    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 401, body: '' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('does not set fromCache on a 401 response', async () => {
    const key = cacheKey('52', 'main', '.claude/rules/security.md');
    writeFileSync(join(cacheDir, key), 'cached content', 'utf8');

    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 401, body: '' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.fromCache).toBeFalsy();
  });

  it('error message mentions auth or GITLAB_TOKEN on 401', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 401, body: '' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.error).toMatch(/auth|GITLAB_TOKEN/i);
  });
});

// ---------------------------------------------------------------------------
// 5. 403 NEVER falls back to cache
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — 403 forbidden', () => {
  it('returns ok:false even when cache is present', async () => {
    const key = cacheKey('52', 'main', '.claude/rules/security.md');
    writeFileSync(join(cacheDir, key), 'cached content', 'utf8');

    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 403, body: '' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.fromCache).toBeFalsy();
  });

  it('error message mentions auth or 403 on 403', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 403, body: '' }));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.error).toMatch(/auth|403/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Transport error with cache hit
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — transport error with cache hit', () => {
  it('returns ok:true with cached body when fetch rejects and cache exists', async () => {
    const key = cacheKey('52', 'main', '.claude/rules/security.md');
    writeFileSync(join(cacheDir, key), 'offline cached body', 'utf8');

    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.ok).toBe(true);
    expect(result.body).toBe('offline cached body');
    expect(result.fromCache).toBe(true);
  });

  it('emits a WARNING to stderr on transport error cache fallback', async () => {
    const key = cacheKey('52', 'main', '.claude/rules/security.md');
    writeFileSync(join(cacheDir, key), 'offline cached body', 'utf8');

    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderrOutput).toMatch(/WARNING/);
  });
});

// ---------------------------------------------------------------------------
// 7. Transport error without cache
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — transport error without cache', () => {
  it('returns ok:false when fetch rejects and no cache exists', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(result.ok).toBe(false);
  });

  it('error field contains the transport error message', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(typeof result.error).toBe('string');
    expect(result.error).toMatch(/ETIMEDOUT/);
  });
});

// ---------------------------------------------------------------------------
// 8. PRIVATE-TOKEN header sent
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — request headers', () => {
  it('sends PRIVATE-TOKEN header with the provided token', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: 'ok' }));

    await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'my-secret-token',
      projectId: '52',
      baselineRef: 'main',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, fetchOptions] = fetchSpy.mock.calls[0];
    expect(fetchOptions.headers['PRIVATE-TOKEN']).toBe('my-secret-token');
  });
});

// ---------------------------------------------------------------------------
// 9. Cache-key encoding
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — cache key encoding', () => {
  it('cache file path encodes slashes and dots in filePath as underscores', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: 'content' }));

    await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
    });

    // Expected key: 52-main-_claude_rules_security_md  (all /. → _)
    // Slashes in filePath: .claude/rules/security.md
    // '.' → '_', '/' → '_'
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    // Key must start with projectId-ref and contain no literal slashes or dots from the path segment
    expect(files[0]).toMatch(/^52-main-/);
    expect(files[0]).not.toContain('/');
    expect(files[0]).not.toContain('.');
  });

  it('two calls with different projectIds produce different cache files', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeFetchResponse({ status: 200, body: 'proj-a' }))
      .mockResolvedValueOnce(makeFetchResponse({ status: 200, body: 'proj-b' }));

    await fetchBaselineFile({ filePath: 'rules/dev.md', token: 'tok', projectId: '10', baselineRef: 'main' });
    await fetchBaselineFile({ filePath: 'rules/dev.md', token: 'tok', projectId: '20', baselineRef: 'main' });

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(cacheDir);
    expect(files).toHaveLength(2);
    const keyA = cacheKey('10', 'main', 'rules/dev.md');
    const keyB = cacheKey('20', 'main', 'rules/dev.md');
    expect(files).toContain(keyA);
    expect(files).toContain(keyB);
  });
});

// ---------------------------------------------------------------------------
// 10. timeoutMs honored via AbortController
// ---------------------------------------------------------------------------

describe('fetchBaselineFile — timeout', () => {
  it('returns an error containing "abort" or "timeout" when fetch times out', async () => {
    // Simulate an AbortError — what AbortController fires when signal aborts
    const abortErr = new globalThis.DOMException('The operation was aborted.', 'AbortError');
    fetchSpy.mockRejectedValueOnce(abortErr);

    const result = await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort|timeout/i);
  });

  it('passes a signal to fetch (AbortController wired)', async () => {
    fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: 'ok' }));

    await fetchBaselineFile({
      filePath: '.claude/rules/security.md',
      token: 'test-token',
      projectId: '52',
      baselineRef: 'main',
      timeoutMs: 5000,
    });

    const [, fetchOptions] = fetchSpy.mock.calls[0];
    expect(fetchOptions.signal).toBeDefined();
    expect(typeof fetchOptions.signal.aborted).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 11. Missing token — CLI spawn (exit code 1)
// ---------------------------------------------------------------------------

describe('fetchBaselineFile CLI — missing GITLAB_TOKEN', () => {
  it('exits with code 1 and writes an error to stderr when GITLAB_TOKEN is absent', () => {
    const env = { ...process.env };
    delete env.GITLAB_TOKEN;
    delete env.BASELINE_CACHE_DIR;

    const result = spawnSync(
      process.execPath,
      [FETCH_BASELINE_MJS, '52', 'some/file.md'],
      { encoding: 'utf8', env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/GITLAB_TOKEN/i);
  });
});
