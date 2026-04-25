/**
 * Phase B Mode-Selector scaffold (issue #276, Epic #271).
 *
 * Pure function: same inputs → same outputs, zero side effects, no I/O.
 * This is the v0 scaffold — the full heuristic consuming learnings,
 * sessions.jsonl trends, VCS backlog, and bootstrap.lock is deferred to
 * follow-up sub-issues. The implementation is intentionally minimal:
 * passthrough of the Phase A `recommended-mode` frontmatter field at
 * confidence 0.5, or fallback to 'feature' at confidence 0.0.
 */

import { isValidMode } from './recommendations-v0.mjs';

/** @type {'feature'} */
const DEFAULT_MODE = 'feature';
const PASSTHROUGH_CONFIDENCE = 0.5;
const FALLBACK_CONFIDENCE = 0.0;

/**
 * @typedef {Object} Signals
 * @property {string|null} [recommendedMode] - Phase A `recommended-mode`.
 * @property {number[]|null} [topPriorities] - Phase A top-priorities.
 * @property {number|null} [carryoverRatio] - Phase A carryover-ratio (0.0-1.0).
 * @property {number|null} [completionRate] - Phase A completion-rate (0.0-1.0).
 * @property {string|null} [previousRationale] - Phase A rationale.
 * @property {object[]|null} [learnings] - Reserved for Phase B heuristic v1.
 * @property {object[]|null} [recentSessions] - Reserved.
 * @property {object[]|null} [backlog] - Reserved.
 * @property {object|null} [bootstrapLock] - Reserved.
 * @property {object|null} [vaultStaleness] - Reserved.
 */

/**
 * @typedef {Object} Recommendation
 * @property {'housekeeping'|'feature'|'deep'|'discovery'|'evolve'|'plan-retro'} mode
 * @property {string} rationale - Single-line, ≤120 chars.
 * @property {number} confidence - 0.0 (pure fallback) to 1.0 (high confidence).
 * @property {Array<{mode: string, confidence: number}>} alternatives - 0-3 entries; may be empty.
 */

/**
 * Deterministic mode selection for session-start.
 *
 * Pure function: same inputs → same outputs, zero side effects, no I/O.
 *
 * Phase B scaffold (issue #276) — the full heuristic consuming learnings,
 * sessions.jsonl trends, VCS backlog, and bootstrap.lock is a follow-up
 * sub-issue. This implementation is intentionally minimal: passthrough of
 * the Phase A `recommended-mode` frontmatter field at confidence 0.5, or
 * fallback to 'feature' at confidence 0.0.
 *
 * @param {Signals|null|undefined} signals
 * @returns {Recommendation}
 */
export function selectMode(signals) {
  if (signals === null || signals === undefined) {
    return {
      mode: DEFAULT_MODE,
      rationale: 'scaffold: null signals → default',
      confidence: FALLBACK_CONFIDENCE,
      alternatives: [],
    };
  }

  const m = signals.recommendedMode;
  if (typeof m === 'string' && isValidMode(m)) {
    return {
      mode: m,
      rationale: 'scaffold: passthrough of Phase A recommended-mode',
      confidence: PASSTHROUGH_CONFIDENCE,
      alternatives: [],
    };
  }

  return {
    mode: DEFAULT_MODE,
    rationale: 'scaffold: missing/invalid recommendedMode → default',
    confidence: FALLBACK_CONFIDENCE,
    alternatives: [],
  };
}
