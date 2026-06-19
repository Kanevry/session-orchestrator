/**
 * v0 recommendation heuristic (issue #272, Epic #271 Phase A).
 *
 * Deterministic three-branch rule. Consumed by session-end Phase 3.7a Writer
 * and (via STATE.md handoff) by session-start Phase 1.5 Reader.
 */

const VALID_MODES = new Set([
  'housekeeping',
  'feature',
  'deep',
  'discovery',
  'evolve',
  'plan-retro',
]);

/**
 * Compute the v0 recommendation for the next session.
 *
 * Rules (evaluated in order, first match wins):
 *   1. completion_rate <  0.50  → plan-retro
 *   2. carryover_ratio ≥ 0.30   → deep
 *   3. otherwise                → feature
 *
 * @param {object} input
 * @param {number} input.completionRate  — 0.00..1.00; share of planned issues closed
 * @param {number} input.carryoverRatio  — 0.00..1.00; carryover / planned (0 when planned=0)
 * @param {Array<number|string>} [input.carryoverIssues] — IDs/IIDs of carried-over issues,
 *   pre-sorted (priority:critical/high first, FIFO tiebreak). Sliced to 0-5 entries for
 *   the `priorities` field.
 * @returns {{mode: string, priorities: number[], rationale: string}}
 */
export function computeV0Recommendation({
  completionRate,
  carryoverRatio,
  carryoverIssues = [],
}) {
  if (typeof completionRate !== 'number' || Number.isNaN(completionRate)) {
    throw new TypeError('completionRate must be a number');
  }
  if (typeof carryoverRatio !== 'number' || Number.isNaN(carryoverRatio)) {
    throw new TypeError('carryoverRatio must be a number');
  }

  const priorities = Array.isArray(carryoverIssues)
    ? carryoverIssues.slice(0, 5).map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
    : [];

  let mode;
  let rationale;
  if (completionRate < 0.5) {
    mode = 'plan-retro';
    rationale = 'v0: completion <50% → retro';
  } else if (carryoverRatio >= 0.3) {
    mode = 'deep';
    rationale = 'v0: carryover ≥30% → deep';
  } else {
    mode = 'feature';
    rationale = 'v0: default clean completion';
  }

  return { mode, priorities, rationale };
}

/**
 * Validate that a recommendation's mode is one of the allowed values.
 * Defensive for Reader-side parsing — unknown modes are rejected rather than
 * silently propagated into Phase B's mode-selector.
 */
export function isValidMode(mode) {
  return typeof mode === 'string' && VALID_MODES.has(mode);
}

// ---------------------------------------------------------------------------
// Dispatcher precursor SUGGESTIONS (#678, PRD §2 P2.4 / line 56, §4 line 244)
// ---------------------------------------------------------------------------

/**
 * Read-only precursor modes the dispatcher MENU may route to (`/discovery`,
 * `/plan`). These are SUGGESTIONS only — never execution-wave modes. The
 * non-execution guardrail lives in mode-selector.mjs (global-max swap excludes
 * these from primary-mode promotion); this set is the source of truth for what
 * the dispatcher is allowed to offer as a precursor.
 * @type {ReadonlyArray<string>}
 */
export const PRECURSOR_MODES = Object.freeze(['discovery', 'plan-retro']);

/**
 * True when `mode` is a read-only precursor (discovery / plan-retro). Mirrors
 * `isNonExecutionMode` in mode-selector/scoring.mjs but kept local so the
 * dispatcher can import suggestion logic without pulling in the scoring graph.
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isPrecursorMode(mode) {
  return typeof mode === 'string' && PRECURSOR_MODES.includes(mode);
}

/**
 * Suggest read-only precursor session-types for the dispatcher menu (#678).
 *
 * Pure, deterministic, additive. NEVER returns an execution mode — only the
 * read-only precursors (`discovery` → /discovery, `plan-retro` → /plan). The
 * dispatcher presents these as optional routes in its owner-confirmation AUQ;
 * they are suggestions, not the executed primary `mode`.
 *
 * Heuristic (both independent — a session may justify both):
 *   - `plan-retro` when there is real carry-forward to plan/retrospect:
 *       completion_rate < 0.5  OR  carryover_ratio ≥ 0.3.
 *   - `discovery` when context/understanding is thin and exploration helps:
 *       no recent sessions (cold start)  OR  an explicit `discoveryHint`.
 *
 * @param {object|null|undefined} signals
 * @param {number} [signals.completionRate]
 * @param {number} [signals.carryoverRatio]
 * @param {Array<unknown>} [signals.recentSessions]
 * @param {boolean} [signals.discoveryHint] — explicit "explore first" hint.
 * @returns {Array<{mode: string, route: string, rationale: string}>}
 *   0–2 entries; deterministic order (plan-retro before discovery when both).
 */
export function suggestPrecursors(signals) {
  if (signals === null || typeof signals !== 'object') {
    return [];
  }

  const completionRate =
    typeof signals.completionRate === 'number' && !Number.isNaN(signals.completionRate)
      ? signals.completionRate
      : null;
  const carryoverRatio =
    typeof signals.carryoverRatio === 'number' && !Number.isNaN(signals.carryoverRatio)
      ? signals.carryoverRatio
      : null;
  const recentSessions = Array.isArray(signals.recentSessions) ? signals.recentSessions : [];

  /** @type {Array<{mode: string, route: string, rationale: string}>} */
  const suggestions = [];

  if ((completionRate !== null && completionRate < 0.5) || (carryoverRatio !== null && carryoverRatio >= 0.3)) {
    suggestions.push({
      mode: 'plan-retro',
      route: '/plan',
      rationale: 'low completion / carryover → plan-retro precursor',
    });
  }

  if (recentSessions.length === 0 || signals.discoveryHint === true) {
    suggestions.push({
      mode: 'discovery',
      route: '/discovery',
      rationale: 'cold start / explore-first hint → discovery precursor',
    });
  }

  return suggestions;
}
