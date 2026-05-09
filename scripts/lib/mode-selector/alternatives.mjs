/**
 * Alternatives-list builder for the mode-selector heuristic (W1A2 split, issue #358).
 *
 * Exports: buildAlternatives, hasActiveSignals.
 * Imports: scoring (for scoreMode + helpers), constants (for ALL_MODES).
 *
 * Pure functions: no I/O, no side effects.
 */

import { ALL_MODES } from './constants.mjs';
import { scoreMode, safeArray, safeBootstrapLock } from './scoring.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return true if any "active signal" field is non-trivially present.
 * Used to decide whether alternatives should be computed (branch 3).
 *
 * "Non-trivially present" means:
 *   - learnings: non-empty array
 *   - recentSessions: non-empty array
 *   - bootstrapLock: non-null object
 *
 * When no active signals exist, all modes score identically at base 0.5
 * so alternatives carry no information. Return [] to keep the passthrough
 * contract stable (existing tests assert alternatives === [] for bare calls).
 *
 * @param {object} signals
 * @returns {boolean}
 */
export function hasActiveSignals(signals) {
  const ls = safeArray(signals.learnings);
  const rs = safeArray(signals.recentSessions);
  return ls.length > 0 || rs.length > 0 || safeBootstrapLock(signals) !== null;
}

/**
 * Build the alternatives array for branch 3 (passthrough-weighted).
 * Returns 0–3 entries sorted by confidence descending, each with confidence >= 0.1.
 *
 * When no active signals are present, returns [] (all modes score identically
 * at 0.5, so alternatives carry no information — and this preserves the
 * existing passthrough test contract).
 *
 * @param {string} chosenMode
 * @param {object} signals
 * @returns {Array<{mode: string, confidence: number}>}
 */
export function buildAlternatives(chosenMode, signals) {
  if (!hasActiveSignals(signals)) {
    return [];
  }

  const otherModes = ALL_MODES.filter((m) => m !== chosenMode);
  const scored = otherModes
    .map((m) => ({ mode: m, confidence: scoreMode(m, signals) }))
    .filter((e) => e.confidence >= 0.1)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  return scored;
}
