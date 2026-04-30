/**
 * autopilot-effectiveness.mjs — /evolve type 8 analyzer (issue #298).
 *
 * Type 8: autopilot-effectiveness — compares manual vs autopilot effectiveness
 * per session mode (housekeeping / feature / deep). Surfaces a learning per
 * mode once enough paired runs accumulate to make the comparison statistically
 * useful.
 *
 * DATA-GATING (intentional): the analyzer returns [] until at least
 * `minPairedRuns` (default 20) sessions of EACH variant (manual + autopilot)
 * exist for a given mode. This keeps the skeleton inert through the early
 * autopilot rollout while wiring lives end-to-end. Once data accumulates the
 * function activates without any further code change.
 *
 * Manual vs. autopilot is determined by the presence of an `autopilot_run_id`
 * field on the session record (written by `scripts/autopilot.mjs` for every
 * session it spawns). Sessions without that field are treated as manual.
 *
 * Existing analyzer types (1-7) for reference: fragile-file, effective-sizing,
 * recurring-issue, scope-guidance, deviation-pattern, stagnation-class-frequency,
 * hardware-pattern. This module adds type 8 to the family.
 *
 * Contract: pure, no-throw, ES module, zero external deps. Mirrors the style of
 * `scripts/lib/hardware-pattern-detector.mjs` (issue #171 / C2).
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default data-gating threshold per mode (manual AND autopilot side). */
export const DEFAULT_MIN_PAIRED_RUNS = 20;

/** Modes recognised by mode-selector / autopilot. */
export const KNOWN_MODES = Object.freeze(['housekeeping', 'feature', 'deep']);

/** Initial confidence — lifecycle (decay/boost) handled by evolve infrastructure. */
const INITIAL_CONFIDENCE = 0.5;

/** Learning lifetime: 90 days from emit. */
const EXPIRY_DAYS = 90;

// ---------------------------------------------------------------------------
// Defensive helpers
// ---------------------------------------------------------------------------

