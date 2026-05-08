/**
 * tests/scripts/backfill-learnings-expires.test.mjs
 *
 * Vitest suite for scripts/backfill-learnings-expires.mjs (issue #323, W2).
 *
 * Covers: dry-run no-op, --apply patches missing expires_at + creates backup,
 * idempotency, forensic _backfilled_expires_at tag, parse-error counting,
 * missing-source-file exit code, summary JSON shape.
 *
 * Each test creates its own tempdir; tests never run against the real
 * .orchestrator/metrics/learnings.jsonl.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(process.cwd(), 'scripts/backfill-learnings-expires.mjs');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Canonical record WITH expires_at — should pass through untouched. */
const recordWithExpires = (overrides = {}) => ({
  id: 'has-expires-1',
  type: 'recurring-issue',
  subject: 'has-expires',
  insight: 'has expires set',
  evidence: 'evidence text',
  confidence: 0.5,
  source_session: 'sess-1',
  created_at: '2026-04-01T00:00:00Z',
  expires_at: '2026-05-01T00:00:00Z',
  schema_version: 1,
  ...overrides,
});

/** Record MISSING expires_at — should be backfilled. */
const recordMissingExpires = (overrides = {}) => {
  const r = {
    id: 'missing-expires-1',
    type: 'mode-selector-accuracy', // 30d TTL
    subject: 'missing-expires',
    insight: 'missing expires',
    evidence: 'evidence text',
    confidence: 0.5,
    source_session: 'sess-2',
    created_at: '2026-04-01T00:00:00Z',
    schema_version: 1,
    ...overrides,
  };
  // ensure expires_at is absent
  delete r.expires_at;
  return r;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the backfill script. Returns { stdout, stderr, status } (never throws on
 * non-zero exit — caller asserts on status).
 */
function runBackfill(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
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

function writeJsonl(filePath, records) {
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(filePath, body, 'utf8');
}

function readJsonl(filePath) {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { _malformed: l };
      }
    });
}

