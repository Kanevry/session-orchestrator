/**
 * tests/telemetry/retention.test.mjs — retention pruning + storage-layer
 * invariants for the ingest server (Epic #841, S5 / GitLab #846; PRD §3-FA4).
 *
 * db.mjs is exercised directly (no HTTP): retention prunes only aged raw rows and
 * never touches aggregates; WAL is asserted ONLY against a real file DB (on
 * `:memory:` the journal_mode pragma reports 'memory', never 'wal').
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openDb,
  closeDb,
  insertRecords,
  countRecords,
  upsertWeeklyAggregate,
  querySummary,
} from '../../server/ingest/db.mjs';
import { pruneOldRecords } from '../../server/ingest/retention.mjs';

/** Build a storage row (as a validator would return). */
function row(overrides = {}) {
  return {
    kind: 'usage-ping',
    schema_version: 1,
    received_day: '2026-07-20',
    anon_id: 'anon-a',
    fleet: 0,
    raw_json: '{}',
    ...overrides,
  };
}

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('retention pruning', () => {
  it('deletes only records older than the retention window and leaves aggregates_weekly untouched', () => {
    const db = openDb(':memory:');
    const fresh = new Date().toISOString().slice(0, 10);

    insertRecords(db, [
      // '2020-01-01' is permanently > 24 months old for any post-2022 clock.
      row({ received_day: '2020-01-01', anon_id: 'old' }),
      row({ received_day: fresh, anon_id: 'new', fleet: 1 }),
    ]);
    upsertWeeklyAggregate(db, {
      week: '2026-W29',
      kind: 'usage-ping',
      metric: 'total',
      valueJson: '{"n":2}',
    });

    const deleted = pruneOldRecords(db, { months: 24 });

    expect(deleted).toBe(1);
    expect(countRecords(db, {})).toBe(1);
    expect(db.prepare('SELECT received_day FROM records').all()).toEqual([{ received_day: fresh }]);
    // Aggregates survive the prune.
    expect(db.prepare('SELECT value_json FROM aggregates_weekly').all()).toEqual([
      { value_json: '{"n":2}' },
    ]);

    closeDb(db);
  });
});

describe('storage layer', () => {
  it('enables WAL journal mode on a file-backed database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ingest-wal-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'records.db');

    const db = openDb(dbPath);
    const jm = db.prepare('PRAGMA journal_mode').get();
    expect(jm.journal_mode).toBe('wal');
    closeDb(db);
  });

  it('reports journal_mode "memory" on an in-memory database (WAL is a no-op there)', () => {
    const db = openDb(':memory:');
    const jm = db.prepare('PRAGMA journal_mode').get();
    expect(jm.journal_mode).toBe('memory');
    closeDb(db);
  });

  it('countRecords filters by kind and lower day bound', () => {
    const db = openDb(':memory:');
    insertRecords(db, [
      row({ received_day: '2026-07-01' }),
      row({ received_day: '2026-07-20' }),
      row({ kind: 'session-eval', received_day: '2026-07-20' }),
    ]);
    expect(countRecords(db, {})).toBe(3);
    expect(countRecords(db, { kind: 'usage-ping' })).toBe(2);
    expect(countRecords(db, { kind: 'usage-ping', sinceDay: '2026-07-10' })).toBe(1);
    closeDb(db);
  });

  it('querySummary aggregates raw_json in JS (shape the Wave-3 digest consumes)', () => {
    const db = openDb(':memory:');
    const mk = (platform, skills, fleet, anon) =>
      row({
        anon_id: anon,
        fleet,
        raw_json: JSON.stringify({
          platform,
          os: 'darwin',
          node_major: 24,
          plugin_version: '3.16.0',
          skills,
          commands: [],
        }),
      });

    insertRecords(db, [
      mk('claude', ['session-start', 'plan'], 1, 'a1'),
      mk('claude', ['session-start'], 0, 'a2'),
      mk('codex', ['plan'], 0, 'a2'), // same anon as above → distinct count = 2
    ]);

    const summary = querySummary(db, { kind: 'usage-ping' });

    expect(summary.total).toBe(3);
    expect(summary.distinctAnonIds).toBe(2);
    expect(summary.byPlatform).toEqual({ claude: 2, codex: 1 });
    expect(summary.byOs).toEqual({ darwin: 3 });
    expect(summary.byNodeMajor).toEqual({ 24: 3 });
    expect(summary.byPluginVersion).toEqual({ '3.16.0': 3 });
    // Tie on count (both 2) → ascending name tie-break: 'plan' before 'session-start'.
    expect(summary.topSkills).toEqual([
      { name: 'plan', count: 2 },
      { name: 'session-start', count: 2 },
    ]);
    expect(summary.fleetVsExternal).toEqual({ fleet: 1, external: 2 });

    closeDb(db);
  });

  it('upsertWeeklyAggregate overwrites on (week, kind, metric) conflict', () => {
    const db = openDb(':memory:');
    upsertWeeklyAggregate(db, { week: '2026-W29', kind: 'usage-ping', metric: 'total', valueJson: '1' });
    upsertWeeklyAggregate(db, { week: '2026-W29', kind: 'usage-ping', metric: 'total', valueJson: '2' });
    expect(db.prepare('SELECT value_json FROM aggregates_weekly').all()).toEqual([{ value_json: '2' }]);
    closeDb(db);
  });
});
