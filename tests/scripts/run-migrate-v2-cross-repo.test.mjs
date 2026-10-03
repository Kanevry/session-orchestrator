/**
 * tests/scripts/run-migrate-v2-cross-repo.test.mjs
 *
 * Vitest integration tests for scripts/run-migrate-v2-cross-repo.mjs.
 *
 * Each test creates a fresh tmpdir containing fake "repos", each with their own
 * .orchestrator/metrics/learnings.jsonl fixture, then invokes the CLI via
 * spawnSync and asserts on stdout/stderr/file state.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLearning } from '@lib/learnings.mjs';
import { releaseFileLock, tryAcquireFileLock } from '@lib/file-lock.mjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'run-migrate-v2-cross-repo.mjs');
const GOLDEN_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'learnings-invalid-golden.jsonl');

// ---------------------------------------------------------------------------
// Fixtures — canonical learning record (all required fields, valid)
// ---------------------------------------------------------------------------

/**
 * Returns a valid JSONL line for a canonical learning record.
 */
function canonicalLine(id = 'id-canonical-1') {
  return JSON.stringify({
    id,
    type: 'recurring-issue',
    subject: 'test-subject',
    insight: 'test insight',
    evidence: 'test evidence',
    confidence: 0.7,
    source_session: 'main-2026-05-01-1200',
    created_at: '2026-05-01T00:00:00Z',
    expires_at: '2026-06-01T00:00:00Z',
    schema_version: 1,
    scope: 'local',
    host_class: null,
    anonymized: false,
  });
}

/**
 * Returns an invalid JSONL line — missing insight field, but has a
 * migratable alias (description → insight) so migrateLegacyLearning can fix it.
 */
function legacyDescriptionLine(id = 'id-legacy-1') {
  return JSON.stringify({
    id,
    type: 'fragile-file',
    subject: 'legacy-subject',
    description: 'legacy description text',  // alias → insight
    evidence: 'legacy evidence',
    confidence: 0.5,
    source_session: 'main-2026-04-01-0900',
    created_at: '2026-04-01T00:00:00Z',
    expires_at: '2026-05-01T00:00:00Z',
    schema_version: 1,
    scope: 'local',
  });
}

/**
 * Returns an invalid JSONL line with a coercible scope (vault-tools → local)
 * and missing source_session that can be derived from sessions[].
 */
function legacyScopeAndSessionLine(id = 'id-legacy-scope-1') {
  return JSON.stringify({
    id,
    type: 'effective-sizing',
    subject: 'scope-test',
    insight: 'insight text',
    evidence: 'evidence',
    confidence: 0.6,
    source_session: '',           // will be derived from sessions[0]
    sessions: ['main-2026-04-15-1000'],
    created_at: '2026-04-15T00:00:00Z',
    expires_at: '2026-05-15T00:00:00Z',
    schema_version: 1,
    scope: 'vault-tools',         // coercible → local
  });
}

/**
 * Returns a JSONL line that still fails validation even after migration
 * (missing required insight AND no alias field available).
 */
