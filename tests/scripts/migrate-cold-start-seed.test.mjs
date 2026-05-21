/**
 * migrate-cold-start-seed.test.mjs — Tests for scripts/migrate-cold-start-seed.mjs
 *
 * One-shot seeder for the `.orchestrator/welcome-banner-pending` marker
 * (PRD F1.3 / issue #507). Spawns the CLI with `--repos <tmpdir,...>` so
 * tests never touch the 6 real dormant repos.
 *
 * Coverage:
 *   - Default mode is dry-run.
 *   - `--dry-run --apply` mutex (exit 1).
 *   - Per-repo classification: skip-missing, skip-not-bootstrapped,
 *     already-seeded, skip-active, would-seed.
 *   - `--apply` writes zero-byte marker atomically.
 *   - Idempotency: second --apply → all already-seeded, zero writes.
 *   - Unknown flag → exit 1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'migrate-cold-start-seed.mjs');

// ───────────────────────────────────────────────────────────────────────────
// Sandbox + fixture helpers
// ───────────────────────────────────────────────────────────────────────────

let sandbox;

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** Parses the per-repo + summary JSON records from --json stdout. */
function parseJsonLines(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Creates a bootstrapped-but-dormant repo: `.orchestrator/` exists, no marker, no sessions. */
function makeBootstrappedRepo() {
  const dir = mkdtempSync(join(sandbox, 'repo-'));
  mkdirSync(join(dir, '.orchestrator'), { recursive: true });
  return dir;
}

/** Creates a repo whose `.orchestrator/` dir is missing (not-bootstrapped). */
function makeUnbootstrappedRepo() {
  const dir = mkdtempSync(join(sandbox, 'unboot-'));
  // Note: NO .orchestrator/ subdirectory.
  return dir;
}

function seedMarker(repoDir) {
  writeFileSync(join(repoDir, '.orchestrator', 'welcome-banner-pending'), '', 'utf8');
}

function seedActiveSessions(repoDir) {
  const dir = join(repoDir, '.orchestrator', 'metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'sessions.jsonl'),
    '{"session_id":"foo"}\n',
    'utf8',
  );
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mcss-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Arg parsing + mutex guard
// ───────────────────────────────────────────────────────────────────────────

describe('migrate-cold-start-seed — arg parsing', () => {
  it('defaults to dry-run mode when no apply flag is given', async () => {
    const repo = makeBootstrappedRepo();
    const r = runCli(['--repos', repo, '--json']);
    expect(r.status).toBe(0);
    const records = parseJsonLines(r.stdout);
    const summary = records.find((r) => r.kind === 'summary');
    expect(summary.mode).toBe('dry-run');
    // Marker MUST NOT be written in dry-run.
    expect(
      existsSync(join(repo, '.orchestrator', 'welcome-banner-pending')),
    ).toBe(false);
  });

  it('exits 1 when both --dry-run and --apply are passed', async () => {
    const repo = makeBootstrappedRepo();
    const r = runCli(['--dry-run', '--apply', '--repos', repo]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });

  it('exits 1 on unknown flag', async () => {
    const r = runCli(['--bogus-flag']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown flag/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Per-repo classification (dry-run)
// ───────────────────────────────────────────────────────────────────────────

describe('migrate-cold-start-seed — classification', () => {
  it('classifies a non-existent repo path as skip-missing', async () => {
    const missing = join(sandbox, 'definitely-not-a-repo');
    const r = runCli(['--repos', missing, '--json']);
    const records = parseJsonLines(r.stdout);
    const repoRecord = records.find((r) => r.kind === 'repo');
    expect(repoRecord.status).toBe('skip-missing');
    expect(repoRecord.reason).toMatch(/does not exist/);
  });

  it('classifies a repo without .orchestrator/ as skip-not-bootstrapped', async () => {
    const repo = makeUnbootstrappedRepo();
    const r = runCli(['--repos', repo, '--json']);
    const records = parseJsonLines(r.stdout);
    const repoRecord = records.find((r) => r.kind === 'repo');
    expect(repoRecord.status).toBe('skip-not-bootstrapped');
  });

  it('classifies a repo with the marker present as already-seeded', async () => {
    const repo = makeBootstrappedRepo();
    seedMarker(repo);
    const r = runCli(['--repos', repo, '--json']);
    const records = parseJsonLines(r.stdout);
    const repoRecord = records.find((r) => r.kind === 'repo');
    expect(repoRecord.status).toBe('already-seeded');
  });

  it('classifies a repo with non-empty sessions.jsonl as skip-active', async () => {
    const repo = makeBootstrappedRepo();
    seedActiveSessions(repo);
    const r = runCli(['--repos', repo, '--json']);
    const records = parseJsonLines(r.stdout);
    const repoRecord = records.find((r) => r.kind === 'repo');
    expect(repoRecord.status).toBe('skip-active');
    expect(repoRecord.reason).toMatch(/sessions\.jsonl/);
  });

  it('classifies an eligible dormant repo as would-seed in dry-run', async () => {
    const repo = makeBootstrappedRepo();
    const r = runCli(['--repos', repo, '--json']);
    const records = parseJsonLines(r.stdout);
    const repoRecord = records.find((r) => r.kind === 'repo');
    expect(repoRecord.status).toBe('would-seed');
    // Marker still NOT written in dry-run.
    expect(
      existsSync(join(repo, '.orchestrator', 'welcome-banner-pending')),
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// --apply: atomic write + idempotency
// ───────────────────────────────────────────────────────────────────────────

describe('migrate-cold-start-seed — --apply behaviour', () => {
  it('writes a zero-byte marker file when applying to an eligible repo', async () => {
    const repo = makeBootstrappedRepo();
    const r = runCli(['--apply', '--repos', repo, '--json']);
    expect(r.status).toBe(0);

    const records = parseJsonLines(r.stdout);
    const repoRecord = records.find((r) => r.kind === 'repo');
    expect(repoRecord.status).toBe('seeded');

    const markerPath = join(repo, '.orchestrator', 'welcome-banner-pending');
    expect(existsSync(markerPath)).toBe(true);
    expect(statSync(markerPath).size).toBe(0);

    // No leftover tmp file from atomic rename.
    expect(
      readFileSync(markerPath, 'utf8'),
    ).toBe('');
  });

  it('is idempotent: second --apply yields already-seeded and no writes', async () => {
    const repo = makeBootstrappedRepo();

    // First apply → seeded.
    const first = runCli(['--apply', '--repos', repo, '--json']);
    const firstRecords = parseJsonLines(first.stdout);
    expect(firstRecords.find((r) => r.kind === 'repo').status).toBe('seeded');

    // Capture marker mtime to verify no rewrite.
    const markerPath = join(repo, '.orchestrator', 'welcome-banner-pending');
    const mtimeBefore = statSync(markerPath).mtimeMs;

    // Second apply → already-seeded.
    const second = runCli(['--apply', '--repos', repo, '--json']);
    expect(second.status).toBe(0);
    const secondRecords = parseJsonLines(second.stdout);
    expect(
      secondRecords.find((r) => r.kind === 'repo').status,
    ).toBe('already-seeded');
    const summary = secondRecords.find((r) => r.kind === 'summary');
    expect(summary.counts.seeded).toBe(0);
    expect(summary.counts['already-seeded']).toBe(1);

    // Marker file untouched (same mtime).
    expect(statSync(markerPath).mtimeMs).toBe(mtimeBefore);
  });

  it('handles multiple repos in one invocation with per-repo classification', async () => {
    // Mix of all four statuses in a single run validates the loop's
    // classification independence.
    const eligible = makeBootstrappedRepo();
    const seeded = makeBootstrappedRepo();
    seedMarker(seeded);
    const active = makeBootstrappedRepo();
    seedActiveSessions(active);
    const missing = join(sandbox, 'no-such-repo');

    const reposCsv = [eligible, seeded, active, missing].join(',');
    const r = runCli(['--apply', '--repos', reposCsv, '--json']);
    expect(r.status).toBe(0);

    const records = parseJsonLines(r.stdout);
    const repoRecords = records.filter((r) => r.kind === 'repo');
    expect(repoRecords).toHaveLength(4);

    const byPath = Object.fromEntries(
      repoRecords.map((rec) => [rec.repo, rec.status]),
    );
    expect(byPath[eligible]).toBe('seeded');
    expect(byPath[seeded]).toBe('already-seeded');
    expect(byPath[active]).toBe('skip-active');
    expect(byPath[missing]).toBe('skip-missing');

    const summary = records.find((r) => r.kind === 'summary');
    expect(summary.counts.seeded).toBe(1);
    expect(summary.counts['already-seeded']).toBe(1);
    expect(summary.counts['skip-active']).toBe(1);
    expect(summary.counts['skip-missing']).toBe(1);
  });
});
