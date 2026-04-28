/**
 * tests/integration/harness-audit.integration.test.mjs
 *
 * Integration tests for scripts/harness-audit.mjs
 *
 * Spawns the real script against a tmpdir copy of the bundled clean-repo
 * fixture. Verifies: exit code, stdout JSON schema, healthy-fixture scores,
 * rubric version pinning, stderr summary, and JSONL append-only behavior.
 *
 * Part of issue #210 (deterministic harness-audit scorecard).
 *
 * Each test copies the fixture to a fresh tmpdir so the in-tree fixture is
 * never mutated. Tests run serially (describe.sequential) to avoid
 * filesystem races. Timeout: 20 s per test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'harness-audit.mjs');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'harness-audit', 'clean-repo');

// Read the RUBRIC_VERSION constant from the source once at test-setup time.
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
const rubricVersionMatch = /const RUBRIC_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(SCRIPT_SOURCE);
const EXPECTED_RUBRIC_VERSION = rubricVersionMatch ? rubricVersionMatch[1] : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Copy the fixture directory to a fresh tmpdir using cp -R (POSIX) or
 * xcopy/robocopy fallback on Windows. Returns the path to the copy.
 *
 * After copying, any stale audit.jsonl in the tmpdir is removed. The script
 * creates this file on every run; if a developer ran harness-audit.mjs
 * directly inside the fixture directory (or a prior test run leaked into it),
 * the copy would have a non-empty audit.jsonl and the JSONL append-count
 * test (test 6) would fail with an unexpected line count. (#222)
 */
function copyFixtureToTmpdir() {
  const dest = mkdtempSync(join(tmpdir(), 'so-harness-audit-test-'));
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    // xcopy preserves directory structure; /E = recurse empty dirs, /I = assume destination is dir
    const result = spawnSync('xcopy', [FIXTURE_DIR, dest, '/E', '/I', '/Q'], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`xcopy failed: ${result.stderr}`);
    }
  } else {
    const result = spawnSync('cp', ['-R', FIXTURE_DIR + '/.', dest], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`cp failed: ${result.stderr}`);
    }
  }

  // Remove stale audit.jsonl if it was accidentally copied from a polluted fixture dir.
  const staleAuditJsonl = join(dest, '.orchestrator', 'metrics', 'audit.jsonl');
  if (existsSync(staleAuditJsonl)) {
    unlinkSync(staleAuditJsonl);
  }

  return dest;
}

/**
 * Run harness-audit.mjs with cwd set to the given root.
 * Returns the spawnSync result.
 *
 * maxBuffer is set to 16 MB to prevent truncation on CI runners where the
 * default pipe buffer (historically as low as 8 KiB in some environments)
 * would silently truncate the audit JSON — which now exceeds 12 KB after
 * the category-split (#285). See issue #222.
 */
function runAudit(cwd) {
  return spawnSync('node', [SCRIPT_PATH], {
    cwd,
    encoding: 'utf8',
    timeout: 18000,
    maxBuffer: 16 * 1024 * 1024, // 16 MB — audit JSON is ~12-50 KB; future-proof
  });
}

/**
 * Parse JSONL text into an array of parsed objects.
 * Skips blank lines.
 */
