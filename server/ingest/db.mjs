/**
 * server/ingest/db.mjs — the ONLY module that imports node:sqlite (Epic #841,
 * S5 / GitLab #846; PRD §3-FA4). Isolating the driver here is the fallback seam:
 * if node:sqlite maturity ever forces a swap to better-sqlite3 (SEC-020 already
 * allowlisted), only this file changes — every signature below is fixed and the
 * Wave-3 digest module (digest.mjs) builds against them unchanged.
 *
 * node:sqlite runs flag-free on Node 24 (verified live in Wave 1).
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * The node:sqlite handle type. Aliased once here so the driver-swap seam (see
 * module header) has a single import to retype if better-sqlite3 ever replaces
 * node:sqlite.
 * @typedef {import('node:sqlite').DatabaseSync} Db
 */

/**
 * Open (or create) the records database.
 *
 * The `timeout: 5000` option is MANDATORY: the DatabaseSync default is 0, which
 * surfaces an immediate SQLITE_BUSY on any lock contention (Wave-1 research).
 * Pragmas are applied idempotently on every open; `auto_vacuum=INCREMENTAL` MUST
 * run BEFORE any table is created (it cannot be enabled on an existing table
 * without a full VACUUM — Wave-1 research), so it precedes the DDL. On a
 * `:memory:` database `journal_mode=WAL` is a documented no-op (reports 'memory').
 *
 * @param {string} dbPath — filesystem path or ':memory:'.
 * @returns {Db}
 */
export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      kind           TEXT    NOT NULL,
      schema_version INTEGER NOT NULL,
      received_day   TEXT    NOT NULL,
      anon_id        TEXT    NOT NULL,
      fleet          INTEGER NOT NULL,
      raw_json       TEXT    NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_records_kind_day ON records(kind, received_day)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS aggregates_weekly (
      week       TEXT,
      kind       TEXT,
      metric     TEXT,
      value_json TEXT,
      PRIMARY KEY (week, kind, metric)
    )
  `);

  return db;
}

const INSERT_SQL =
  'INSERT INTO records (kind, schema_version, received_day, anon_id, fleet, raw_json) VALUES (?, ?, ?, ?, ?, ?)';

/**
 * Insert many storage rows in ONE transaction (all-or-nothing): a failure on
 * any row rolls the whole batch back, so the endpoint never persists a partial
 * batch.
 * @param {Db} db
 * @param {Array<object>} rows
 * @returns {number} rows inserted
 */
export function insertRecords(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const stmt = db.prepare(INSERT_SQL);
  db.exec('BEGIN');
  try {
    let count = 0;
    for (const row of rows) {
      stmt.run(row.kind, row.schema_version, row.received_day, row.anon_id, row.fleet, row.raw_json);
      count++;
    }
    db.exec('COMMIT');
    return count;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Count records, optionally filtered by kind and/or a lower day bound.
 * @param {Db} db
 * @param {{ kind?: string, sinceDay?: string }} [filter]
 * @returns {number}
 */
export function countRecords(db, { kind, sinceDay } = {}) {
  let sql = 'SELECT COUNT(*) AS c FROM records WHERE 1 = 1';
  const params = [];
  if (kind !== undefined) {
    sql += ' AND kind = ?';
    params.push(kind);
  }
  if (sinceDay !== undefined) {
    sql += ' AND received_day >= ?';
    params.push(sinceDay);
  }
  const row = db.prepare(sql).get(...params);
  return Number(row.c);
}

/**
 * Increment a counter map in place.
 * @param {Record<string, number>} map
 * @param {string} key
 */
function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/**
 * Turn a `{ name: count }` map into a descending-by-count array of
 * `{ name, count }` (name as the tie-break for stable output).
 * @param {Record<string, number>} map
 * @returns {Array<{ name: string, count: number }>}
 */
function toRanked(map) {
  return Object.entries(map)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
}

/**
 * Aggregate a kind's records into a summary (Wave-3 digest input). Aggregation
 * happens in JS over the raw_json column — no SQLite JSON1 dependency, keeping
 * the driver-swap seam clean.
 *
 * @param {Db} db
 * @param {{ kind?: string, fromDay?: string, toDay?: string }} [filter]
 * @returns {{
 *   total: number,
 *   distinctAnonIds: number,
 *   byPlatform: Record<string, number>,
 *   byOs: Record<string, number>,
 *   byNodeMajor: Record<string, number>,
 *   byPluginVersion: Record<string, number>,
 *   topSkills: Array<{ name: string, count: number }>,
 *   topCommands: Array<{ name: string, count: number }>,
 *   fleetVsExternal: { fleet: number, external: number },
 * }}
 */
export function querySummary(db, { kind = 'usage-ping', fromDay, toDay } = {}) {
  let sql = 'SELECT raw_json, anon_id, fleet FROM records WHERE kind = ?';
  const params = [kind];
  if (fromDay !== undefined) {
    sql += ' AND received_day >= ?';
    params.push(fromDay);
  }
  if (toDay !== undefined) {
    sql += ' AND received_day <= ?';
    params.push(toDay);
  }
  const rows = db.prepare(sql).all(...params);

  const anonIds = new Set();
  const byPlatform = {};
  const byOs = {};
  const byNodeMajor = {};
  const byPluginVersion = {};
  const skillCounts = {};
  const commandCounts = {};
  let fleet = 0;
  let external = 0;

  for (const row of rows) {
    if (row.anon_id) anonIds.add(row.anon_id);
    if (Number(row.fleet) === 1) fleet++;
    else external++;

    let rec;
    try {
      rec = JSON.parse(row.raw_json);
    } catch {
      continue;
    }
    if (rec.platform) bump(byPlatform, rec.platform);
    if (rec.os) bump(byOs, rec.os);
    if (rec.node_major !== undefined && rec.node_major !== null) bump(byNodeMajor, String(rec.node_major));
    if (rec.plugin_version) bump(byPluginVersion, rec.plugin_version);
    if (Array.isArray(rec.skills)) for (const s of rec.skills) bump(skillCounts, s);
    if (Array.isArray(rec.commands)) for (const c of rec.commands) bump(commandCounts, c);
  }

  return {
    total: rows.length,
    distinctAnonIds: anonIds.size,
    byPlatform,
    byOs,
    byNodeMajor,
    byPluginVersion,
    topSkills: toRanked(skillCounts),
    topCommands: toRanked(commandCounts),
    fleetVsExternal: { fleet, external },
  };
}

/**
 * Upsert a weekly aggregate row (idempotent by (week, kind, metric)).
 * @param {Db} db
 * @param {{ week: string, kind: string, metric: string, valueJson: string }} entry
 */
export function upsertWeeklyAggregate(db, { week, kind, metric, valueJson }) {
  const stmt = db.prepare(
    'INSERT INTO aggregates_weekly (week, kind, metric, value_json) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (week, kind, metric) DO UPDATE SET value_json = excluded.value_json',
  );
  stmt.run(week, kind, metric, valueJson);
}

/**
 * Close the database handle.
 * @param {Db} db
 */
export function closeDb(db) {
  db.close();
}