/** Safe number coercion. Returns null for non-finite inputs. */
function num(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

/** Round to 3 decimals for stable evidence shape (no float noise). */
function round3(v) {
  if (v === null || v === undefined) return null;
  return Math.round(v * 1000) / 1000;
}

/** ISO-8601 string for `now + N days`. */
function isoPlusDays(nowIso, days) {
  try {
    const t = new Date(nowIso).getTime();
    if (!Number.isFinite(t)) return new Date(Date.now() + days * 86400e3).toISOString();
    return new Date(t + days * 86400e3).toISOString();
  } catch {
    return new Date(Date.now() + days * 86400e3).toISOString();
  }
}

/**
 * Extract a completion ratio from a session record. Sessions encode this in a
 * few historically-evolved shapes; we tolerate all of them and fall back to
 * `null` (excluded from the average) when nothing usable is present.
 *
 * @param {object} s
 * @returns {number|null} ratio in [0, 1], or null when unknown
 */
function completionOf(s) {
  if (!s || typeof s !== 'object') return null;
  // Direct ratio fields
  const direct = num(s.completion_rate ?? s.completion_ratio);
  if (direct !== null && direct >= 0 && direct <= 1) return direct;
  // Planned vs completed counts
  const planned = num(s.planned_count ?? s.tasks_planned);
  const completed = num(s.completed_count ?? s.tasks_completed);
  if (planned !== null && completed !== null && planned > 0) {
    return Math.max(0, Math.min(1, completed / planned));
  }
  return null;
}

/**
 * Extract a carryover ratio from a session record. Carryover = work not closed
 * within the session that flowed to a follow-up. Same tolerance pattern as
 * `completionOf`.
 *
 * @param {object} s
 * @returns {number|null} ratio in [0, 1], or null when unknown
 */
function carryoverOf(s) {
  if (!s || typeof s !== 'object') return null;
  const direct = num(s.carryover_ratio ?? s.carryover_rate);
  if (direct !== null && direct >= 0 && direct <= 1) return direct;
  const planned = num(s.planned_count ?? s.tasks_planned);
  const carried = num(s.carryover_count ?? s.tasks_carried_over);
  if (planned !== null && carried !== null && planned > 0) {
    return Math.max(0, Math.min(1, carried / planned));
  }
  return null;
}

/** Mean of an array of numbers, ignoring null/undefined. Returns null when empty. */
function mean(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group sessions by mode and split into manual vs. autopilot variants.
 * A session is "autopilot" when it carries an `autopilot_run_id` field (added
 * by scripts/autopilot.mjs for every spawned wave), "manual" otherwise.
 *
 * The `autopilotRuns` array is accepted for symmetry with the public `analyze`
 * signature and to allow future per-run filtering (e.g., only count sessions
 * whose autopilot_run_id matches a known run). For the skeleton it is used
 * only as a non-emptiness signal.
 *
 * @param {Array} autopilotRuns
 * @param {Array} sessions
 * @returns {Map<string, {n_manual:number, n_autopilot:number,
 *   completion_rate_manual:number|null, completion_rate_autopilot:number|null,
 *   carryover_ratio_manual:number|null, carryover_ratio_autopilot:number|null}>}
 */
export function groupByMode(autopilotRuns, sessions) {
  const out = new Map();
  if (!Array.isArray(sessions) || sessions.length === 0) return out;

  // Optional: known autopilot_run_id set for stricter pairing. Empty set means
  // accept any session with a non-empty autopilot_run_id field.
  const knownRunIds = new Set();
  if (Array.isArray(autopilotRuns)) {
    for (const r of autopilotRuns) {
      if (r && typeof r === 'object') {
        const id = r.autopilot_run_id ?? r.run_id ?? r.id;
        if (typeof id === 'string' && id.length > 0) knownRunIds.add(id);
      }
    }
  }

  // Bucket: mode → {manual: [], autopilot: []}
  const buckets = new Map();
  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    const mode = typeof s.mode === 'string' ? s.mode : null;
    if (!mode) continue;
    const apId = typeof s.autopilot_run_id === 'string' ? s.autopilot_run_id : null;
    const isAutopilot =
      apId !== null && apId.length > 0 && (knownRunIds.size === 0 || knownRunIds.has(apId));
    const variant = isAutopilot ? 'autopilot' : 'manual';
    if (!buckets.has(mode)) buckets.set(mode, { manual: [], autopilot: [] });
    buckets.get(mode)[variant].push(s);
  }

  for (const [mode, { manual, autopilot }] of buckets) {
    out.set(mode, {
      n_manual: manual.length,
      n_autopilot: autopilot.length,
      completion_rate_manual: round3(mean(manual.map(completionOf))),
      completion_rate_autopilot: round3(mean(autopilot.map(completionOf))),
      carryover_ratio_manual: round3(mean(manual.map(carryoverOf))),
      carryover_ratio_autopilot: round3(mean(autopilot.map(carryoverOf))),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Learning record builder
// ---------------------------------------------------------------------------

/**
 * Build a canonical schema_version:1 learning record for a single mode.
 * Subject form: `<mode>-manual-vs-autopilot`. Insight is human-readable.
 *
 * @param {string} mode
 * @param {object} stats — output of `groupByMode().get(mode)`
 * @param {string} nowIso
 * @returns {object} learning record
 */
export function buildLearning(mode, stats, nowIso) {
  const cm = stats.completion_rate_manual;
  const ca = stats.completion_rate_autopilot;
  const km = stats.carryover_ratio_manual;
  const ka = stats.carryover_ratio_autopilot;

  const completionDelta = cm !== null && ca !== null ? round3(ca - cm) : null;
  const carryoverDelta = km !== null && ka !== null ? round3(ka - km) : null;

  const parts = [];
  if (completionDelta !== null) {
    const dir = completionDelta > 0 ? 'higher' : completionDelta < 0 ? 'lower' : 'matched';
    parts.push(`autopilot completion ${dir} by ${Math.abs(completionDelta)} (${ca} vs ${cm})`);
  }
  if (carryoverDelta !== null) {
    const dir = carryoverDelta > 0 ? 'more' : carryoverDelta < 0 ? 'less' : 'equal';
    parts.push(`carryover ${dir} (${ka} vs ${km})`);
  }
  const insight =
    parts.length > 0
      ? `Mode '${mode}': ${parts.join('; ')} across ${stats.n_manual} manual + ${stats.n_autopilot} autopilot runs.`
      : `Mode '${mode}': insufficient effectiveness data despite ${stats.n_manual}+${stats.n_autopilot} paired runs.`;

  const sourceSession = `evolve-${nowIso.slice(0, 10)}`;

  return {
    schema_version: 1,
    id: randomUUID(),
    type: 'autopilot-effectiveness',
    subject: `${mode}-manual-vs-autopilot`,
    insight,
    evidence: {
      mode,
      n_manual: stats.n_manual,
      n_autopilot: stats.n_autopilot,
      completion_rate_manual: cm,
      completion_rate_autopilot: ca,
      carryover_ratio_manual: km,
      carryover_ratio_autopilot: ka,
      completion_delta: completionDelta,
      carryover_delta: carryoverDelta,
    },
    confidence: INITIAL_CONFIDENCE,
    source_session: sourceSession,
    created_at: nowIso,
    expires_at: isoPlusDays(nowIso, EXPIRY_DAYS),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Analyze paired manual + autopilot runs and emit `autopilot-effectiveness`
 * learnings — one per qualifying mode. Returns `[]` until the data-gating
 * threshold is met (default: 20 paired runs per mode).
 *
 * Never throws. Defensive against malformed entries.
 *
 * @param {Array} autopilotRuns — entries from .orchestrator/metrics/autopilot.jsonl
 * @param {Array} sessions      — entries from .orchestrator/metrics/sessions.jsonl
 * @param {object} [opts]
 * @param {number} [opts.minPairedRuns=20] — min(n_manual, n_autopilot) per mode
 * @param {string} [opts.now] — ISO 8601 timestamp for created_at (testable)
 * @returns {Array<object>} learning records (empty until threshold met)
 */
export function analyze(autopilotRuns, sessions, opts = {}) {
  const minPairedRuns = Number.isFinite(opts.minPairedRuns)
    ? opts.minPairedRuns
    : DEFAULT_MIN_PAIRED_RUNS;
  const now = typeof opts.now === 'string' && opts.now.length > 0
    ? opts.now
    : new Date().toISOString();

  if (!Array.isArray(autopilotRuns) || autopilotRuns.length === 0) return [];
  if (!Array.isArray(sessions) || sessions.length === 0) return [];

  let grouped;
  try {
    grouped = groupByMode(autopilotRuns, sessions);
  } catch {
    return [];
  }
  if (!grouped || grouped.size === 0) return [];

  const learnings = [];
  for (const [mode, stats] of grouped) {
    if (Math.min(stats.n_manual, stats.n_autopilot) < minPairedRuns) continue;
    try {
      learnings.push(buildLearning(mode, stats, now));
    } catch {
      // Skip a single failed mode rather than collapsing the whole analysis.
    }
  }
  return learnings;
}
