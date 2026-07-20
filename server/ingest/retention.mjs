/**
 * server/ingest/retention.mjs — raw-record retention pruning for the ingest
 * server (Epic #841, S5 / GitLab #846; PRD §3-FA4).
 *
 * Deletes raw `records` older than the retention window (default 24 months).
 * The `aggregates_weekly` table is DELIBERATELY untouched: aggregates are the
 * long-lived derived value; only the raw per-record rows expire.
 *
 * CLI seam: run directly (`node server/ingest/retention.mjs`) to prune the
 * configured DB once and print `{"deleted":N}` as JSON.
 */

import { pathToFileURL } from 'node:url';
import { resolveConfig } from './config.mjs';
import { openDb, closeDb } from './db.mjs';

/**
 * Delete raw records older than `months`. The bound is server-relative
 * (`date('now', '-N months')`), evaluated by SQLite. `months` originates from
 * config (an integer we control), and is bound as a parameter — never
 * string-interpolated into SQL.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ months?: number }} [opts]
 * @returns {number} rows deleted
 */
export function pruneOldRecords(db, { months = 24 } = {}) {
  const stmt = db.prepare("DELETE FROM records WHERE received_day < date('now', ?)");
  const r = stmt.run(`-${months} months`);
  return Number(r.changes);
}

/**
 * Prune once at boot, then on a fixed interval. The interval timer is
 * `.unref()`'d so it never keeps the process alive. Prune errors on the timer
 * path are swallowed (a transient lock must not crash the server).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ months?: number, intervalMs?: number }} [opts]
 * @returns {NodeJS.Timeout}
 */
export function scheduleRetention(db, { months = 24, intervalMs = 86400000 } = {}) {
  pruneOldRecords(db, { months });
  const timer = setInterval(() => {
    try {
      pruneOldRecords(db, { months });
    } catch {
      /* transient lock / busy — retried next interval */
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// CLI seam
// ---------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = resolveConfig();
  const db = openDb(config.dbPath);
  const deleted = pruneOldRecords(db, { months: config.retentionMonths });
  closeDb(db);
  process.stdout.write(`${JSON.stringify({ deleted })}\n`);
  process.exit(0);
}
