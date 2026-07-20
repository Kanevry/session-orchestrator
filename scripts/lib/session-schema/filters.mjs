/**
 * session-schema/filters.mjs — abandoned-aware session filters (#834).
 *
 * Pure functions. Stdlib only. No imports from siblings or parent barrel
 * (matches the Option 1 submodule-isolation convention of the other
 * session-schema/* modules).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `.orchestrator/metrics/sessions.jsonl` holds two kinds of record:
 *
 *   REAL      — a session that actually ran waves and produced work.
 *   ABANDONED — a phantom stub written by session-close-backfill from
 *               events.jsonl for a session that ended without a real close
 *               (0 waves, 0 agents, often seconds of runtime). The canonical
 *               marker is `status: 'abandoned'`.
 *
 * Phantoms are legitimate DATA (they record that a start happened), but they
 * are not legitimate SIGNAL. A consumer that takes "the last N lines" of the
 * ledger as "the last N sessions" silently shrinks its own analysis window by
 * however many stubs happen to sit in the tail. Observed in this repo at the
 * time of writing: 20 of 70 records abandoned (28.6%), and 6 of the last 10
 * LINES were phantoms — so a `slice(-10)` window carried only 4 real sessions.
 *
 * `scripts/lib/eval/session-resolve.mjs` already filtered correctly and is the
 * behavioural reference; this module generalizes that single inline check so
 * the other consumers stop hand-rolling it (or, more commonly, omitting it).
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * Not every reader SHOULD filter. Collision-avoidance id scans, ledger-touch
 * staleness banners, lifetime "sessions ever" counters, peer-overlap windows,
 * schema migrations and dedup checks all legitimately need the phantoms. Use
 * these helpers only where the window is meant to represent REAL WORK.
 *
 * Exports: isRealSession, filterRealSessions, tailRealSessions
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True when a record represents REAL (non-phantom) work.
 *
 * Fail-open by design: anything that is not explicitly marked abandoned counts
 * as real. Most historical records carry no `status` field at all, and those
 * are genuine sessions — treating "absent" as "abandoned" would discard the
 * majority of the ledger.
 *
 * @param {unknown} record — a parsed sessions.jsonl entry
 * @returns {boolean}
 */
export function isRealSession(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
  return record.status !== 'abandoned';
}

/**
 * Filter parsed records to REAL sessions, preserving source order.
 *
 * @param {unknown} records — array of parsed sessions.jsonl entries
 * @returns {object[]} — never null; a non-array input yields []
 */
export function filterRealSessions(records) {
  if (!Array.isArray(records)) return [];
  return records.filter(isRealSession);
}

/**
 * Last N REAL sessions — the correct replacement for `arr.slice(-N)` on an
 * unfiltered array.
 *
 * The semantic this fixes: `slice(-N)` means "last N LINES", which is only
 * the same as "last N SESSIONS" when no phantom stubs sit in the tail.
 *
 * A non-positive or non-finite `n` yields [] rather than surprising the caller
 * with JS's negative-index slice semantics.
 *
 * @param {unknown} records — array of parsed sessions.jsonl entries
 * @param {number} n — how many REAL sessions to return from the tail
 * @returns {object[]}
 */
export function tailRealSessions(records, n) {
  const real = filterRealSessions(records);
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return [];
  return real.slice(-Math.floor(n));
}
