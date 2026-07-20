/**
 * tests/telemetry/digest.test.mjs — weekly digest generator for the ingest
 * server (Epic #841, S8 / GitLab #849; PRD §2 (Read path) + §3-FA5).
 *
 * JSON is the SSOT, Markdown is a derived view — both are exercised here.
 * All DB fixtures use `openDb(':memory:')`; the CLI smoke test uses a
 * `mkdtempSync` file-backed DB (the CLI seam requires a real file path).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb, closeDb, insertRecords } from '../../server/ingest/db.mjs';
import { computeWeekRange, buildDigest, renderDigestMarkdown, writeDigestArtifacts } from '../../server/ingest/digest.mjs';

const DIGEST_SCRIPT = fileURLToPath(new URL('../../server/ingest/digest.mjs', import.meta.url));

/** Build a storage row (as a validator would return). */
function row(overrides = {}) {
  return {
    kind: 'usage-ping',
    schema_version: 1,
    received_day: '2026-07-08',
    anon_id: 'anon-a',
    fleet: 0,
    raw_json: JSON.stringify({
      platform: 'claude',
      os: 'darwin',
      node_major: 24,
      plugin_version: '3.16.0',
      skills: ['session-start'],
      commands: ['close'],
    }),
    ...overrides,
  };
}

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('computeWeekRange', () => {
  it('returns the previous completed ISO week for a mid-week date', () => {
    const range = computeWeekRange(new Date('2026-07-15T12:00:00Z'));
    expect(range).toEqual({ week: '2026-W28', fromDay: '2026-07-06', toDay: '2026-07-12' });
  });

  it('crosses the year boundary correctly for a January 1st date', () => {
    const range = computeWeekRange(new Date('2026-01-01T12:00:00Z'));
    expect(range).toEqual({ week: '2025-W52', fromDay: '2025-12-22', toDay: '2025-12-28' });
  });
});

describe('buildDigest', () => {
  const RANGE = { week: '2026-W28', fromDay: '2026-07-06', toDay: '2026-07-12' };

  it('counts only in-range rows in summary.total', () => {
    const db = openDb(':memory:');
    insertRecords(db, [
      row({ received_day: '2026-07-06' }), // in range (lower bound)
      row({ received_day: '2026-07-12', anon_id: 'anon-b' }), // in range (upper bound)
      row({ received_day: '2026-06-30', anon_id: 'anon-c' }), // before range
      row({ received_day: '2026-07-13', anon_id: 'anon-d' }), // after range
    ]);

    const digest = buildDigest(db, RANGE);

    expect(digest.summary.total).toBe(2);
    closeDb(db);
  });

  it('persists every top-level metric into aggregates_weekly under the expected keys', () => {
    const db = openDb(':memory:');
    insertRecords(db, [row({ received_day: '2026-07-08' })]);

    buildDigest(db, RANGE);

    const rows = db
      .prepare('SELECT metric FROM aggregates_weekly WHERE week = ? ORDER BY metric')
      .all(RANGE.week);
    expect(rows.map((r) => r.metric)).toEqual([
      'by_node_major',
      'by_os',
      'by_platform',
      'by_plugin_version',
      'distinct_anon_ids',
      'fleet_vs_external',
      'top_commands',
      'top_skills',
      'total',
    ]);
    closeDb(db);
  });

  it('is idempotent — a second run for the same week upserts, never duplicates', () => {
    const db = openDb(':memory:');
    insertRecords(db, [row({ received_day: '2026-07-08' })]);

    buildDigest(db, RANGE);
    buildDigest(db, RANGE);

    const countRow = db
      .prepare('SELECT COUNT(*) AS c FROM aggregates_weekly WHERE week = ?')
      .get(RANGE.week);
    expect(Number(countRow.c)).toBe(9);
    closeDb(db);
  });
});

describe('renderDigestMarkdown', () => {
  it('includes the week and top skill name but never a raw anon_id', () => {
    const db = openDb(':memory:');
    const plantedAnonId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    insertRecords(db, [
      row({ received_day: '2026-07-08', anon_id: plantedAnonId }),
      row({ received_day: '2026-07-09', anon_id: 'anon-b' }),
    ]);

    const digest = buildDigest(db, { week: '2026-W28', fromDay: '2026-07-06', toDay: '2026-07-12' });
    const md = renderDigestMarkdown(digest);

    expect(md).toContain('2026-W28');
    expect(md).toContain('session-start');
    expect(md).not.toContain(plantedAnonId);
    closeDb(db);
  });
});

describe('writeDigestArtifacts', () => {
  it('writes both artifacts and the JSON round-trips to the same digest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ingest-digest-artifacts-'));
    tmpDirs.push(dir);
    const db = openDb(':memory:');
    insertRecords(db, [row({ received_day: '2026-07-08' })]);
    const digest = buildDigest(db, { week: '2026-W28', fromDay: '2026-07-06', toDay: '2026-07-12' });
    closeDb(db);

    const { jsonPath, mdPath } = writeDigestArtifacts(digest, { outDir: dir });

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toEqual(digest);
  });
});

describe('CLI seam', () => {
  it('exits 0, prints summary JSON, and writes artifacts next to the DB', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ingest-digest-cli-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'records.db');

    const { fromDay } = computeWeekRange();
    const db = openDb(dbPath);
    insertRecords(db, [row({ received_day: fromDay }), row({ received_day: fromDay, anon_id: 'anon-b' })]);
    closeDb(db);

    const result = spawnSync(process.execPath, [DIGEST_SCRIPT, '--db', dbPath], {
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.total).toBe(2);
    expect(existsSync(parsed.jsonPath)).toBe(true);
    expect(existsSync(parsed.mdPath)).toBe(true);
  });

  it('exits 2 with a stderr message when the DB file does not exist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ingest-digest-cli-missing-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'nonexistent.db');

    const result = spawnSync(process.execPath, [DIGEST_SCRIPT, '--db', dbPath], {
      encoding: 'utf8',
      timeout: 10000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('database not found');
  });
});
