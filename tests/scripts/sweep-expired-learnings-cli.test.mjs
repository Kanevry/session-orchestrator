/**
 * tests/scripts/sweep-expired-learnings-cli.test.mjs
 *
 * Vitest suite for scripts/sweep-expired-learnings.mjs (Epic #723 B4).
 *
 * Covers: default dry-run no-op, --apply archives + rewrites + backs up,
 * --json summary shape, human-readable default output, --grace-days
 * override, --file/--archive path overrides, missing-store graceful exit,
 * --help, and usage errors (unknown flag, bad --grace-days value).
 *
 * Each test creates its own tempdir; never touches the real
 * .orchestrator/metrics/learnings.jsonl.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(process.cwd(), 'scripts/sweep-expired-learnings.mjs');
const DAY_MS = 86_400_000;

function learning(overrides = {}) {
  return {
    id: 'id-1',
    type: 'recurring-issue',
    subject: 'subject',
    insight: 'insight text',
    evidence: 'evidence text',
    confidence: 0.6,
    source_session: 'sess-1',
    created_at: new Date(Date.now() - 100 * DAY_MS).toISOString(),
    expires_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    schema_version: 1,
    ...overrides,
  };
}

function writeJsonl(filePath, entries) {
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Run the CLI. Returns { stdout, stderr, status } (never throws on non-zero exit). */
function runSweep(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString?.() ?? ''),
      stderr: typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString?.() ?? ''),
      status: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

let workdir;
let learningsPath;
let archivePath;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), 'sweep-cli-'));
  learningsPath = path.join(workdir, 'learnings.jsonl');
  archivePath = path.join(workdir, 'learnings-archive.jsonl');
});

afterEach(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Default (dry-run)
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — default dry-run', () => {
  it('with no flags, writes nothing and reports human-readable dry_run=true', () => {
    const oldExpired = learning({ expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString() });
    writeJsonl(learningsPath, [oldExpired]);
    const before = readFileSync(learningsPath, 'utf8');

    const result = runSweep(['--file', learningsPath, '--archive', archivePath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry_run=true');
    expect(result.stdout).toContain('archived=1');

    expect(readFileSync(learningsPath, 'utf8')).toBe(before);
    expect(existsSync(archivePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --apply
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — --apply', () => {
  it('archives stale-expired entries, rewrites the store, and creates a .bak backup', () => {
    const keep = learning({ id: 'keep-me', expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString() });
    const archive = learning({
      id: 'archive-me',
      expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    });
    writeJsonl(learningsPath, [keep, archive]);

    const result = runSweep(['--file', learningsPath, '--archive', archivePath, '--apply']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry_run=false');

    const remaining = readJsonl(learningsPath);
    expect(remaining.map((e) => e.id)).toEqual(['keep-me']);

    const archived = readJsonl(archivePath);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('archive-me');
    expect(archived[0]._archive_reason).toBe('expired');

    const backups = readdirSync(workdir).filter((f) => f.startsWith('learnings.jsonl.bak-'));
    expect(backups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// --json summary shape
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — --json', () => {
  it('emits a single JSON summary line with the documented field shape', () => {
    const oldExpired = learning({ expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString() });
    writeJsonl(learningsPath, [oldExpired]);

    const result = runSweep(['--file', learningsPath, '--archive', archivePath, '--json']);
    expect(result.status).toBe(0);

    const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const summary = JSON.parse(lines[0]);
    expect(summary).toEqual({
      file: learningsPath,
      grace_days: 14,
      scanned: 1,
      kept: 0,
      archived: 1,
      dryRun: true,
      archivePath,
    });
  });
});

// ---------------------------------------------------------------------------
// --grace-days override
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — --grace-days', () => {
  it('--grace-days 0 archives an entry that just barely expired', () => {
    const justExpired = learning({ expires_at: new Date(Date.now() - 1000).toISOString() }); // 1s ago
    writeJsonl(learningsPath, [justExpired]);

    const result = runSweep([
      '--file',
      learningsPath,
      '--archive',
      archivePath,
      '--grace-days',
      '0',
      '--json',
    ]);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary.grace_days).toBe(0);
    expect(summary.archived).toBe(1);
  });

  it('rejects a negative --grace-days value with exit code 1', () => {
    writeJsonl(learningsPath, [learning()]);
    const result = runSweep(['--file', learningsPath, '--archive', archivePath, '--grace-days', '-5']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--grace-days');
  });
});

// ---------------------------------------------------------------------------
// Missing store
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — missing store', () => {
  it('exits 0 with zeroed counts when the store file does not exist', () => {
    const missing = path.join(workdir, 'does-not-exist.jsonl');
    const result = runSweep(['--file', missing, '--archive', archivePath, '--apply', '--json']);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary.scanned).toBe(0);
    expect(summary.kept).toBe(0);
    expect(summary.archived).toBe(0);
    expect(existsSync(archivePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe('sweep-expired-learnings.mjs — usage', () => {
  it('--help prints usage and exits 0', () => {
    const result = runSweep(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: node scripts/sweep-expired-learnings.mjs');
  });

  it('an unknown flag exits with status 1', () => {
    const result = runSweep(['--bogus-flag']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown argument');
  });
});
