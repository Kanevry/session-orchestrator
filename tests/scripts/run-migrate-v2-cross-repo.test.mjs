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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'run-migrate-v2-cross-repo.mjs');

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

    // Only our repos should appear, not anything from ROLLOUT_REPOS
    expect(output).toContain('repo-override-a');
    expect(output).toContain('repo-override-b');

    // The output should NOT mention any ROLLOUT_REPOS names
    expect(output).not.toContain('launchpad-ai-factory');
    expect(output).not.toContain('Codex-Hackathon');

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

    // Aggregate shape
    expect(typeof parsed.aggregate.totalRecords).toBe('number');
    expect(typeof parsed.aggregate.totalFixedByV2).toBe('number');
    expect(typeof parsed.aggregate.totalStillInvalidPost).toBe('number');
    expect(parsed.aggregate.totalFixedByV2).toBe(1);
    expect(parsed.aggregate.totalReposSkipped).toBe(1);
  });
});
