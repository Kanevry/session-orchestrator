/**
 * tests/unit/slopcheck.test.mjs
 *
 * Vitest unit tests for scripts/lib/slopcheck.mjs (Pattern 2, issue #520).
 *
 * Covers:
 *   - classifyPackages: LEGITIMATE / SLOP / ASSUMED classifications
 *   - Input ordering and length preservation
 *   - Empty and malformed input handling
 *   - Cache read / write / clearance via getCachedClassification + clearCache
 *   - pip and cargo MVP skeleton (ASSUMED + evidence)
 *   - Never-throws contract: always returns an Array regardless of registry error
 *
 * Registry isolation strategy:
 *   `npm view <pkg> versions --json` is external I/O (subprocess → network).
 *   We mock child_process.execFile at the module level so tests are:
 *     - fast (no real network round-trips)
 *     - deterministic (no flakiness on npm availability)
 *     - CI-safe (no outbound connections required)
 *   classifyPackages itself is NOT mocked — only the registry subprocess.
 *
 * Cache isolation:
 *   Each describe block targeting cache calls clearCache() in beforeEach.
 *   The implementation is expected to hold the cache in memory (+ optionally
 *   persisted to a file). clearCache() must reset both.
 *
 * Design note: scripts/lib/slopcheck.mjs does not exist yet when this file is
 * first committed (Agent A implements it in parallel). Tests will be RED until
 * Agent A's commit lands. This is expected per the wave plan.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock child_process.execFile BEFORE importing the SUT.
// The mock is hoisted by Vitest so the SUT receives the mock on import.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execFile: vi.fn(),
  };
});

// Import the mock handle AFTER vi.mock() is declared so we can configure it
// per-test via mockImplementation / mockReset.
import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// SUT — imported AFTER mocks are wired
// ---------------------------------------------------------------------------

import {
  classifyPackages,
  getCachedClassification,
  clearCache,
  CACHE_TTL_MS,
  CACHE_PATH,
} from '@lib/slopcheck.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an execFile mock that resolves (simulates a found package).
 * Returns a JSON array of version strings, which is what `npm view <pkg> versions --json`
 * emits for a real package.
 */
function mockNpmFound(...versions) {
  const stdout = JSON.stringify(versions.length ? versions : ['1.0.0']);
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    // Support both (cmd, args, opts, cb) and (cmd, args, cb) call signatures
    const callback = typeof _opts === 'function' ? _opts : cb;
    callback(null, stdout, '');
  });
}

/**
 * Build an execFile mock that rejects (simulates a non-existent package).
 * `npm view nonexistent-pkg versions --json` exits with code 1 and an error.
 */
function mockNpmNotFound() {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    const err = new Error('npm ERR! 404 Not Found');
    err.code = 1;
    callback(err, '', 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/no-such-pkg');
  });
}

/**
 * Build an execFile mock that simulates a timeout / SIGTERM kill.
 */
function mockNpmTimeout() {
  execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    const err = new Error('Command timed out');
    err.killed = true;
    err.signal = 'SIGTERM';
    callback(err, '', '');
  });
}

// ---------------------------------------------------------------------------
// Per-test isolation: clear cache + reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearCache();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. classifyPackages — npm registry: classification accuracy
// ---------------------------------------------------------------------------

