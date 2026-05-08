/**
 * Phase B-1 Mode-Selector heuristic v1 (issue #291, Epic #271).
 *
 * Pure function: same inputs → same outputs, zero side effects, no I/O.
 * Consumes Phase A signals (recommendedMode, carryoverRatio, completionRate) plus
 * Phase B signals (learnings, recentSessions, bootstrapLock) to produce a
 * confidence-weighted mode recommendation with ranked alternatives.
 */

import { isValidMode } from './recommendations-v0.mjs';

/** @type {'feature'} */
const DEFAULT_MODE = 'feature';

/** All valid mode values — mirrors VALID_MODES in recommendations-v0.mjs. */
const ALL_MODES = ['housekeeping', 'feature', 'deep', 'discovery', 'evolve', 'plan-retro'];

/**
 * Bootstrap tier → preferred mode alignment map.
 * @type {Record<string, string>}
 */
const TIER_MODE_MAP = {
  fast: 'housekeeping',
  standard: 'feature',
  deep: 'deep',
};

/**
 * @typedef {Object} RecentSession
 * @property {string} [session_type] - Mode used for that session.
 * @property {number} [completion_rate] - 0.0-1.0 completion rate.
 */

/**
 * @typedef {Object} Learning
 * @property {string} [type] - Learning type (e.g. 'effective-sizing', 'scope-guidance').
 * @property {string} [subject] - Subject text for matching.
 * @property {string} [expires_at] - ISO date string.
 */

/**
 * @typedef {Object} BootstrapLock
 * @property {string} [tier] - Bootstrap tier: 'fast' | 'standard' | 'deep'.
 */

/**
 * @typedef {Object} Signals
 * @property {string|null} [recommendedMode] - Phase A `recommended-mode`.
 * @property {Array<number|string>|null} [topPriorities] - Phase A top-priorities (informational).
 * @property {number|null} [carryoverRatio] - Phase A carryover-ratio (0.0-1.0).
 * @property {number|null} [completionRate] - Phase A completion-rate (0.0-1.0).
 * @property {string|null} [previousRationale] - Phase A rationale (informational).
 * @property {Learning[]|null} [learnings] - Active learnings for hints.
 * @property {RecentSession[]|null} [recentSessions] - Recent session history.
 * @property {object[]|null} [backlog] - Reserved for Phase B-3.
 * @property {BootstrapLock|null} [bootstrapLock] - Bootstrap lock tier info.
 * @property {object|null} [vaultStaleness] - Reserved.
 * @property {string|null} [taskDescriptionText] - Joined PRD/issue body text for keyword scan (context-pressure #332).
 */

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
 * @typedef {Object} Recommendation
 * @property {'housekeeping'|'feature'|'deep'|'discovery'|'evolve'|'plan-retro'} mode
 * @property {string} rationale - Single-line, ≤120 chars.
 * @property {number} confidence - 0.0 (pure fallback) to 1.0 (high confidence).
 * @property {Array<{mode: string, confidence: number}>} alternatives - 0-3 entries; may be empty.
 * @property {ContextPressureResult} context_pressure - Context-pressure signal (#332).
 */

// ---------------------------------------------------------------------------
// Internal helpers
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

/**
 * Return signals.bootstrapLock when it is a non-null object, otherwise null.
 * @param {Signals} signals
 * @returns {object|null}
 */
function safeBootstrapLock(signals) {
  return (signals.bootstrapLock !== null && typeof signals.bootstrapLock === 'object')
    ? signals.bootstrapLock
    : null;
}

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
 * @param {Signals} signals
 * @returns {boolean}
 */
function hasActiveSignals(signals) {
  const ls = safeArray(signals.learnings);
  const rs = safeArray(signals.recentSessions);
  return ls.length > 0 || rs.length > 0 || safeBootstrapLock(signals) !== null;
}

/**
 * Compute the bonus+penalty score delta for a candidate mode given the
 * provided signals. Returns a number in the range (-0.30, +0.35).
 *
 * @param {string} candidateMode
 * @param {Signals} signals
 * @returns {number} delta (positive bonuses − negative penalties)
 */
function computeDelta(candidateMode, signals) {
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
  // Only applies when at least one context-pressure input is explicitly present
  // (topPriorities supplied, taskDescriptionText supplied, or sessions have
  // effectiveness data). When all inputs are absent, pressure is undefined →
  // treat as neutral (no adjustment). This preserves backward-compatibility for
  // callers that do not yet supply the new pressure-specific signal fields.
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
 * @param {Signals} signals
 * @returns {number}
 */
function scoreMode(candidateMode, signals) {
  return round2(clamp(0.5 + computeDelta(candidateMode, signals), 0.0, 0.9));
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
 * @param {Signals} signals
 * @returns {Array<{mode: string, confidence: number}>}
 */
function buildAlternatives(chosenMode, signals) {
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

/**
 * Build a rationale string for branch 3 based on the dominant factor.
 *
 * @param {string} mode
 * @param {number} confidence
 * @param {Signals} signals
 * @returns {string}
 */
function buildPassthroughRationale(mode, confidence, signals) {
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

// ---------------------------------------------------------------------------
// Context-pressure signal (#332)
// ---------------------------------------------------------------------------

/**
 * Regex for cross-cutting keyword detection in task description text.
 * Matches phrases that indicate large, scope-spanning work.
 */
const CROSS_CUTTING_PATTERN =
  /across all|every (skill|agent|repo)|repo-?wide|cross-cutting|rename across|massive refactor/i;

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
 * @param {Signals & { taskDescriptionText?: string|null }} signals
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
 * @param {Signals|null|undefined} signals
 * @returns {Recommendation}
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

  // Branch 5 — DEFAULT: no valid mode signal and no spiral/carryover trigger
  return {
    mode: DEFAULT_MODE,
    rationale: 'missing/invalid recommendedMode → default',
    confidence: 0.0,
    alternatives: [],
    context_pressure: computeContextPressure(signals),
  };
}
