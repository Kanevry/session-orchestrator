/**
 * Context-pressure signal computation (#332).
 *
 * Extracted from scripts/lib/mode-selector.mjs (issue #358).
 * Pure function: no I/O, no side effects.
 *
 * Per W1 D3 risk warning, scorer split deferred; only `computeContextPressure`
 * extracted this session.
 */

// ---------------------------------------------------------------------------
// Local helpers (inlined — clamp/round2/safeArray are <5 lines each and are
// also used by the parent mode-selector.mjs; inlining avoids a circular import
// or a shared-helper re-export).
// ---------------------------------------------------------------------------

/**
 * Clamp a number to [min, max].
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Round to 2 decimal places (avoids floating-point drift in comparisons).
 * @param {number} v
 * @returns {number}
 */
function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Safely coerce to an array (returns [] for non-arrays, null, undefined).
 * @param {unknown} v
 * @returns {any[]}
 */
function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

/**
 * Regex for cross-cutting keyword detection in task description text.
 * Matches phrases that indicate large, scope-spanning work.
 */
const CROSS_CUTTING_PATTERN =
  /across all|every (skill|agent|repo)|repo-?wide|cross-cutting|rename across|massive refactor/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ContextPressureComponents
 * @property {number} scope - Scope component contribution (0.0–0.5).
 * @property {number} keywords - Cross-cutting keyword component contribution (0 or 0.25).
 * @property {number} carryover - Carryover component contribution (0.0–0.25).
 */

/**
 * @typedef {Object} ContextPressureResult
 * @property {number} score - Aggregate pressure score 0.0–1.0.
 * @property {ContextPressureComponents} components - Per-component breakdown.
 * @property {'low'|'medium'|'high'} level - Bucketed level from score.
 */

/**
 * Compute context-pressure score (0.0–1.0) for the proposed work.
 * High pressure → recommend deferring scope or preferring deep mode over feature.
 *
 * Inputs (read from signals):
 *   - signals.topPriorities: number[]|undefined — count used as proxy for scope
 *   - signals.recentSessions: array — tail-5 used to derive carryover_ratio from
 *       session.effectiveness.carryover / session.effectiveness.planned_issues
 *   - signals.taskDescriptionText: string|undefined — joined PRD/issue body for keyword scan
 *
 * Score components (additive, clamped to [0, 1]):
 *   - scope:    min(0.5, max(0, (priorityCount - 3) / 10))
 *   - keywords: +0.25 if CROSS_CUTTING_PATTERN matches taskDescriptionText
 *   - carryover: min(0.25, max(0, carryoverRatio - 0.3))
 *
 * Returns level buckets: score < 0.3 → 'low'; 0.3–0.7 → 'medium'; ≥ 0.7 → 'high'.
 *
 * Pure function: no I/O, no side effects. Missing/invalid fields → 0 contribution.
 *
 * @param {object|null|undefined} signals
 * @returns {ContextPressureResult}
 */
export function computeContextPressure(signals) {
  // --- Scope component ---
  const priorities = safeArray(signals?.topPriorities);
  const priorityCount = priorities.length;
  const scopeComponent = clamp((priorityCount - 3) / 10, 0, 0.5);

  // --- Cross-cutting keywords component ---
  const text = typeof signals?.taskDescriptionText === 'string' ? signals.taskDescriptionText : '';
  const keywordsComponent = text.length > 0 && CROSS_CUTTING_PATTERN.test(text) ? 0.25 : 0;

  // --- Carryover component ---
  // Derive carryover ratio from tail-5 recent sessions using
  // effectiveness.carryover / effectiveness.planned_issues (sessions.jsonl schema).
  // Falls back gracefully when fields are absent (contributes 0).
  const recentSessions = safeArray(signals?.recentSessions);
  const last5 = recentSessions.slice(-5);
  let derivedCarryoverRatio = 0;
  if (last5.length > 0) {
    let validCount = 0;
    let ratioSum = 0;
    for (const session of last5) {
      if (session === null || typeof session !== 'object') continue;
      const eff = session.effectiveness;
      if (eff === null || typeof eff !== 'object') continue;
      const carryover =
        typeof eff.carryover === 'number' && !Number.isNaN(eff.carryover) ? eff.carryover : null;
      const planned =
        typeof eff.planned_issues === 'number' &&
        !Number.isNaN(eff.planned_issues) &&
        eff.planned_issues > 0
          ? eff.planned_issues
          : null;
      if (carryover !== null && planned !== null) {
        ratioSum += carryover / planned;
        validCount++;
      }
    }
    if (validCount > 0) {
      derivedCarryoverRatio = ratioSum / validCount;
    }
  }
  const carryoverComponent = clamp(derivedCarryoverRatio - 0.3, 0, 0.25);

  const score = round2(clamp(scopeComponent + keywordsComponent + carryoverComponent, 0, 1));

  /** @type {'low'|'medium'|'high'} */
  let level;
  if (score < 0.3) level = 'low';
  else if (score < 0.7) level = 'medium';
  else level = 'high';

  return {
    score,
    components: {
      scope: round2(scopeComponent),
      keywords: round2(keywordsComponent),
      carryover: round2(carryoverComponent),
    },
    level,
  };
}
