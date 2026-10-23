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
 * Exports: isRealSession, filterRealSessions, tailRealSessions,
 *          isCoordinatorDirectHousekeeping, waveAgentCount,
 *          isCoordinatorDirectWave, normalizeWaveRole
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True when a record represents REAL (non-phantom) work.
 *
 * Fail-open by design: anything that is not explicitly marked `abandoned` or
 * `closed-without-plan` counts as real. Most historical records carry no
 * `status` field at all, and those are genuine sessions — treating "absent" as
 * "abandoned" would discard the majority of the ledger. `closed-without-plan`
 * (#1762) is the 0-wave placeholder `/close` writes when it stops without its
 * own plan: no session ran, so no reader (vault-mirror above all) may render
 * it as one.
 *
 * @param {unknown} record — a parsed sessions.jsonl entry
 * @returns {boolean}
 */
export function isRealSession(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
  return record.status !== 'abandoned' && record.status !== 'closed-without-plan';
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

/**
 * True when a record's waves are ALL coordinator-direct `Housekeeping` waves —
 * the shape the session-end writer rule (#1321) records for a session that ran
 * no dispatched waves. The single definition of that shape: consumers treat such
 * a record as "no waves ran" (eval gate-health) and exclude its 0-agent waves
 * from agents-per-wave ratios.
 *
 * Keys on the wave SHAPE only, never on `session_type`: a housekeeping session
 * that ran real waves is not this shape. Nor on `coordinator_direct` alone —
 * whole multi-wave feature sessions carry it too.
 *
 * @param {unknown} record — a parsed sessions.jsonl entry
 * @returns {boolean} — false for empty/absent `waves`
 */
export function isCoordinatorDirectHousekeeping(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
  const { waves } = record;
  return (
    Array.isArray(waves) &&
    waves.length > 0 &&
    waves.every((w) => w?.role === 'Housekeeping' && w?.coordinator_direct === true)
  );
}

/**
 * A wave's dispatched-agent count, read defensively across the key spellings
 * the ledger holds (`/evolve analyze` effective-sizing, #1652): `agent_count`,
 * else `agents` when it is a number, else the length of `agents` when it is an
 * array (of descriptions), else `agents_dispatched`, else `agent_count_started`
 * / its legacy spelling `agents_started` (the only count some waves carry).
 *
 * @param {unknown} wave — one entry of a record's `waves`
 * @returns {number|null} — null when no key carries a count (unmeasured, never 0)
 */
export function waveAgentCount(wave) {
  if (wave === null || typeof wave !== 'object' || Array.isArray(wave)) return null;
  if (typeof wave.agent_count === 'number') return wave.agent_count;
  if (typeof wave.agents === 'number') return wave.agents;
  if (Array.isArray(wave.agents)) return wave.agents.length;
  if (typeof wave.agents_dispatched === 'number') return wave.agents_dispatched;
  if (typeof wave.agent_count_started === 'number') return wave.agent_count_started;
  if (typeof wave.agents_started === 'number') return wave.agents_started;
  return null;
}

/**
 * True when a wave dispatched no agents — flagged `coordinator_direct: true`,
 * or a measured agent count of 0 without the flag (#1652). The ledger holds
 * 222 unflagged 0-agent waves (2026-10-17, 249 real records); counting them in
 * an agents-per-wave ratio drags the average down with waves no agent ran in.
 * Read side on purpose: it covers the history without rewriting the ledger.
 * An unmeasured count (`waveAgentCount` → null) is not coordinator-direct.
 *
 * @param {unknown} wave — one entry of a record's `waves`
 * @returns {boolean}
 */
export function isCoordinatorDirectWave(wave) {
  if (wave === null || typeof wave !== 'object' || Array.isArray(wave)) return false;
  return wave.coordinator_direct === true || waveAgentCount(wave) === 0;
}

/**
 * Grouping key for a wave role, case- and separator-insensitive (#1652): the
 * ledger spells one role several ways (`Finalization`/`finalization`,
 * `Express-Path`/`Express Path`). Lowercases and collapses runs of spaces,
 * underscores and hyphens to one `-`. Ceiling: distinct words stay distinct —
 * `Express` and `Express-Path` remain two keys; merging synonyms needs an
 * alias table, revisit when a consumer has to report them as one role.
 *
 * @param {unknown} role
 * @returns {string|null} — null for a non-string or blank role
 */
export function normalizeWaveRole(role) {
  if (typeof role !== 'string') return null;
  const key = role.trim().toLowerCase().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
  return key.length > 0 ? key : null;
}