describe('classifyPackages — npm registry classification', () => {
  it('returns LEGITIMATE for a package that exists in the registry', async () => {
    mockNpmFound('18.2.0', '18.3.0', '19.0.0');

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('LEGITIMATE');
  });

  it('result entry includes the original name', async () => {
    mockNpmFound('1.0.0');

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(result[0].name).toBe('react');
  });

  it('result entry includes the original registry', async () => {
    mockNpmFound('1.0.0');

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(result[0].registry).toBe('npm');
  });

  it('returns SLOP for a package that is not found in the registry (npm 404)', async () => {
    mockNpmNotFound();

    const result = await classifyPackages([
      { name: 'absolutely-fake-pkg-no-way-this-exists-9z7q', registry: 'npm' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('SLOP');
  });

  it('preserves input order across a three-entry mixed-result list', async () => {
    // Configure mock to return different results based on the package name arg
    execFile.mockImplementation((_cmd, args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      // args = ['view', '--', '<pkg>', 'versions', '--json'] after SEC fix (-- separator).
      // The pkg arg is the first non-flag, non-fixed entry.
      const pkg = args.find((a) => a !== 'view' && a !== '--' && a !== 'versions' && a !== '--json');
      if (pkg === 'react' || pkg === 'next') {
        callback(null, JSON.stringify(['1.0.0']), '');
      } else {
        const err = new Error('npm ERR! 404');
        err.code = 1;
        callback(err, '', 'npm ERR! 404');
      }
    });

    const result = await classifyPackages([
      { name: 'react', registry: 'npm' },
      { name: 'absolutely-fake-pkg-xyz123', registry: 'npm' },
      { name: 'next', registry: 'npm' },
    ]);

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('react');
    expect(result[0].classification).toBe('LEGITIMATE');
    expect(result[1].name).toBe('absolutely-fake-pkg-xyz123');
    expect(result[1].classification).toBe('SLOP');
    expect(result[2].name).toBe('next');
    expect(result[2].classification).toBe('LEGITIMATE');
  });

  it('returns an empty array for empty input without calling execFile', async () => {
    const result = await classifyPackages([]);

    expect(result).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns one result per input entry', async () => {
    mockNpmFound('1.0.0');

    const result = await classifyPackages([
      { name: 'react', registry: 'npm' },
      { name: 'next', registry: 'npm' },
    ]);

    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. classifyPackages — malformed / edge-case inputs
// ---------------------------------------------------------------------------

describe('classifyPackages — malformed and edge-case inputs', () => {
  it('handles null name gracefully — returns ASSUMED or SLOP (never throws)', async () => {
    // Null name cannot be passed to npm view; function must not throw
    const result = await classifyPackages([{ name: null, registry: 'npm' }]);

    expect(result).toHaveLength(1);
    expect(['ASSUMED', 'SLOP']).toContain(result[0].classification);
  });

  it('handles undefined registry gracefully — returns ASSUMED or SLOP (never throws)', async () => {
    const result = await classifyPackages([{ name: 'react' }]);

    expect(result).toHaveLength(1);
    expect(['ASSUMED', 'SLOP']).toContain(result[0].classification);
  });

  it('handles an entry that is not an object gracefully (never throws)', async () => {
    const result = await classifyPackages(['not-an-object']);

    expect(result).toHaveLength(1);
    expect(['ASSUMED', 'SLOP']).toContain(result[0].classification);
  });

  it('handles an empty-string name gracefully — returns ASSUMED or SLOP (never throws)', async () => {
    const result = await classifyPackages([{ name: '', registry: 'npm' }]);

    expect(result).toHaveLength(1);
    expect(['ASSUMED', 'SLOP']).toContain(result[0].classification);
  });
});

// ---------------------------------------------------------------------------
// 3. Cache behaviour
// ---------------------------------------------------------------------------

describe('classifyPackages — cache behaviour', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
  });

  it('getCachedClassification returns null before any classifyPackages call', () => {
    const cached = getCachedClassification('react', 'npm');

    expect(cached).toBeNull();
  });

  it('writes a LEGITIMATE classification to cache after a successful registry lookup', async () => {
    mockNpmFound('18.2.0');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    const cached = getCachedClassification('react', 'npm');
    expect(cached).not.toBeNull();
    expect(cached.classification).toBe('LEGITIMATE');
  });

  it('writes a SLOP classification to cache after a 404 registry lookup', async () => {
    mockNpmNotFound();

    await classifyPackages([
      { name: 'fake-package-that-does-not-exist-7z', registry: 'npm' },
    ]);

    const cached = getCachedClassification('fake-package-that-does-not-exist-7z', 'npm');
    expect(cached).not.toBeNull();
    expect(cached.classification).toBe('SLOP');
  });

  it('does not call execFile on the second call for the same package (cache hit)', async () => {
    mockNpmFound('18.2.0');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);
    vi.clearAllMocks(); // reset call counter

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns the cached classification on the second call (cache hit returns same value)', async () => {
    mockNpmFound('18.2.0');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // Second call — served from cache regardless of mock state
    mockNpmNotFound(); // change mock; if cache is bypassed, result would be SLOP
    const second = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(second[0].classification).toBe('LEGITIMATE');
  });

  it('clearCache() removes all cached entries so getCachedClassification returns null', async () => {
    mockNpmFound('18.2.0');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);
    clearCache();

    expect(getCachedClassification('react', 'npm')).toBeNull();
  });

  it('clearCache() causes the next call to hit the registry again', async () => {
    mockNpmFound('18.2.0');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);
    clearCache();
    vi.clearAllMocks();

    mockNpmFound('18.2.0');
    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(execFile).toHaveBeenCalledOnce();
  });

  it('cache is keyed by both name and registry (different registries do not share cache)', async () => {
    mockNpmFound('1.0.0');
    await classifyPackages([{ name: 'requests', registry: 'npm' }]);

    // A pip entry for the same package name should not be served from the npm cache
    const pipCached = getCachedClassification('requests', 'pip');
    expect(pipCached).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. pip and cargo MVP skeleton
// ---------------------------------------------------------------------------

describe('classifyPackages — pip registry (MVP skeleton)', () => {
  it('returns ASSUMED for a pip package', async () => {
    const result = await classifyPackages([{ name: 'requests', registry: 'pip' }]);

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('ASSUMED');
  });

  it('includes pip-registry-unsupported-mvp in the evidence field', async () => {
    const result = await classifyPackages([{ name: 'requests', registry: 'pip' }]);

    expect(result[0].evidence).toContain('pip-registry-unsupported-mvp');
  });

  it('does not call execFile for a pip package (no npm invocation for unsupported registry)', async () => {
    await classifyPackages([{ name: 'requests', registry: 'pip' }]);

    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('classifyPackages — cargo registry (MVP skeleton)', () => {
  it('returns ASSUMED for a cargo package', async () => {
    const result = await classifyPackages([{ name: 'serde', registry: 'cargo' }]);

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('ASSUMED');
  });

  it('includes cargo-registry-unsupported-mvp in the evidence field', async () => {
    const result = await classifyPackages([{ name: 'serde', registry: 'cargo' }]);

    expect(result[0].evidence).toContain('cargo-registry-unsupported-mvp');
  });

  it('does not call execFile for a cargo package (no npm invocation for unsupported registry)', async () => {
    await classifyPackages([{ name: 'serde', registry: 'cargo' }]);

    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('classifyPackages — unknown registry (MVP skeleton)', () => {
  it('returns ASSUMED for an unrecognised registry', async () => {
    const result = await classifyPackages([{ name: 'somelib', registry: 'rubygems' }]);

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('ASSUMED');
  });
});

// ---------------------------------------------------------------------------
// 5. Never-throws contract
// ---------------------------------------------------------------------------

describe('classifyPackages — never throws', () => {
  it('returns an Array (not a thrown error) when execFile times out', async () => {
    mockNpmTimeout();

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // Must resolve (not reject) and return an array
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('classifies a timed-out package as ASSUMED (fail-soft, not SLOP)', async () => {
    mockNpmTimeout();

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // Per PRD Architecture: "bei Timeout → Klassifikation ASSUMED + WARN in stderr, kein Hard-Block"
    expect(result[0].classification).toBe('ASSUMED');
  });

  it('does not throw when execFile emits a non-404 error code (e.g. ENOENT)', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      const err = new Error('spawn ENOENT');
      err.code = 'ENOENT';
      callback(err, '', '');
    });

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('resolves even when called with an entirely invalid argument (non-array)', async () => {
    // Some implementations may guard against non-array input
    let result;
    let threw = false;
    try {
      result = await classifyPackages(null);
    } catch {
      threw = true;
    }
    // Either returns an empty/safe array or throws — but the module-level
    // contract is "never crashes the caller"; if it throws we flag it.
    // We verify the contract conservatively: if it did not throw, the result
    // must be an array.
    if (!threw) {
      expect(Array.isArray(result)).toBe(true);
    }
    // If it threw, that's a contract violation we want to surface as a RED test.
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Return shape contract
// ---------------------------------------------------------------------------

describe('classifyPackages — return shape', () => {
  it('every entry has a name field', async () => {
    mockNpmFound('1.0.0');

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(typeof result[0].name).toBe('string');
  });

  it('every entry has a registry field', async () => {
    mockNpmFound('1.0.0');

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(typeof result[0].registry).toBe('string');
  });

  it('every entry has a classification field with one of the four defined values', async () => {
    mockNpmFound('1.0.0');

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    expect(['LEGITIMATE', 'ASSUMED', 'SUS', 'SLOP']).toContain(result[0].classification);
  });

  it('classification value for a SLOP package is exactly the string "SLOP"', async () => {
    mockNpmNotFound();

    const result = await classifyPackages([
      { name: 'definitely-fake-pkg-zzz999', registry: 'npm' },
    ]);

    expect(result[0].classification).toBe('SLOP');
  });

  it('getCachedClassification returns an object with a classification field', async () => {
    mockNpmFound('1.0.0');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);
    const cached = getCachedClassification('react', 'npm');

    expect(typeof cached.classification).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 7. 24 h TTL boundary — Group A
// ---------------------------------------------------------------------------

describe('classifyPackages — 24 h TTL boundary', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls the registry again after the 24 h TTL has elapsed (cache entry expired)', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    mockNpmFound('18.2.0', '17.0.2');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // Advance time past the TTL boundary by 1 ms.
    vi.setSystemTime(new Date(t0.getTime() + CACHE_TTL_MS + 1));
    vi.clearAllMocks();
    mockNpmFound('18.2.0', '17.0.2');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // Registry was contacted again because the cache entry expired.
    expect(execFile).toHaveBeenCalledOnce();
  });

  it('does NOT call the registry again when the 24 h TTL has not yet elapsed (cache hit)', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    mockNpmFound('18.2.0', '17.0.2');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // Advance time to 1 ms BEFORE the TTL expires — cache should still be valid.
    vi.setSystemTime(new Date(t0.getTime() + CACHE_TTL_MS - 1));
    vi.clearAllMocks();

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // No registry call — served from in-memory cache.
    expect(execFile).not.toHaveBeenCalled();
  });

  it('getCachedClassification returns null for an entry that just crossed the 24 h TTL', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    mockNpmFound('18.2.0');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // One millisecond past the TTL.
    vi.setSystemTime(new Date(t0.getTime() + CACHE_TTL_MS + 1));

    const cached = getCachedClassification('react', 'npm');

    expect(cached).toBeNull();
  });

  it('getCachedClassification returns the entry when 1 ms remains within the TTL', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    mockNpmFound('18.2.0');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    vi.setSystemTime(new Date(t0.getTime() + CACHE_TTL_MS - 1));

    const cached = getCachedClassification('react', 'npm');

    expect(cached).not.toBeNull();
    expect(cached.classification).toBe('LEGITIMATE');
  });
});

// ---------------------------------------------------------------------------
// 8. Cross-process persistence (disk I/O round-trip) — Group B
// ---------------------------------------------------------------------------

describe('classifyPackages — disk persistence (cache file round-trip)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopcheck-test-'));
    clearCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up tmp directory and reset real-fs mocks.
    // eslint-disable-next-line no-empty
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    vi.restoreAllMocks();
  });

  it('writes the cache file at the expected path after a successful classification', async () => {
    mockNpmFound('18.2.0', '17.0.2');

    await classifyPackages([{ name: 'react', registry: 'npm' }], { repoRoot: tmpDir });

    const expectedFile = path.join(tmpDir, CACHE_PATH);
    expect(fs.existsSync(expectedFile)).toBe(true);
  });

  it('cache file contains the classified package entry with a valid fetchedAt timestamp', async () => {
    mockNpmFound('18.2.0', '17.0.2');

    const before = Date.now();
    await classifyPackages([{ name: 'react', registry: 'npm' }], { repoRoot: tmpDir });
    const after = Date.now();

    const cacheFile = path.join(tmpDir, CACHE_PATH);
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const parsed = JSON.parse(raw);

    expect(typeof parsed['npm:react']).toBe('object');
    expect(parsed['npm:react'].classification).toBe('LEGITIMATE');
    expect(parsed['npm:react'].fetchedAt).toBeGreaterThanOrEqual(before);
    expect(parsed['npm:react'].fetchedAt).toBeLessThanOrEqual(after);
  });

  it('does not call the registry after clearCache() + re-call when disk cache is still valid', async () => {
    mockNpmFound('18.2.0', '17.0.2');

    // First call: populates in-memory cache and writes to disk.
    await classifyPackages([{ name: 'react', registry: 'npm' }], { repoRoot: tmpDir });

    // Simulate a "fresh process" by wiping the in-memory cache only.
    // clearCache() sets _cacheLoadedFromPath = null, so the next
    // ensureCacheLoaded() will re-read from disk.
    clearCache({ repoRoot: tmpDir });
    // Re-seed the on-disk file that clearCache() just unlinked.
    // Write it back manually so we have a valid cache to read from.
    const cacheFile = path.join(tmpDir, CACHE_PATH);
    const cacheDir = path.dirname(cacheFile);
    fs.mkdirSync(cacheDir, { recursive: true });
    const diskEntry = {
      'npm:react': {
        classification: 'LEGITIMATE',
        fetchedAt: Date.now(),
        evidence: 'versions-count:2',
      },
    };
    fs.writeFileSync(cacheFile, JSON.stringify(diskEntry, null, 2) + '\n', 'utf8');
    // Wipe in-memory state again so ensureCacheLoaded() will read the file.
    clearCache({ repoRoot: tmpDir });
    // Restore the file that clearCache just deleted.
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(diskEntry, null, 2) + '\n', 'utf8');
    vi.clearAllMocks();

    // Second call: should load from disk, not call execFile.
    const result = await classifyPackages([{ name: 'react', registry: 'npm' }], { repoRoot: tmpDir });

    expect(execFile).not.toHaveBeenCalled();
    expect(result[0].classification).toBe('LEGITIMATE');
  });
});

// ---------------------------------------------------------------------------
// 9. fail-soft on cache write error — Group C
// ---------------------------------------------------------------------------

describe('classifyPackages — fail-soft when cache write throws', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns LEGITIMATE classification even when writeFileSync throws EACCES', async () => {
    mockNpmFound('18.2.0', '17.0.2');

    // Intercept writeFileSync when it targets the slopcheck tmp cache file.
    const writeFileSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath, ...rest) => {
      if (typeof filePath === 'string' && filePath.includes('slopcheck-cache.json')) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      // Pass through all other writeFileSync calls.
      return fs.writeFileSync.wrappedImplementation?.(filePath, ...rest);
    });

    const result = await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // Classification must succeed even though cache write failed.
    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('LEGITIMATE');
    // Spy was actually invoked (the impl tried to write).
    expect(writeFileSpy).toHaveBeenCalled();
  });

  it('emits a console.warn (not throws) when the cache write fails', async () => {
    mockNpmFound('18.2.0', '17.0.2');

    vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath.includes('slopcheck-cache.json')) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
    });

    const warnSpy = vi.spyOn(console, 'warn');

    await classifyPackages([{ name: 'react', registry: 'npm' }]);

    // A warn must have been emitted for the cache-write failure.
    expect(warnSpy).toHaveBeenCalled();
    const warnMessages = warnSpy.mock.calls.map((c) => c[0]);
    expect(warnMessages.some((m) => typeof m === 'string' && m.includes('cache write failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. npm response shape variants — Group D
// ---------------------------------------------------------------------------

describe('classifyPackages — npm response shape variants', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns LEGITIMATE with single-version evidence when npm responds with a plain version string', async () => {
    // npm collapses versions[] to a JSON string scalar for single-version packages.
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callback(null, '"1.0.0"', '');
    });

    const result = await classifyPackages([{ name: 'tiny-pkg', registry: 'npm' }]);

    expect(result[0].classification).toBe('LEGITIMATE');
    expect(result[0].evidence).toBe('single-version');
  });

  it('returns ASSUMED with no-published-versions evidence when npm responds with an empty array', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callback(null, '[]', '');
    });

    const result = await classifyPackages([{ name: 'ghost-pkg', registry: 'npm' }]);

    expect(result[0].classification).toBe('ASSUMED');
    expect(result[0].evidence).toBe('no-published-versions');
  });

  it('returns ASSUMED with unexpected-response-shape evidence when npm responds with an object', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      // An object is not an array — treated as unexpected shape.
      callback(null, '{"versions":["1.0.0"]}', '');
    });

    const result = await classifyPackages([{ name: 'weird-pkg', registry: 'npm' }]);

    expect(result[0].classification).toBe('ASSUMED');
    expect(result[0].evidence).toBe('unexpected-response-shape');
  });

  it('returns ASSUMED with unparseable-registry-response evidence when npm responds with invalid JSON', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      callback(null, '{invalid json', '');
    });

    const result = await classifyPackages([{ name: 'broken-pkg', registry: 'npm' }]);

    expect(result[0].classification).toBe('ASSUMED');
    expect(result[0].evidence).toBe('unparseable-registry-response');
  });
});