function parseJsonl(text) {
  return text
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeTmpCopy() {
  const d = copyFixtureToTmpdir();
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.sequential('harness-audit integration tests', { timeout: 20000 }, () => {

  // -------------------------------------------------------------------------
  // 1. Smoke test: exits 0 and stdout parses as JSON
  // -------------------------------------------------------------------------

  it('exits 0 and stdout parses as valid JSON', () => {
    const root = makeTmpCopy();
    const result = runAudit(root);

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 2. Schema validation: top-level keys and categories array
  // -------------------------------------------------------------------------

  it('stdout JSON has correct top-level schema with 7 categories', () => {
    const root = makeTmpCopy();
    const result = runAudit(root);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);

    // Top-level keys
    expect(output).toHaveProperty('rubric_version');
    expect(output).toHaveProperty('started_at');
    expect(output).toHaveProperty('duration_ms');
    expect(output).toHaveProperty('audit_root');
    expect(output).toHaveProperty('harness_version');
    expect(output).toHaveProperty('categories');
    expect(output).toHaveProperty('summary');
    expect(output).toHaveProperty('repository');

    // Note: 'version' is not a top-level key — harness_version is the package version field.
    // repository has branch and head_sha
    expect(output.repository).toHaveProperty('branch');
    expect(output.repository).toHaveProperty('head_sha');

    // categories: exactly 7 entries
    expect(Array.isArray(output.categories)).toBe(true);
    expect(output.categories).toHaveLength(7);

    // Each category has the required fields
    for (const cat of output.categories) {
      expect(typeof cat.name).toBe('string');
      expect(cat.name.length).toBeGreaterThan(0);
      expect(typeof cat.score_0_10).toBe('number');
      expect(cat.score_0_10).toBeGreaterThanOrEqual(0);
      expect(cat.score_0_10).toBeLessThanOrEqual(10);
      expect(Array.isArray(cat.checks)).toBe(true);
      expect(cat.checks.length).toBeGreaterThan(0);
    }

    // summary has required fields
    expect(typeof output.summary.overall_mean_0_10).toBe('number');
    expect(typeof output.summary.overall_band).toBe('string');
    expect(typeof output.summary.checks_passed).toBe('number');
    expect(typeof output.summary.checks_total).toBe('number');
  });

  // -------------------------------------------------------------------------
  // 3. Healthy fixture asserts: clean-repo scores >= 8
  // -------------------------------------------------------------------------

  it('clean-repo fixture scores overall_mean_0_10 >= 8', () => {
    const root = makeTmpCopy();
    const result = runAudit(root);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.summary.overall_mean_0_10).toBeGreaterThanOrEqual(8);
    expect(output.summary.checks_passed).toBeGreaterThanOrEqual(output.summary.checks_total - 2);
  });

  // -------------------------------------------------------------------------
  // 4. Rubric version pinned: matches RUBRIC_VERSION constant in script
  // -------------------------------------------------------------------------

  it('rubric_version in output matches RUBRIC_VERSION constant in script source', () => {
    expect(EXPECTED_RUBRIC_VERSION).not.toBeNull();

    const root = makeTmpCopy();
    const result = runAudit(root);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(output.rubric_version).toBe(EXPECTED_RUBRIC_VERSION);
    expect(output.rubric_version).toBe('2026-05');
  });

  // -------------------------------------------------------------------------
  // 5. Stderr non-empty and contains summary markers
  // -------------------------------------------------------------------------

  it('writes non-empty human-readable summary to stderr containing "OVERALL"', () => {
    const root = makeTmpCopy();
    const result = runAudit(root);

    expect(result.status).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr).toContain('OVERALL');
    // The summary header is always emitted
    expect(result.stderr).toContain('harness-audit summary');
  });

  // -------------------------------------------------------------------------
  // 6. JSONL append behavior: 1 run → 1 line, 2 runs → 2 lines, 3 runs → 3 lines
  // -------------------------------------------------------------------------

  it('appends exactly one JSONL line per run (append-only, never overwrite)', () => {
    const root = makeTmpCopy();
    const jsonlPath = join(root, '.orchestrator', 'metrics', 'audit.jsonl');

    // Run 1 — file may not exist yet or may be empty
    const result1 = runAudit(root);
    expect(result1.status).toBe(0);

    const text1 = readFileSync(jsonlPath, 'utf8');
    const lines1 = parseJsonl(text1);
    expect(lines1).toHaveLength(1);

    // The single JSONL record must parse as JSON and match stdout shape
    const stdout1 = JSON.parse(result1.stdout);
    expect(lines1[0].rubric_version).toBe(stdout1.rubric_version);
    expect(lines1[0].session_id).toBeDefined(); // JSONL record includes session_id
    expect(typeof lines1[0].session_id).toBe('string');

    // Run 2
    const result2 = runAudit(root);
    expect(result2.status).toBe(0);

    const text2 = readFileSync(jsonlPath, 'utf8');
    const lines2 = parseJsonl(text2);
    expect(lines2).toHaveLength(2);

    // Run 3
    const result3 = runAudit(root);
    expect(result3.status).toBe(0);

    const text3 = readFileSync(jsonlPath, 'utf8');
    const lines3 = parseJsonl(text3);
    expect(lines3).toHaveLength(3);

    // All 3 records must be valid JSON with rubric_version
    for (const record of lines3) {
      expect(record.rubric_version).toBe('2026-05');
      expect(typeof record.session_id).toBe('string');
    }
  });

  // -------------------------------------------------------------------------
  // 7. Degraded repo: exit code is still 0 even when STATE.md is removed
  // -------------------------------------------------------------------------

  it('exits 0 even when STATE.md is removed (audit never blocks)', () => {
    const root = makeTmpCopy();

    // Remove STATE.md to degrade the fixture
    const stateMdPath = join(root, '.claude', 'STATE.md');
    expect(existsSync(stateMdPath)).toBe(true);
    rmSync(stateMdPath);
    expect(existsSync(stateMdPath)).toBe(false);

    const result = runAudit(root);

    // The script must always exit 0
    expect(result.status).toBe(0);

    // Output must still be valid JSON
    const output = JSON.parse(result.stdout);
    expect(Array.isArray(output.categories)).toBe(true);
    expect(output.categories).toHaveLength(7);

    // Overall score will be lower since state-md checks fail
    expect(output.summary.overall_mean_0_10).toBeGreaterThanOrEqual(0);
    expect(output.summary.overall_mean_0_10).toBeLessThanOrEqual(10);
  });

  // -------------------------------------------------------------------------
  // 8. JSONL record includes session_id (not present in stdout)
  // -------------------------------------------------------------------------

  it('JSONL record contains session_id but stdout JSON does not', () => {
    const root = makeTmpCopy();
    const jsonlPath = join(root, '.orchestrator', 'metrics', 'audit.jsonl');

    const result = runAudit(root);
    expect(result.status).toBe(0);

    const stdoutObj = JSON.parse(result.stdout);
    expect(stdoutObj).not.toHaveProperty('session_id');

    const jsonlText = readFileSync(jsonlPath, 'utf8');
    const [record] = parseJsonl(jsonlText);
    expect(record).toHaveProperty('session_id');
    expect(typeof record.session_id).toBe('string');
    expect(record.session_id.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 9. started_at is a valid ISO 8601 timestamp
  // -------------------------------------------------------------------------

  it('started_at in stdout is a valid ISO 8601 timestamp', () => {
    const root = makeTmpCopy();
    const result = runAudit(root);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);

    expect(typeof output.started_at).toBe('string');
    const parsed = new Date(output.started_at);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // Must contain 'T' separator (ISO 8601)
    expect(output.started_at).toContain('T');
  });

  // -------------------------------------------------------------------------
  // 10. Category names match the expected 7 categories
  // -------------------------------------------------------------------------

  it('categories array contains the 7 expected category names', () => {
    const root = makeTmpCopy();
    const result = runAudit(root);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);

    const names = output.categories.map((c) => c.name);
    expect(names).toContain('Session Discipline');
    expect(names).toContain('Quality Gate Coverage');
    expect(names).toContain('Hook Integrity');
    expect(names).toContain('Persistence Health');
    expect(names).toContain('Plugin-Root Resolution');
    expect(names).toContain('Config Hygiene');
    expect(names).toContain('Policy Freshness');
  });
});
