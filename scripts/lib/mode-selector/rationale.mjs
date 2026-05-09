/**
 * Rationale-string builder for the mode-selector passthrough branch (W1A2 split, issue #358).
 *
 * Exports: buildPassthroughRationale.
 * Imports: constants (leaf). Shared helpers inlined per Option B.
 *
 * Pure function: no I/O, no side effects.
 * 120-char clamp is enforced on every returned string.
 */

import { TIER_MODE_MAP } from './constants.mjs';
import { safeArray, safeBootstrapLock } from './scoring.mjs';
import { hasActiveSignals } from './alternatives.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a rationale string for branch 3 (passthrough-weighted) based on the
 * dominant factor. Result is deterministic for the same (mode, signals) pair.
 * Always ≤120 chars.
 *
 * @param {string} mode
 * @param {number} confidence
 * @param {object} signals
 * @returns {string}
 */
export function buildPassthroughRationale(mode, confidence, signals) {
  const recentSessions = safeArray(signals.recentSessions);
  const last3 = recentSessions.slice(-3);
  const bootstrapLock = safeBootstrapLock(signals);
  const tier = bootstrapLock && typeof bootstrapLock.tier === 'string' ? bootstrapLock.tier : null;

  const hasTrend = last3.length >= 3 &&
    last3.every((s) => typeof s === 'object' && s !== null && s.session_type === mode);
  const hasTierAlign = tier !== null && TIER_MODE_MAP[tier] === mode;
  const hasSignals = hasActiveSignals(signals);

  let rationale;
  if (!hasSignals) {
    rationale = 'passthrough of Phase A recommended-mode — stale signals';
  } else if (hasTrend && hasTierAlign) {
    rationale = 'passthrough reinforced by recent-sessions trend + bootstrap tier';
  } else if (hasTrend) {
    rationale = 'passthrough reinforced by recent-sessions trend';
  } else if (hasTierAlign) {
    rationale = `passthrough reinforced by bootstrap tier (${tier})`;
  } else {
    rationale = 'passthrough of Phase A recommended-mode';
  }

  // Clamp to 120 chars (safety net)
  return rationale.slice(0, 120);
}
