/**
 * Mode-scoring logic for the mode-selector heuristic (W1A2 split, issue #358).
 *
 * Exports: computeDelta, scoreMode.
 * Imports: constants (leaf). Shared helpers inlined per Option B (avoids cycle
 * risk; matches context-pressure.mjs precedent).
 *
 * Pure functions: no I/O, no side effects.
 */

import { ALL_MODES, TIER_MODE_MAP } from './constants.mjs';
import { computeContextPressure } from './context-pressure.mjs';

// ---------------------------------------------------------------------------
// Inlined helpers (clamp, round2, safeArray, safeBootstrapLock)
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
export function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Safely coerce to an array (returns [] for non-arrays, null, undefined).
 * @param {unknown} v
 * @returns {any[]}
 */
export function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Return signals.bootstrapLock when it is a non-null object, otherwise null.
 * @param {object} signals
 * @returns {object|null}
 */
export function safeBootstrapLock(signals) {
  return (signals.bootstrapLock !== null && typeof signals.bootstrapLock === 'object')
    ? signals.bootstrapLock
    : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the bonus+penalty score delta for a candidate mode given the
 * provided signals. Returns a number in the range (-0.30, +0.35).
 *
 * @param {string} candidateMode
 * @param {object} signals
 * @returns {number} delta (positive bonuses − negative penalties)
 */
export function computeDelta(candidateMode, signals) {
  const recentSessions = safeArray(signals.recentSessions);
  const learnings = safeArray(signals.learnings);
  const bootstrapLock = safeBootstrapLock(signals);

  // --- Recent-sessions trend bonus (max +0.15) ---
  let trendBonus = 0;
  const last3 = recentSessions.slice(-3);
  if (last3.length >= 3) {
    const allMatch = last3.every(
      (s) => typeof s === 'object' && s !== null && s.session_type === candidateMode,
    );
    if (allMatch) {
      const avgCompletion =
        last3.reduce((sum, s) => sum + (typeof s.completion_rate === 'number' ? s.completion_rate : 0), 0) /
        3;
      trendBonus = avgCompletion >= 0.9 ? 0.15 : 0.075;
    }
  }

  // --- Bootstrap-tier alignment bonus (max +0.10) ---
  let tierBonus = 0;
  if (bootstrapLock !== null) {
    const tier = typeof bootstrapLock.tier === 'string' ? bootstrapLock.tier : null;
    if (tier !== null && TIER_MODE_MAP[tier] === candidateMode) {
      tierBonus = 0.10;
    }
  }

  // --- Learnings-hint bonus (max +0.10) ---
  let learningsBonus = 0;
  const HINT_TYPES = new Set(['effective-sizing', 'scope-guidance']);
  const modeKeyword = candidateMode.toLowerCase();
  for (const learning of learnings) {
    if (
      typeof learning === 'object' &&
      learning !== null &&
      typeof learning.type === 'string' &&
      HINT_TYPES.has(learning.type) &&
      typeof learning.subject === 'string' &&
      learning.subject.toLowerCase().includes(modeKeyword)
    ) {
      learningsBonus = Math.min(learningsBonus + 0.05, 0.10);
    }
  }

  // --- Conflict penalties (max −0.30) ---
  let penalty = 0;

  // Penalty: recent sessions trend strongly suggests a DIFFERENT mode
  if (last3.length >= 3) {
    const otherModes = ALL_MODES.filter((m) => m !== candidateMode);
    for (const otherMode of otherModes) {
      const allOther = last3.every(
        (s) => typeof s === 'object' && s !== null && s.session_type === otherMode,
      );
      if (allOther) {
        const avgCompletion =
          last3.reduce((sum, s) => sum + (typeof s.completion_rate === 'number' ? s.completion_rate : 0), 0) /
          3;
        if (avgCompletion >= 0.9) {
          penalty += 0.10;
          break; // only one other dominant mode possible
        }
      }
    }
  }

  // Penalty: bootstrap tier maps to a different mode than candidateMode
  if (bootstrapLock !== null) {
    const tier = typeof bootstrapLock.tier === 'string' ? bootstrapLock.tier : null;
    if (tier !== null) {
      const alignedMode = TIER_MODE_MAP[tier];
      if (alignedMode !== undefined && alignedMode !== candidateMode) {
        penalty += 0.10;
      }
    }
  }

  // Penalty: high carryover but not in 'deep' mode
  const carryoverRatio =
    typeof signals.carryoverRatio === 'number' && !Number.isNaN(signals.carryoverRatio)
      ? signals.carryoverRatio
      : null;
  if (carryoverRatio !== null && carryoverRatio >= 0.2 && candidateMode !== 'deep') {
    penalty += 0.10;
  }

  // --- Context-pressure modulation (#332) ---
  // Pure additive delta on top of existing signal modulation.
  // Only applies when at least one context-pressure input is explicitly present.
  // When all inputs are absent, pressure is undefined → treat as neutral (no adjustment).
  // This preserves backward-compatibility for callers that do not yet supply the new fields.
  const hasPressureInputs =
    (signals.topPriorities !== null && signals.topPriorities !== undefined) ||
    (typeof signals.taskDescriptionText === 'string' && signals.taskDescriptionText.length > 0) ||
    safeArray(signals.recentSessions).some(
      (s) => s !== null && typeof s === 'object' && typeof s.effectiveness === 'object' && s.effectiveness !== null,
    );

  let pressureDelta = 0;
  if (hasPressureInputs) {
    const pressure = computeContextPressure(signals);
    if (pressure.level === 'high') {
      if (candidateMode === 'feature') pressureDelta = -0.15;
      else if (candidateMode === 'housekeeping') pressureDelta = -0.10;
    } else if (pressure.level === 'low') {
      if (candidateMode === 'feature') pressureDelta = +0.05;
    }
    // level === 'medium': no adjustment
  }

  return trendBonus + tierBonus + learningsBonus - penalty + pressureDelta;
}

/**
 * Score a candidate mode: base 0.5 + delta, clamped to [0.0, 0.9].
 *
 * @param {string} candidateMode
 * @param {object} signals
 * @returns {number}
 */
export function scoreMode(candidateMode, signals) {
  return round2(clamp(0.5 + computeDelta(candidateMode, signals), 0.0, 0.9));
}
