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
