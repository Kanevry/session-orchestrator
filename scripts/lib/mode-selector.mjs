/**
 * Phase B-1 Mode-Selector heuristic v1 (issue #291, Epic #271).
 *
 * Thin orchestrator — delegates to submodules (W1A2 split, issue #358).
 * Pure function: same inputs → same outputs, zero side effects, no I/O.
 *
 * Public API:
 *   selectMode(signals) → Recommendation
 *   computeContextPressure  (re-export from context-pressure.mjs)
 */

import { isValidMode } from './recommendations-v0.mjs';
import { DEFAULT_MODE } from './mode-selector/constants.mjs';
import { computeDelta, round2 } from './mode-selector/scoring.mjs';
import { buildAlternatives } from './mode-selector/alternatives.mjs';
import { buildPassthroughRationale } from './mode-selector/rationale.mjs';
import { computeContextPressure } from './mode-selector/context-pressure.mjs';
export { computeContextPressure };

// clamp inlined — used only in selectMode; avoids importing scoring helpers
// for a single expression.
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Deterministic mode selection for session-start.
 *
 * Pure function: same inputs → same outputs, zero side effects, no I/O.
 *
 * Heuristic v1 (issue #291) — consumes carryoverRatio, completionRate,
 * recentSessions trend, bootstrapLock tier-alignment, and learnings hints
 * to compute a confidence-weighted recommendation with alternatives.
 *
 * Decision priority:
 *   1. SPIRAL    — completionRate < 0.5
 *   2. CARRYOVER — carryoverRatio >= 0.3
 *   3. PASSTHROUGH-WEIGHTED — valid recommendedMode + signal scoring
 *   4. DEFAULT   — no valid mode, no spiral/carryover trigger
 *
 * @param {import('./mode-selector/constants.mjs').Signals|null|undefined} signals
 * @returns {import('./mode-selector/constants.mjs').Recommendation}
 */
export function selectMode(signals) {
  // Null-guard: treat null/undefined as empty signals object.
  if (signals === null || signals === undefined) {
    return {
      mode: DEFAULT_MODE,
      rationale: 'scaffold: null signals → default',
      confidence: 0.0,
      alternatives: [],
      context_pressure: computeContextPressure({}),
    };
  }

  // Defensive extraction of numeric signals.
  const completionRate =
    typeof signals.completionRate === 'number' && !Number.isNaN(signals.completionRate)
      ? signals.completionRate
      : null;
  const carryoverRatio =
    typeof signals.carryoverRatio === 'number' && !Number.isNaN(signals.carryoverRatio)
      ? signals.carryoverRatio
      : null;

  // Branch 1 — SPIRAL: low completion rate
  if (completionRate !== null && completionRate < 0.5) {
    return {
      mode: 'plan-retro',
      rationale: 'low completion → retrospective',
      confidence: 0.8,
      alternatives: [
        { mode: 'feature', confidence: 0.3 },
        { mode: 'discovery', confidence: 0.25 },
      ],
      context_pressure: computeContextPressure(signals),
    };
  }

  // Branch 2 — CARRYOVER: high carryover ratio
  if (carryoverRatio !== null && carryoverRatio >= 0.3) {
    const pct = Math.round(carryoverRatio * 100);
    return {
      mode: 'deep',
      rationale: `carryover ${pct}% — deep clear`,
      confidence: 0.75,
      alternatives: [
        { mode: 'feature', confidence: 0.3 },
        { mode: 'plan-retro', confidence: 0.2 },
      ],
      context_pressure: computeContextPressure(signals),
    };
  }

  // Branch 3 — PASSTHROUGH-WEIGHTED: valid recommendedMode from Phase A
  const m = signals.recommendedMode;
  if (typeof m === 'string' && isValidMode(m)) {
    const delta = computeDelta(m, signals);
    const confidence = round2(clamp(0.5 + delta, 0.0, 0.9));
    const pressure = computeContextPressure(signals);
    let rationale = buildPassthroughRationale(m, confidence, signals);

    // Annotate rationale with pressure level when non-trivial (≤120 char limit).
    if (pressure.level !== 'low') {
      const pressureAnnotation = `; pressure:${pressure.level}(${pressure.score})`;
      rationale = (rationale + pressureAnnotation).slice(0, 120);
    }

    const alternatives = buildAlternatives(m, signals);

    // Global-max swap (#299): the primary recommendation must be the
    // highest-confidence mode across {primary, ...alternatives}. When an
    // alternative outranks the passthrough primary (strict greater-than to
    // preserve passthrough preference on ties), promote it and demote the
    // original primary into alternatives, re-sort, slice to top-3.
    if (alternatives.length > 0 && alternatives[0].confidence > confidence) {
      const promoted = alternatives[0];
      const demoted = { mode: m, confidence };
      const reranked = [demoted, ...alternatives.slice(1)]
        .filter((e) => e.confidence >= 0.1)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);
      return {
        mode: promoted.mode,
        rationale: `global-max swap: ${promoted.mode} (${promoted.confidence}) outranked passthrough ${m} (${confidence})`.slice(0, 120),
        confidence: promoted.confidence,
        alternatives: reranked,
        context_pressure: pressure,
      };
    }

    return {
      mode: m,
      rationale,
      confidence,
      alternatives,
      context_pressure: pressure,
    };
  }

  // Branch 4 — DEFAULT: no valid mode signal and no spiral/carryover trigger
  return {
    mode: DEFAULT_MODE,
    rationale: 'missing/invalid recommendedMode → default',
    confidence: 0.0,
    alternatives: [],
    context_pressure: computeContextPressure(signals),
  };
}
