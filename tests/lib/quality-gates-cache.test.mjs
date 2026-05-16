/**
 * tests/lib/quality-gates-cache.test.mjs
 *
 * Unit tests for scripts/lib/quality-gates-cache.mjs (issue #258).
 *
 * Coverage:
 *   - computeDependencyHash determinism + lockfile sensitivity
 *   - saveBaselineResult / loadLatestBaselineResult round-trip + corruption tolerance
 *   - isCacheValid: every reason code + TTL boundary + NaN-safe
 *   - shouldSkipIncremental: fail-safe behaviour for all error paths
 *   - Storage location contract
 *
 * Each test runs in an isolated tmpdir; no real repo state is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  computeDependencyHash,
  saveBaselineResult,
  loadLatestBaselineResult,
  isCacheValid,
  shouldSkipIncremental,
} from '@lib/quality-gates-cache.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const gitAvailable =
  spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

const passingResults = {
  typecheck: { status: 'pass', error_count: 0 },
  test: { status: 'pass' },
  lint: { status: 'pass' },
};

const CACHE_RELATIVE = '.orchestrator/metrics/baseline-results.jsonl';

// ---------------------------------------------------------------------------
// computeDependencyHash
// ---------------------------------------------------------------------------

describe('computeDependencyHash', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'qgc-hash-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('is deterministic across repeated calls with identical inputs', () => {
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }),
    );
    writeFileSync(
      path.join(repoRoot, 'package-lock.json'),
      '{"lockfileVersion":3}',
    );
    const h1 = computeDependencyHash(repoRoot);
    const h2 = computeDependencyHash(repoRoot);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when the lockfile contents change', () => {
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }),
    );
    writeFileSync(
      path.join(repoRoot, 'package-lock.json'),
      '{"lockfileVersion":3}',
    );
    const before = computeDependencyHash(repoRoot);
    writeFileSync(
      path.join(repoRoot, 'package-lock.json'),
      '{"lockfileVersion":3,"changed":true}',
    );
    const after = computeDependencyHash(repoRoot);
    expect(after).not.toBe(before);
  });

  it('changes when package.json contents change', () => {
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }),
    );
    const before = computeDependencyHash(repoRoot);
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.1' }),
    );
    const after = computeDependencyHash(repoRoot);
    expect(after).not.toBe(before);
  });

  it('is stable when only package.json exists (no lockfile)', () => {
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }),
    );
    const h1 = computeDependencyHash(repoRoot);
    const h2 = computeDependencyHash(repoRoot);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('removing the lockfile changes the hash', () => {
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }),
    );
    writeFileSync(
      path.join(repoRoot, 'package-lock.json'),
      '{"lockfileVersion":3}',
    );
    const withLock = computeDependencyHash(repoRoot);
    rmSync(path.join(repoRoot, 'package-lock.json'));
    const withoutLock = computeDependencyHash(repoRoot);
    expect(withLock).not.toBe(withoutLock);
  });

  it('prefers pnpm-lock.yaml over package-lock.json', () => {
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a' }),
    );
    writeFileSync(
      path.join(repoRoot, 'pnpm-lock.yaml'),
      'lockfileVersion: 9.0\n',
    );
    const pnpmOnly = computeDependencyHash(repoRoot);
    // Add package-lock.json — since pnpm-lock.yaml wins, hash should NOT change.
    writeFileSync(
      path.join(repoRoot, 'package-lock.json'),
      '{"lockfileVersion":3}',
    );
    const withBoth = computeDependencyHash(repoRoot);
    expect(withBoth).toBe(pnpmOnly);
  });

  it('returns a stable sha256 even when neither file exists', () => {
    const h = computeDependencyHash(repoRoot);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    // sha256 of empty string (stable null)
    expect(h).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

// ---------------------------------------------------------------------------
// saveBaselineResult + loadLatestBaselineResult
// ---------------------------------------------------------------------------

describe('saveBaselineResult + loadLatestBaselineResult round-trip', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'qgc-save-'));
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }),
    );
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('writes a single JSONL line with all required fields', () => {
    saveBaselineResult({
      repoRoot,
      sessionId: 'session-abc',
      sessionStartRef: 'deadbeef',
      results: passingResults,
    });
    const loaded = loadLatestBaselineResult({ repoRoot });
    expect(loaded).not.toBeNull();
    expect(loaded.version).toBe(1);
    expect(loaded.session_id).toBe('session-abc');
    expect(loaded.session_start_ref).toBe('deadbeef');
    expect(typeof loaded.captured_at).toBe('string');
    expect(loaded.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(loaded.dependency_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.results).toEqual(passingResults);
  });

  it('loadLatestBaselineResult returns the most recently appended record', () => {
    saveBaselineResult({
      repoRoot,
      sessionId: 'first',
      sessionStartRef: 'ref1',
      results: passingResults,
    });
    saveBaselineResult({
      repoRoot,
      sessionId: 'second',
      sessionStartRef: 'ref2',
      results: passingResults,
    });
    const loaded = loadLatestBaselineResult({ repoRoot });
    expect(loaded.session_id).toBe('second');
    expect(loaded.session_start_ref).toBe('ref2');
  });

  it('appending preserves previous records (append-only semantics)', () => {
    saveBaselineResult({
      repoRoot,
      sessionId: 'first',
      sessionStartRef: 'ref1',
      results: passingResults,
    });
    saveBaselineResult({
      repoRoot,
      sessionId: 'second',
      sessionStartRef: 'ref2',
      results: passingResults,
    });
    const raw = readFileSync(path.join(repoRoot, CACHE_RELATIVE), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).session_id).toBe('first');
    expect(JSON.parse(lines[1]).session_id).toBe('second');
  });

  it('returns null when the cache file is missing', () => {
    expect(loadLatestBaselineResult({ repoRoot })).toBeNull();
  });

  it('returns null when the cache file is empty', () => {
    // Seed a first record so the directory exists, then overwrite file to empty.
    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: 'r',
      results: passingResults,
    });
    writeFileSync(path.join(repoRoot, CACHE_RELATIVE), '');
    expect(loadLatestBaselineResult({ repoRoot })).toBeNull();
  });

  it('returns null when last line is corrupted JSON', () => {
    saveBaselineResult({
      repoRoot,
      sessionId: 'good',
      sessionStartRef: 'ref1',
      results: passingResults,
    });
    appendFileSync(path.join(repoRoot, CACHE_RELATIVE), 'not-json\n');
    expect(loadLatestBaselineResult({ repoRoot })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isCacheValid — all reason codes
// ---------------------------------------------------------------------------

describe('isCacheValid — reason codes', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'qgc-valid-'));
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }),
    );
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns no-record when latestRecord is null', () => {
    const res = isCacheValid({
      repoRoot,
      latestRecord: null,
      currentSessionStartRef: 'abc',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('no-record');
  });

  it('returns session-ref-mismatch when refs differ', () => {
    const record = {
      version: 1,
      session_id: 's',
      session_start_ref: 'old-ref',
      captured_at: new Date().toISOString(),
      dependency_hash: computeDependencyHash(repoRoot),
      results: passingResults,
    };
    const res = isCacheValid({
      repoRoot,
      latestRecord: record,
      currentSessionStartRef: 'new-ref',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('session-ref-mismatch');
  });

  it('returns dependency-changed when package.json was mutated after save', () => {
    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: 'ref1',
      results: passingResults,
    });
    // Mutate package.json so current hash != saved hash.
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '2.0.0' }),
    );
    const latestRecord = loadLatestBaselineResult({ repoRoot });
    const res = isCacheValid({
      repoRoot,
      latestRecord,
      currentSessionStartRef: 'ref1',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('dependency-changed');
  });

  it('returns ttl-expired when captured_at is older than ttlDays', () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const record = {
      version: 1,
      session_id: 's',
      session_start_ref: 'ref1',
      captured_at: eightDaysAgo,
      dependency_hash: computeDependencyHash(repoRoot),
      results: passingResults,
    };
    const res = isCacheValid({
      repoRoot,
      latestRecord: record,
      currentSessionStartRef: 'ref1',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('ttl-expired');
  });

  it('returns baseline-had-failures when any result status !== pass', () => {
    const record = {
      version: 1,
      session_id: 's',
      session_start_ref: 'ref1',
      captured_at: new Date().toISOString(),
      dependency_hash: computeDependencyHash(repoRoot),
      results: {
        typecheck: { status: 'pass' },
        test: { status: 'fail' },
        lint: { status: 'pass' },
      },
    };
    const res = isCacheValid({
      repoRoot,
      latestRecord: record,
      currentSessionStartRef: 'ref1',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('baseline-had-failures');
  });

  it('returns valid=true on the happy path', () => {
    const record = {
      version: 1,
      session_id: 's',
      session_start_ref: 'ref1',
      captured_at: new Date().toISOString(),
      dependency_hash: computeDependencyHash(repoRoot),
      results: passingResults,
    };
    const res = isCacheValid({
      repoRoot,
      latestRecord: record,
      currentSessionStartRef: 'ref1',
    });
    expect(res.valid).toBe(true);
    expect(res.reason).toBe('cache-hit');
  });

  it('reason-code precedence: ref-mismatch beats dependency-changed', () => {
    // Stale dep hash AND wrong ref — ref-mismatch is checked first.
    const record = {
      version: 1,
      session_id: 's',
      session_start_ref: 'old-ref',
      captured_at: new Date().toISOString(),
      dependency_hash: 'totally-wrong-hash',
      results: passingResults,
    };
    const res = isCacheValid({
      repoRoot,
      latestRecord: record,
      currentSessionStartRef: 'new-ref',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('session-ref-mismatch');
  });
});

// ---------------------------------------------------------------------------
// isCacheValid — TTL boundary + NaN-safe
// ---------------------------------------------------------------------------

describe('isCacheValid — TTL boundary', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'qgc-ttl-'));
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a' }),
    );
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function recordAgedBy(ms) {
    return {
      version: 1,
      session_id: 's',
      session_start_ref: 'ref1',
      captured_at: new Date(Date.now() - ms).toISOString(),
      dependency_hash: computeDependencyHash(repoRoot),
      results: passingResults,
    };
  }

  it('valid just under the 7-day TTL', () => {
    const ms = 7 * 24 * 60 * 60 * 1000 - 60 * 1000; // 7 days - 1 min
    const res = isCacheValid({
      repoRoot,
      latestRecord: recordAgedBy(ms),
      currentSessionStartRef: 'ref1',
    });
    expect(res.valid).toBe(true);
  });

  it('ttl-expired just over the 7-day TTL', () => {
    const ms = 7 * 24 * 60 * 60 * 1000 + 60 * 1000; // 7 days + 1 min
    const res = isCacheValid({
      repoRoot,
      latestRecord: recordAgedBy(ms),
      currentSessionStartRef: 'ref1',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('ttl-expired');
  });

  it('treats invalid date strings as ttl-expired (NaN-safe)', () => {
    const record = {
      version: 1,
      session_id: 's',
      session_start_ref: 'ref1',
      captured_at: 'not-a-date',
      dependency_hash: computeDependencyHash(repoRoot),
      results: passingResults,
    };
    const res = isCacheValid({
      repoRoot,
      latestRecord: record,
      currentSessionStartRef: 'ref1',
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('ttl-expired');
  });

  it('honours custom ttlDays parameter', () => {
    const ms = 2 * 24 * 60 * 60 * 1000; // 2 days old
    const res = isCacheValid({
      repoRoot,
      latestRecord: recordAgedBy(ms),
      currentSessionStartRef: 'ref1',
      ttlDays: 1,
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('ttl-expired');
  });
});

// ---------------------------------------------------------------------------
// shouldSkipIncremental — fail-safe behaviour
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable)('shouldSkipIncremental', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'qgc-skip-'));
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0' }),
    );
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns skip=false with no-record reason when cache is missing', () => {
    const res = shouldSkipIncremental({
      repoRoot,
      sessionStartRef: 'anything',
    });
    expect(res.skip).toBe(false);
    expect(res.reason).toBe('no-record');
    expect(typeof res.changedFileCount).toBe('number');
  });

  it('returns skip=false when git is unavailable / not a repo (fail-safe)', () => {
    // Valid cache record but no git repo initialised — git diff fails.
    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: 'nohead',
      results: passingResults,
    });
    const res = shouldSkipIncremental({
      repoRoot,
      sessionStartRef: 'nohead',
    });
    expect(res.skip).toBe(false);
    expect(res.reason).toMatch(/^(git-diff-failed|error:)/);
    expect(res.changedFileCount).toBe(-1);
  });

  it('returns skip=true when cache is valid and diff is narrow', () => {
    git(repoRoot, 'init', '-q');
    // Gitignore the orchestrator metrics dir so saveBaselineResult's file
    // doesn't count in git-diff.
    writeFileSync(path.join(repoRoot, '.gitignore'), '.orchestrator/\n');
    writeFileSync(path.join(repoRoot, 'a.txt'), 'a\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'initial');
    const baseRef = git(repoRoot, 'rev-parse', 'HEAD');

    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: baseRef,
      results: passingResults,
    });

    // One new commit touching one file.
    writeFileSync(path.join(repoRoot, 'b.txt'), 'b\n');
    git(repoRoot, 'add', 'b.txt');
    git(repoRoot, 'commit', '-q', '-m', 'second');

    const res = shouldSkipIncremental({ repoRoot, sessionStartRef: baseRef });
    expect(res.skip).toBe(true);
    expect(res.reason).toBe('cache-hit');
    expect(res.changedFileCount).toBe(1);
  });

  it('returns skip=false with scope-too-large when diff exceeds threshold', () => {
    git(repoRoot, 'init', '-q');
    writeFileSync(path.join(repoRoot, '.gitignore'), '.orchestrator/\n');
    writeFileSync(path.join(repoRoot, 'seed.txt'), 'seed\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'seed');
    const baseRef = git(repoRoot, 'rev-parse', 'HEAD');

    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: baseRef,
      results: passingResults,
    });

    // Create 6 new files with scopeThreshold=5 → triggers scope-too-large.
    const addFiles = [];
    for (let i = 0; i < 6; i++) {
      const fname = `f${i}.txt`;
      writeFileSync(path.join(repoRoot, fname), `${i}\n`);
      addFiles.push(fname);
    }
    git(repoRoot, 'add', ...addFiles);
    git(repoRoot, 'commit', '-q', '-m', 'many');

    const res = shouldSkipIncremental({
      repoRoot,
      sessionStartRef: baseRef,
      scopeThreshold: 5,
    });
    expect(res.skip).toBe(false);
    expect(res.reason).toBe('scope-too-large');
    expect(res.changedFileCount).toBe(6);
  });

  it('never throws even with bogus session-start ref', () => {
    expect(() =>
      shouldSkipIncremental({
        repoRoot,
        sessionStartRef: 'does-not-exist-ref',
      }),
    ).not.toThrow();
  });

  it('exactly-at-threshold is NOT skipped (>= scopeThreshold denies cache)', () => {
    git(repoRoot, 'init', '-q');
    writeFileSync(path.join(repoRoot, '.gitignore'), '.orchestrator/\n');
    writeFileSync(path.join(repoRoot, 'seed.txt'), 'seed\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'seed');
    const baseRef = git(repoRoot, 'rev-parse', 'HEAD');

    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: baseRef,
      results: passingResults,
    });

    // 5 new files with threshold=5 → changedFileCount === threshold → skip=false.
    const addFiles = [];
    for (let i = 0; i < 5; i++) {
      const fname = `f${i}.txt`;
      writeFileSync(path.join(repoRoot, fname), `${i}\n`);
      addFiles.push(fname);
    }
    git(repoRoot, 'add', ...addFiles);
    git(repoRoot, 'commit', '-q', '-m', 'exact');

    const res = shouldSkipIncremental({
      repoRoot,
      sessionStartRef: baseRef,
      scopeThreshold: 5,
    });
    expect(res.skip).toBe(false);
    expect(res.reason).toBe('scope-too-large');
    expect(res.changedFileCount).toBe(5);
  });

  it('propagates validity reason when cache is invalid (ref-mismatch)', () => {
    git(repoRoot, 'init', '-q');
    writeFileSync(path.join(repoRoot, 'a.txt'), 'a\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-q', '-m', 'initial');
    const baseRef = git(repoRoot, 'rev-parse', 'HEAD');

    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: baseRef,
      results: passingResults,
    });

    // Ask with a different ref — cache is invalid with ref-mismatch reason.
    const res = shouldSkipIncremental({
      repoRoot,
      sessionStartRef: 'some-other-ref',
    });
    expect(res.skip).toBe(false);
    expect(res.reason).toBe('session-ref-mismatch');
    expect(res.changedFileCount).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Storage location contract
// ---------------------------------------------------------------------------

describe('storage location', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'qgc-loc-'));
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'a' }),
    );
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('writes to exactly .orchestrator/metrics/baseline-results.jsonl', () => {
    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: 'ref1',
      results: passingResults,
    });
    const expected = path.join(
      repoRoot,
      '.orchestrator',
      'metrics',
      'baseline-results.jsonl',
    );
    expect(existsSync(expected)).toBe(true);
  });

  it('auto-creates parent directory when .orchestrator/metrics does not exist', () => {
    const parent = path.join(repoRoot, '.orchestrator', 'metrics');
    expect(existsSync(parent)).toBe(false);
    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: 'ref1',
      results: passingResults,
    });
    expect(existsSync(parent)).toBe(true);
  });

  it('does not leak the cache into repoRoot itself', () => {
    saveBaselineResult({
      repoRoot,
      sessionId: 's',
      sessionStartRef: 'ref1',
      results: passingResults,
    });
    expect(existsSync(path.join(repoRoot, 'baseline-results.jsonl'))).toBe(
      false,
    );
  });
});