function _unrecoverableLine(id = 'id-unrecoverable-1') {
  return JSON.stringify({
    id,
    type: 'recurring-issue',
    subject: 'unrecoverable',
    // No insight, description, recommendation, observation, lesson
    evidence: 'some evidence',
    confidence: 0.5,
    source_session: 'main-2026-04-01-0900',
    created_at: '2026-04-01T00:00:00Z',
    expires_at: '2026-05-01T00:00:00Z',
    schema_version: 1,
    scope: 'local',
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpdirs = [];

/**
 * Create a base tmpdir and return its path. Tracks for cleanup.
 */
function makeTmpBase() {
  const tmp = mkdtempSync(join(tmpdir(), 'cross-repo-migrate-test-'));
  tmpdirs.push(tmp);
  return tmp;
}

/**
 * Create a fake repo directory with a learnings.jsonl containing the given lines.
 * Returns the repo path.
 */
function makeFakeRepo(baseDir, repoName, jsonlLines) {
  const repoPath = join(baseDir, repoName);
  const metricsDir = join(repoPath, '.orchestrator', 'metrics');
  mkdirSync(metricsDir, { recursive: true });
  if (jsonlLines !== null) {
    writeFileSync(join(metricsDir, 'learnings.jsonl'), jsonlLines.join('\n') + '\n', 'utf8');
  }
  // No learnings.jsonl written when jsonlLines === null → simulates absent file
  return repoPath;
}

/**
 * Run the CLI script with given args. Returns spawnSync result.
 */
function run(args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/**
 * Read the learnings.jsonl of a fake repo and return parsed records.
 */
function readLearnings(repoPath) {
  const p = join(repoPath, '.orchestrator', 'metrics', 'learnings.jsonl');
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * List all .bak-cross-repo-migrate-* files in a repo's metrics dir.
 */
function listBackups(repoPath) {
  const metricsDir = join(repoPath, '.orchestrator', 'metrics');
  if (!existsSync(metricsDir)) return [];
  return readdirSync(metricsDir).filter((f) => f.startsWith('learnings.jsonl.bak-cross-repo-migrate-'));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  for (const d of tmpdirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run-migrate-v2-cross-repo', () => {
  // -------------------------------------------------------------------------
  // Test 1 — Dry-run on multi-repo: counts correct, no files mutated
  // -------------------------------------------------------------------------

  it('1. dry-run on multi-repo: counts correct, files not mutated', () => {
    const base = makeTmpBase();

    // Repo A: 2 canonical + 1 migratable (description alias)
    const repoA = makeFakeRepo(base, 'repo-a', [
      canonicalLine('a-1'),
      canonicalLine('a-2'),
      legacyDescriptionLine('a-3'),
    ]);

    // Repo B: 1 canonical + 1 migratable (scope coercion + source_session)
    const repoB = makeFakeRepo(base, 'repo-b', [
      canonicalLine('b-1'),
      legacyScopeAndSessionLine('b-2'),
    ]);

    const originalA = readFileSync(join(repoA, '.orchestrator', 'metrics', 'learnings.jsonl'), 'utf8');
    const originalB = readFileSync(join(repoB, '.orchestrator', 'metrics', 'learnings.jsonl'), 'utf8');

    const result = run([
      '--repos', `${repoA},${repoB}`,
    ]);

    expect(result.status).toBe(0);

    // Files must be unchanged
    const afterA = readFileSync(join(repoA, '.orchestrator', 'metrics', 'learnings.jsonl'), 'utf8');
    const afterB = readFileSync(join(repoB, '.orchestrator', 'metrics', 'learnings.jsonl'), 'utf8');
    expect(afterA).toBe(originalA);
    expect(afterB).toBe(originalB);

    // No backups created in dry-run
    expect(listBackups(repoA)).toHaveLength(0);
    expect(listBackups(repoB)).toHaveLength(0);

    // Output must contain the dry-run label and repo names
    const output = result.stdout;
    expect(output).toContain('dry-run');
    expect(output).toContain('repo-a');
    expect(output).toContain('repo-b');

    // stderr summary must mention "dry-run"
    expect(result.stderr).toContain('[dry-run]');

    // Both repos have "fixed-by-v2" candidates: a-3 and b-2
    // Verify the aggregate mentions fixed records
    expect(output).toContain('Fixed by v2');
  });

  // -------------------------------------------------------------------------
  // Test 2 — Apply on multi-repo: files mutated, invalid reduced, backup created
  // -------------------------------------------------------------------------

  it('2. --apply on multi-repo: files mutated, invalid reduced, backup created', () => {
    const base = makeTmpBase();

    // Repo A: 1 canonical + 1 migratable
    const repoA = makeFakeRepo(base, 'repo-a', [
      canonicalLine('a-1'),
      legacyDescriptionLine('a-2'),
    ]);

    // Repo B: 1 canonical + 1 migratable scope
    const repoB = makeFakeRepo(base, 'repo-b', [
      canonicalLine('b-1'),
      legacyScopeAndSessionLine('b-2'),
    ]);

    const result = run([
      '--repos', `${repoA},${repoB}`,
      '--apply',
    ]);

    expect(result.status).toBe(0);

    // Both repos should now have canonical records
    const recordsA = readLearnings(repoA);
    expect(recordsA).toHaveLength(2);
    // a-2 was a description alias → should now have insight field
    const a2 = recordsA.find((r) => r.id === 'a-2');
    expect(a2).toBeDefined();
    expect(a2.insight).toBe('legacy description text');
    expect(a2.description).toBeUndefined();

    const recordsB = readLearnings(repoB);
    expect(recordsB).toHaveLength(2);
    // b-2 should have coerced scope and derived source_session
    const b2 = recordsB.find((r) => r.id === 'b-2');
    expect(b2).toBeDefined();
    expect(b2.scope).toBe('local');
    expect(b2.source_session).toBe('main-2026-04-15-1000');

    // Backups must exist
    expect(listBackups(repoA)).toHaveLength(1);
    expect(listBackups(repoB)).toHaveLength(1);

    // stderr summary must mention "apply"
    expect(result.stderr).toContain('[apply]');

    // Output must indicate applied status
    expect(result.stdout).toContain('applied');
  });

  // -------------------------------------------------------------------------
  // Test 3 — Skip repos with no learnings.jsonl: handles gracefully, no error
  // -------------------------------------------------------------------------

  it('3. repos with no learnings.jsonl are skipped gracefully', () => {
    const base = makeTmpBase();

    // Repo A: has learnings.jsonl
    const repoA = makeFakeRepo(base, 'repo-a', [canonicalLine('a-1')]);

    // Repo B: no learnings.jsonl (directory not even created)
    const repoB = join(base, 'repo-b-empty');
    mkdirSync(repoB, { recursive: true });

    // Repo C: directory exists but no .orchestrator subdir at all
    const repoC = join(base, 'repo-c-no-orchestrator');
    mkdirSync(repoC, { recursive: true });

    const result = run([
      '--repos', `${repoA},${repoB},${repoC}`,
    ]);

    expect(result.status).toBe(0);

    const output = result.stdout;
    // Repo A should show as dry-run (has learnings)
    expect(output).toContain('repo-a');
    // Repos B/C should show as skipped
    expect(output).toContain('skipped');

    // No errors in stderr (other than summary)
    // stderr should only have the summary line, not error messages
    const stderrLines = result.stderr.split('\n').filter((l) => l.trim().length > 0);
    for (const line of stderrLines) {
      // Each line should be a summary or info line, not an error trace
      expect(line).not.toContain('Error:');
      expect(line).not.toContain('stack trace');
    }
  });

  // -------------------------------------------------------------------------
  // Test 4 — --repos override: respects the list, ignores ROLLOUT_REPOS
  // -------------------------------------------------------------------------

  it('4. --repos override: only specified repos are processed', () => {
    const base = makeTmpBase();

    const repoA = makeFakeRepo(base, 'repo-override-a', [canonicalLine('override-1')]);
    const repoB = makeFakeRepo(base, 'repo-override-b', [legacyDescriptionLine('override-2')]);

    // If ROLLOUT_REPOS were used, they'd all be "skipped" (don't exist on CI).
    // We override with exactly these two repos.
    const result = run([
      '--repos', `${repoA},${repoB}`,
    ]);

    expect(result.status).toBe(0);

    const output = result.stdout;

    // Only our repos should appear
    expect(output).toContain('repo-override-a');
    expect(output).toContain('repo-override-b');

    // Summary line should say 1 processed (override-b has migratable) + 1 processed
    expect(result.stderr).toContain('[dry-run]');
  });

  // -------------------------------------------------------------------------
  // Test 5 — --json output mode: produces valid JSON
  // -------------------------------------------------------------------------

  it('5. --json flag produces valid JSON with expected structure', () => {
    const base = makeTmpBase();

    const repoA = makeFakeRepo(base, 'repo-json-a', [
      canonicalLine('j-1'),
      legacyDescriptionLine('j-2'),
    ]);
    const repoB = makeFakeRepo(base, 'repo-json-b', null); // no learnings.jsonl

    const result = run([
      '--repos', `${repoA},${repoB}`,
      '--json',
    ]);

    expect(result.status).toBe(0);

    // stdout must be valid JSON
    let parsed;
    expect(() => {
      parsed = JSON.parse(result.stdout);
    }).not.toThrow();

    // Top-level shape
    expect(parsed).toHaveProperty('mode', 'dry-run');
    expect(parsed).toHaveProperty('repos');
    expect(parsed).toHaveProperty('aggregate');
    expect(Array.isArray(parsed.repos)).toBe(true);

    // Two repos in the list
    expect(parsed.repos).toHaveLength(2);

    // repo-json-a: has 2 records (1 canonical + 1 migratable)
    const repoAResult = parsed.repos.find((r) => r.repo === repoA);
    expect(repoAResult).toBeDefined();
    expect(repoAResult.status).toBe('dry-run');
    expect(repoAResult.total).toBe(2);
    expect(repoAResult.invalidPre).toBe(1);   // j-2 invalid pre-migration
    expect(repoAResult.fixedByV2).toBe(1);    // j-2 fixed by description→insight
    expect(repoAResult.invalidPost).toBe(0);  // all valid post-migration

    // repo-json-b: no learnings.jsonl → skipped
    const repoBResult = parsed.repos.find((r) => r.repo === repoB);
    expect(repoBResult).toBeDefined();
    expect(repoBResult.status).toBe('skipped');
    expect(repoBResult.total).toBe(0);

    // Aggregate sums over the two repos (skipped repo-json-b contributes 0)
    expect(parsed.aggregate).toMatchObject({
      totalRecords: 2,
      totalFixedByV2: 1,
      totalStillInvalidPost: 0,
      totalReposProcessed: 1,
      totalReposSkipped: 1,
    });
  });

  // -------------------------------------------------------------------------
  // Test 6 — no --repos and no Session Config → clean no-op, exit 0
  // -------------------------------------------------------------------------

  it('6. no --repos flag and no cross-repo.projects in config → no-op exit 0', () => {
    // Run from a tmp dir that has no CLAUDE.md → config loader returns [] → no-op
    const base = makeTmpBase();

    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: base, // no CLAUDE.md here → config returns empty list
    });

    // Must exit 0 (not 1)
    expect(result.status).toBe(0);
    // Must emit the no-op notice to stderr
    expect(result.stderr).toContain('cross-repo: no projects configured');
    // Must not produce any output table
    expect(result.stdout).toBe('');
  });
  // -------------------------------------------------------------------------
  // Test 7/8 — golden fixture (GitHub #69 / GitLab #1446): 8 records that fail
  // strict validateLearning on `scope` (6) and `schema_version` (2).
  // -------------------------------------------------------------------------

  /** Copy the golden fixture into a fresh tmp repo; returns { repo, file, original }. */
  function goldenRepo() {
    const repo = makeFakeRepo(makeTmpBase(), 'repo-golden', null);
    const file = join(repo, '.orchestrator', 'metrics', 'learnings.jsonl');
    const original = readFileSync(GOLDEN_FIXTURE, 'utf8');
    writeFileSync(file, original, 'utf8');
    return { repo, file, original };
  }

  /** null when the record passes strict validation, else the error message. */
  function strictError(record) {
    try {
      validateLearning(record);
      return null;
    } catch (err) {
      return err.message;
    }
  }

  it('7. golden fixture: dry run counts both error classes, fixes all 8, writes nothing', () => {
    const { repo, file, original } = goldenRepo();

    const result = run(['--repos', repo, '--json']);
    expect(result.status).toBe(0);
    const repoResult = JSON.parse(result.stdout).repos[0];
    expect(repoResult).toMatchObject({ invalidPre: 8, invalidPost: 0, fixedByV2: 8 });
    expect(repoResult.errorClassesPre).toEqual({
      'scope must be one of local|private|public': 6,
      'schema_version must be 0 (legacy) or 1': 2,
    });
    expect(repoResult.errorClassesPost).toEqual({});
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(listBackups(repo)).toHaveLength(0);

    const markdown = run(['--repos', repo]);
    expect(markdown.stdout).toContain('| scope must be one of local\\|private\\|public | 6 | 0 |');
  });

  it('8. golden fixture: --apply backs up the original and leaves 8 strictly valid, coerced records', () => {
    const { repo, original } = goldenRepo();

    const result = run(['--repos', repo, '--apply', '--json']);
    expect(result.status).toBe(0);

    const backups = listBackups(repo);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(repo, '.orchestrator', 'metrics', backups[0]), 'utf8')).toBe(original);

    const records = readLearnings(repo);
    expect(records.map(strictError)).toEqual([null, null, null, null, null, null, null, null]);
    expect(
      records.map((r) => ({
        id: r.id,
        scope: r.scope,
        schema_version: r.schema_version,
        file_paths: r.file_paths ?? null,
        hasFiles: 'files' in r,
      })),
    ).toEqual([
      { id: '7c1e4a2b-3d5f-4a6b-8c9d-0e1f2a3b4c5d', scope: 'private', schema_version: 1, file_paths: ['app/ui/demo-banner.tsx'], hasFiles: false },
      { id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', scope: 'private', schema_version: 1, file_paths: ['lib/format/index.ts', 'lib/format/price-label.ts'], hasFiles: false },
      { id: '2b3c4d5e-6f7a-4b8c-a9d0-e1f2a3b4c5d6', scope: 'private', schema_version: 1, file_paths: null, hasFiles: false },
      { id: '4d5e6f7a-8b9c-4d0e-b1f2-a3b4c5d6e7f8', scope: 'private', schema_version: 1, file_paths: null, hasFiles: false },
      { id: '6f7a8b9c-0d1e-4f2a-83b4-c5d6e7f8a9b0', scope: 'local', schema_version: 1, file_paths: null, hasFiles: false },
      { id: '8b9c0d1e-2f3a-4b4c-95d6-e7f8a9b0c1d2', scope: 'private', schema_version: 1, file_paths: null, hasFiles: false },
      { id: '7af5fe58-6033-42f1-9118-7b8b99d0bf1c', scope: 'private', schema_version: 1, file_paths: ['src/sample/list-item.tsx', 'src/sample/list-view.tsx'], hasFiles: false },
      { id: 'ce99fcdb-19db-4e7e-8ab8-2f4b84b747f2', scope: 'private', schema_version: 1, file_paths: ['docs/guide.md'], hasFiles: false },
    ]);

    const rerun = run(['--repos', repo, '--json']);
    expect(JSON.parse(rerun.stdout).repos[0].invalidPre).toBe(0);
  });

  // Bug pinned (REFUTE review MED): --apply rewrote another repo's store
  // outside the learnings store lock, so a live session appending between the
  // read and the rename lost its record. A held lock must leave that store
  // byte-identical, report the repo, still migrate the next repo, and exit 2.
  // The child waits the full LEARNINGS_LOCK_TIMEOUT_MS (10 s) — hence 30 s.
  it('9. --apply never writes a store whose lock is held: repo reported, next repo migrated, exit 2', () => {
    const base = makeTmpBase();
    const locked = makeFakeRepo(base, 'repo-locked', [legacyDescriptionLine('id-locked')]);
    const free = makeFakeRepo(base, 'repo-free', [legacyDescriptionLine('id-free')]);
    const lockedStore = join(locked, '.orchestrator', 'metrics', 'learnings.jsonl');
    const before = readFileSync(lockedStore, 'utf8');
    const lockPath = join(realpathSync(dirname(lockedStore)), 'learnings.jsonl.lock');
    const holder = 'test-live-session';
    expect(tryAcquireFileLock(lockPath, { holder }).acquired).toBe(true);
    let result;
    try {
      result = run(['--repos', `${locked},${free}`, '--apply', '--json']);
    } finally {
      releaseFileLock(lockPath, { holder });
    }

    expect(result.status).toBe(2);
    expect(readFileSync(lockedStore, 'utf8')).toBe(before);
    expect(listBackups(locked)).toHaveLength(0);
    const [lockedResult, freeResult] = JSON.parse(result.stdout).repos;
    expect(lockedResult).toMatchObject({ repo: locked, status: 'error' });
    expect(lockedResult.error).toContain('not acquired');
    expect(freeResult.status).toBe('applied');
    expect(readLearnings(free)[0].insight).toBe('legacy description text');
  }, 30_000);
});

describe('run-migrate-v2-cross-repo — I/O errors exit 2 (#1487.15)', () => {
  it('10. a store that cannot be read is reported as error and the run exits 2, not 0', () => {
    // BUG THIS CATCHES: `read failed` / `write failed` set `status: 'error'`
    // but the run ended `process.exit(0)` — only the lock case exited 2,
    // although the header and --help document 2 = I/O error.
    const base = makeTmpBase();
    const bad = makeFakeRepo(base, 'repo-unreadable', [legacyDescriptionLine('id-bad')]);
    const good = makeFakeRepo(base, 'repo-good', [legacyDescriptionLine('id-good')]);
    const store = join(bad, '.orchestrator', 'metrics', 'learnings.jsonl');
    rmSync(store);
    mkdirSync(store); // EISDIR on read
    const result = run(['--repos', `${bad},${good}`, '--json']);

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    const badResult = parsed.repos.find((r) => r.repo === bad);
    expect(badResult).toMatchObject({ status: 'error' });
    expect(badResult.error).toMatch(/read failed/);
    expect(parsed.repos.find((r) => r.repo === good).status).toBe('dry-run');
    expect(result.stderr).toMatch(/I\/O error in 1 repo/);
  });
});