function listBackups(dir, base) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.bak.`));
}

/** Last line of stdout = summary JSON. */
function parseSummary(stdout) {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  return JSON.parse(lines[lines.length - 1]);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let workdir;
let learningsPath;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), 'backfill-test-'));
  learningsPath = path.join(workdir, 'learnings.jsonl');
});

afterEach(() => {
  if (workdir && existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfill-learnings-expires.mjs — dry-run', () => {
  it('dry-run does NOT write to source file (mtime unchanged) and creates no backup', () => {
    writeJsonl(learningsPath, [recordMissingExpires()]);
    const beforeStat = statSync(learningsPath);
    const beforeContent = readFileSync(learningsPath, 'utf8');

    // Default mode is dry-run when --apply not passed
    const result = runBackfill(['--source', learningsPath]);
    expect(result.status).toBe(0);

    const afterContent = readFileSync(learningsPath, 'utf8');
    expect(afterContent).toBe(beforeContent);

    const afterStat = statSync(learningsPath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    // No .bak file created
    const backups = listBackups(workdir, 'learnings.jsonl');
    expect(backups).toHaveLength(0);

    const summary = parseSummary(result.stdout);
    expect(summary.applied).toBe(false);
    expect(summary.dry_run).toBe(true);
    expect(summary.to_backfill).toBe(1);
  });
});

describe('backfill-learnings-expires.mjs — --apply patches records', () => {
  it('--apply patches a record missing expires_at and emits a backup file', () => {
    writeJsonl(learningsPath, [recordMissingExpires()]);

    const result = runBackfill(['--source', learningsPath, '--apply']);
    expect(result.status).toBe(0);

    // Source file mutated — record now has expires_at
    const records = readJsonl(learningsPath);
    expect(records).toHaveLength(1);
    expect(typeof records[0].expires_at).toBe('string');
    expect(records[0].expires_at.length).toBeGreaterThan(0);

    // Forensic tag
    expect(records[0]._backfilled_expires_at).toBe(true);

    // Backup file emitted at <path>.bak.<isoDate>
    const backups = listBackups(workdir, 'learnings.jsonl');
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/^learnings\.jsonl\.bak\./);

    const summary = parseSummary(result.stdout);
    expect(summary.applied).toBe(true);
    expect(summary.to_backfill).toBe(1);
  });

  it('forensic tag _backfilled_expires_at: true is present on patched records', () => {
    writeJsonl(learningsPath, [
      recordWithExpires({ id: 'has-1' }),
      recordMissingExpires({ id: 'missing-1' }),
    ]);

    runBackfill(['--source', learningsPath, '--apply']);

    const records = readJsonl(learningsPath);
    const hasOne = records.find((r) => r.id === 'has-1');
    const missingOne = records.find((r) => r.id === 'missing-1');

    // Untouched records do NOT get the tag
    expect(hasOne._backfilled_expires_at).toBeUndefined();
    // Patched records DO get the tag
    expect(missingOne._backfilled_expires_at).toBe(true);
  });
});

describe('backfill-learnings-expires.mjs — idempotency', () => {
  it('second --apply on the patched file yields to_backfill: 0 and creates NO new backup', () => {
    writeJsonl(learningsPath, [recordMissingExpires()]);

    // First apply: backfills 1, creates 1 backup
    const first = runBackfill(['--source', learningsPath, '--apply']);
    expect(first.status).toBe(0);
    const firstSummary = parseSummary(first.stdout);
    expect(firstSummary.to_backfill).toBe(1);
    const backupsAfterFirst = listBackups(workdir, 'learnings.jsonl');
    expect(backupsAfterFirst.length).toBe(1);

    // Second apply: nothing to backfill
    const second = runBackfill(['--source', learningsPath, '--apply']);
    expect(second.status).toBe(0);
    const secondSummary = parseSummary(second.stdout);
    expect(secondSummary.to_backfill).toBe(0);
    expect(secondSummary.already_has_expires).toBe(1);

    // No NEW backup created (still 1 total)
    const backupsAfterSecond = listBackups(workdir, 'learnings.jsonl');
    expect(backupsAfterSecond.length).toBe(1);
  });
});

describe('backfill-learnings-expires.mjs — parse-error handling', () => {
  it('counts malformed JSON line in parse_errors and preserves raw line in output', () => {
    // Hand-craft a file with one valid + one malformed + one missing-expires line
    const validHasExpires = JSON.stringify(recordWithExpires({ id: 'valid-1' }));
    const malformed = '{not valid json,,';
    const missingExpires = JSON.stringify(recordMissingExpires({ id: 'patch-me' }));
    writeFileSync(
      learningsPath,
      validHasExpires + '\n' + malformed + '\n' + missingExpires + '\n',
      'utf8'
    );

    const result = runBackfill(['--source', learningsPath, '--apply']);
    expect(result.status).toBe(0);

    const summary = parseSummary(result.stdout);
    expect(summary.parse_errors).toBe(1);
    expect(summary.total).toBe(3);
    expect(summary.to_backfill).toBe(1);
    expect(summary.already_has_expires).toBe(1);

    // Raw malformed line preserved in output, unchanged
    const outputBody = readFileSync(learningsPath, 'utf8');
    expect(outputBody).toContain(malformed);
  });
});

describe('backfill-learnings-expires.mjs — missing source file', () => {
  it('exits with status 1 when source file does not exist', () => {
    const missing = path.join(workdir, 'does-not-exist.jsonl');
    const result = runBackfill(['--source', missing]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source file not found');
  });
});

describe('backfill-learnings-expires.mjs — happy path summary', () => {
  it('summary shows total: 3, already_has_expires: 2, to_backfill: 1', () => {
    writeJsonl(learningsPath, [
      recordWithExpires({ id: 'has-1' }),
      recordWithExpires({ id: 'has-2' }),
      recordMissingExpires({ id: 'missing-1' }),
    ]);

    // Use dry-run so we just inspect summary counts
    const result = runBackfill(['--source', learningsPath]);
    expect(result.status).toBe(0);

    const summary = parseSummary(result.stdout);
    expect(summary.total).toBe(3);
    expect(summary.already_has_expires).toBe(2);
    expect(summary.to_backfill).toBe(1);
    expect(summary.parse_errors).toBe(0);
    expect(summary.dry_run).toBe(true);
    expect(summary.applied).toBe(false);
  });
});
