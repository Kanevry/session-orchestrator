/**
 * autonomy-verdict.mjs — /evolve analyzer for dispatcher autonomy readiness.
 *
 * P3.5 (#683): combine autopilot effectiveness telemetry with advisory
 * skill-judge signals and emit one schema_version:1 `autonomy-verdict`
 * learning for a repo/scope once both signal families exist.
 *
 * Contract: pure, no-throw, ES module, no I/O. The caller supplies already-read
 * autopilot, sessions, and skill-judgment records.
 */

import { randomUUID } from 'node:crypto';

import { groupByMode } from './autopilot-effectiveness.mjs';
import { validateSkillJudgment } from '../skill-judgments-schema.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LEARNING_TYPE = 'autonomy-verdict';
export const DEFAULT_MIN_AUTOPILOT_RUNS = 1;
export const DEFAULT_MIN_SKILL_JUDGMENTS = 1;
export const DEFAULT_SCOPE = 'local';
export const DEFAULT_LEARNING_SCOPE = 'private';

/** Learning lifetime: align with autopilot-effectiveness' 90-day operational TTL. */
const EXPIRY_DAYS = 90;

// ---------------------------------------------------------------------------
// Defensive helpers
// ---------------------------------------------------------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function round3(v) {
  if (v === null || v === undefined) return null;
  return Math.round(v * 1000) / 1000;
}

function mean(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function weightedMean(pairs) {
  let total = 0;
  let weight = 0;
  for (const pair of pairs) {
    const value = num(pair?.value);
    const w = num(pair?.weight);
    if (value === null || w === null || w <= 0) continue;
    total += value * w;
    weight += w;
  }
  return weight > 0 ? total / weight : null;
}

function isoPlusDays(nowIso, days) {
  try {
    const t = new Date(nowIso).getTime();
    if (!Number.isFinite(t)) return new Date(Date.now() + days * 86400e3).toISOString();
    return new Date(t + days * 86400e3).toISOString();
  } catch {
    return new Date(Date.now() + days * 86400e3).toISOString();
  }
}

function sourceSession(nowIso) {
  return `evolve-${nowIso.slice(0, 10)}`;
}

function normalizeScope(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_SCOPE;
  const normalized = raw
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return normalized || DEFAULT_SCOPE;
}

function firstString(records, keys) {
  if (!Array.isArray(records)) return null;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
  }
  return null;
}

function inferScope(autopilotRuns, sessions, skillJudgments, opts) {
  const explicit = opts?.scope ?? opts?.repo ?? opts?.repoSlug ?? opts?.repository;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return normalizeScope(explicit);

  const keys = ['repo', 'repo_slug', 'repository', 'project', 'scope'];
  return normalizeScope(
    firstString(autopilotRuns, keys) ??
      firstString(sessions, keys) ??
      firstString(skillJudgments, keys) ??
      DEFAULT_SCOPE,
  );
}

function killSwitchFired(run) {
  const ks = run && typeof run === 'object' ? run.kill_switch : undefined;
  return typeof ks === 'string' && ks.length > 0;
}

function triScore(v) {
  if (v === 'yes') return 1;
  if (v === 'no') return 0;
  if (v === 'unknown') return 0.5;
  return null;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function minimumCount(raw, fallback) {
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.max(fallback, value);
}

function isCanonicalSkillJudgment(rec) {
  try {
    validateSkillJudgment(rec);
    return true;
  } catch {
    return false;
  }
}

function isAutopilotLoopRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (rec.kind === 'multi-story-coordinator') return false;
  return isNonEmptyString(rec.autopilot_run_id);
}

function autopilotLoopRecords(autopilotRuns) {
  return Array.isArray(autopilotRuns) ? autopilotRuns.filter(isAutopilotLoopRecord) : [];
}

function modeStatsToRecord(mode, stats) {
  const completionDelta =
    stats.completion_rate_manual !== null && stats.completion_rate_autopilot !== null
      ? round3(stats.completion_rate_autopilot - stats.completion_rate_manual)
      : null;
  const carryoverDelta =
    stats.carryover_ratio_manual !== null && stats.carryover_ratio_autopilot !== null
      ? round3(stats.carryover_ratio_autopilot - stats.carryover_ratio_manual)
      : null;

  return {
    mode,
    n_manual: stats.n_manual,
    n_autopilot: stats.n_autopilot,
    completion_rate_manual: stats.completion_rate_manual,
    completion_rate_autopilot: stats.completion_rate_autopilot,
    carryover_ratio_manual: stats.carryover_ratio_manual,
    carryover_ratio_autopilot: stats.carryover_ratio_autopilot,
    completion_delta: completionDelta,
    carryover_delta: carryoverDelta,
  };
}

function hasAffirmativeJudgeEvidence(skillJudge) {
  // Bug-fix (#683 review): applied_yes/completed_yes are summed INDEPENDENTLY
  // across all judgment records in summarizeSkillJudgments() below, so two
  // uncorrelated records — one {applied:'yes',completed:'no'}, another
  // {applied:'no',completed:'yes'} — used to satisfy this gate even though no
  // SINGLE judgment ever confirmed both applied AND completed. Gate on the
  // correlated `both_yes` counter instead: true only when at least one record
  // itself has applied==='yes' AND completed==='yes'.
  return (skillJudge?.both_yes ?? 0) > 0;
}

function hasAutopilotEffectivenessEvidence(autopilot) {
  return (autopilot?.n_autopilot_sessions ?? 0) > 0;
}

function verdictFor(score, killSwitchRate, skillJudge, autopilot) {
  if (
    score >= 0.7 &&
    (killSwitchRate === null || killSwitchRate < 0.2) &&
    hasAutopilotEffectivenessEvidence(autopilot) &&
    hasAffirmativeJudgeEvidence(skillJudge)
  ) {
    return 'ready';
  }
  if (score >= 0.5) return 'watch';
  return 'not-ready';
}

function readinessConfidence(autopilotSummary, judgmentSummary, score) {
  const runStrength = Math.min(0.2, autopilotSummary.n_runs * 0.02);
  const judgmentStrength = Math.min(0.2, judgmentSummary.total * 0.02);
  const confidenceStrength =
    judgmentSummary.avg_confidence === null ? 0 : judgmentSummary.avg_confidence * 0.1;
  const separationStrength = Math.min(0.1, Math.abs(score - 0.5) * 0.2);
  return round3(clamp01(0.4 + runStrength + judgmentStrength + confidenceStrength + separationStrength));
}

// ---------------------------------------------------------------------------
// Signal summaries
// ---------------------------------------------------------------------------

/**
 * Summarize autopilot run history plus type-8 mode effectiveness rollups.
 *
 * Abandoned-session filtering (#834): `sessions` is passed straight through
 * to `groupByMode()`, which filters phantom `status: 'abandoned'` stubs
 * before bucketing — this function inherits that guarantee transitively and
 * does not duplicate the filter. See `autopilot-effectiveness.mjs` `groupByMode()`.
 *
 * @param {Array} autopilotRuns
 * @param {Array} sessions
 * @returns {object}
 */
export function summarizeAutopilot(autopilotRuns, sessions) {
  const runs = autopilotLoopRecords(autopilotRuns);

  const nRuns = runs.length;
  const killSwitchesFired = runs.filter(killSwitchFired).length;
  const killSwitchRate = nRuns > 0 ? round3(killSwitchesFired / nRuns) : null;

  let grouped;
  try {
    grouped = groupByMode(runs, Array.isArray(sessions) ? sessions : []);
  } catch {
    grouped = new Map();
  }

  const modes = [];
  for (const [mode, stats] of grouped) {
    modes.push(modeStatsToRecord(mode, stats));
  }

  const completionRateAutopilot = round3(
    weightedMean(modes.map((m) => ({ value: m.completion_rate_autopilot, weight: m.n_autopilot }))),
  );
  const completionRateManual = round3(
    weightedMean(modes.map((m) => ({ value: m.completion_rate_manual, weight: m.n_manual }))),
  );
  const carryoverRatioAutopilot = round3(
    weightedMean(modes.map((m) => ({ value: m.carryover_ratio_autopilot, weight: m.n_autopilot }))),
  );
  const carryoverRatioManual = round3(
    weightedMean(modes.map((m) => ({ value: m.carryover_ratio_manual, weight: m.n_manual }))),
  );
  const completionDelta =
    completionRateAutopilot !== null && completionRateManual !== null
      ? round3(completionRateAutopilot - completionRateManual)
      : null;
  const carryoverDelta =
    carryoverRatioAutopilot !== null && carryoverRatioManual !== null
      ? round3(carryoverRatioAutopilot - carryoverRatioManual)
      : null;

  const nAutopilotSessions = modes.reduce((sum, m) => sum + m.n_autopilot, 0);

  // Effectiveness components: only present when at least one linked autopilot
  // session contributed completion/carryover data. Kept separate from the
  // kill-switch component below so a thin (kill-switch-only) run-set can be
  // detected and handled explicitly.
  const effectivenessParts = [];
  if (completionRateAutopilot !== null) effectivenessParts.push(completionRateAutopilot);
  if (carryoverRatioAutopilot !== null) effectivenessParts.push(1 - carryoverRatioAutopilot);
  if (completionDelta !== null) effectivenessParts.push(clamp01(0.5 + completionDelta));
  if (carryoverDelta !== null) effectivenessParts.push(clamp01(0.5 - carryoverDelta));

  const scoreParts = [];
  if (killSwitchRate !== null) scoreParts.push(1 - killSwitchRate);
  if (effectivenessParts.length > 0) {
    scoreParts.push(...effectivenessParts);
  } else if (scoreParts.length > 0) {
    // Bug-fix (#683 review): zero linked autopilot sessions (n_autopilot_sessions
    // === 0) means the run-set carries kill-switch data but NO session-
    // effectiveness evidence at all. Previously every effectiveness component
    // was silently dropped from scoreParts, leaving "1 - killSwitchRate" as the
    // SOLE input — a single clean run collapsed the score to ~1 ("perfect") on
    // zero effectiveness evidence. Missing effectiveness signals must read as
    // "unknown" (neutral 0.5), never as "perfect". The explicit
    // hasAutopilotEffectivenessEvidence() gate in verdictFor() is the
    // structural guarantee that thin evidence alone can never drive a 'ready'
    // verdict — this neutral value keeps the raw score itself honest too.
    scoreParts.push(0.5);
  }

  return {
    n_runs: nRuns,
    kill_switches_fired: killSwitchesFired,
    kill_switch_rate: killSwitchRate,
    n_autopilot_sessions: nAutopilotSessions,
    modes,
    completion_rate_autopilot: completionRateAutopilot,
    completion_rate_manual: completionRateManual,
    carryover_ratio_autopilot: carryoverRatioAutopilot,
    carryover_ratio_manual: carryoverRatioManual,
    completion_delta: completionDelta,
    carryover_delta: carryoverDelta,
    score: round3(mean(scoreParts)),
  };
}

/**
 * Summarize advisory skill-judge records. Malformed records are ignored.
 *
 * @param {Array} skillJudgments
 * @returns {object}
 */
export function summarizeSkillJudgments(skillJudgments) {
  const counts = {
    applied_yes: 0,
    applied_no: 0,
    applied_unknown: 0,
    completed_yes: 0,
    completed_no: 0,
    completed_unknown: 0,
    // Bug-fix (#683 review): correlated counter — incremented ONLY when a
    // SINGLE record has applied==='yes' AND completed==='yes'. The independent
    // applied_yes/completed_yes counts above are kept for backward
    // compatibility (other callers/tests read them), but
    // hasAffirmativeJudgeEvidence() above must gate on this correlated count,
    // not the independent sums — two uncorrelated records (one
    // {applied:'yes',completed:'no'}, another {applied:'no',completed:'yes'})
    // must NOT satisfy the gate.
    both_yes: 0,
  };
  const scores = [];
  const confidences = [];

  if (Array.isArray(skillJudgments)) {
    for (const rec of skillJudgments) {
      if (!isCanonicalSkillJudgment(rec)) continue;

      const appliedScore = triScore(rec.applied);
      const completedScore = triScore(rec.completed);

      counts[`applied_${rec.applied}`] += 1;
      counts[`completed_${rec.completed}`] += 1;
      if (rec.applied === 'yes' && rec.completed === 'yes') counts.both_yes += 1;
      scores.push((appliedScore + completedScore) / 2);

      const confidence = num(rec.confidence);
      if (confidence !== null && confidence >= 0 && confidence <= 1) confidences.push(confidence);
    }
  }

  const total = scores.length;
  return {
    total,
    ...counts,
    applied_yes_rate: total > 0 ? round3(counts.applied_yes / total) : null,
    completed_yes_rate: total > 0 ? round3(counts.completed_yes / total) : null,
    avg_confidence: round3(mean(confidences)),
    score: round3(mean(scores)),
  };
}

// ---------------------------------------------------------------------------
// Learning record builder
// ---------------------------------------------------------------------------

/**
 * Build a canonical schema_version:1 autonomy-verdict learning.
 *
 * @param {string} scope
 * @param {object} summaries
 * @param {object} summaries.autopilot
 * @param {object} summaries.skill_judge
 * @param {string} nowIso
 * @returns {object}
 */
export function buildLearning(scope, summaries, nowIso) {
  const subjectScope = normalizeScope(scope);
  const autopilot = summaries?.autopilot ?? summarizeAutopilot([], []);
  const skillJudge = summaries?.skill_judge ?? summarizeSkillJudgments([]);
  const score = round3(mean([autopilot.score, skillJudge.score])) ?? 0;
  const verdict = verdictFor(score, autopilot.kill_switch_rate, skillJudge, autopilot);
  const confidence = readinessConfidence(autopilot, skillJudge, score);

  const insight =
    `Scope '${subjectScope}' autonomy readiness is ${verdict} ` +
    `(score ${score}) across ${autopilot.n_runs} autopilot run(s) and ` +
    `${skillJudge.total} skill-judge judgment(s).`;

  return {
    schema_version: 1,
    id: randomUUID(),
    type: LEARNING_TYPE,
    subject: `${subjectScope}-autonomy-readiness`,
    insight,
    evidence: {
      scope: subjectScope,
      verdict,
      score,
      autopilot,
      skill_judge: skillJudge,
    },
    confidence,
    scope: DEFAULT_LEARNING_SCOPE,
    source_session: sourceSession(nowIso),
    created_at: nowIso,
    expires_at: isoPlusDays(nowIso, EXPIRY_DAYS),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Analyze autopilot + skill-judge signals and emit one `autonomy-verdict`
 * learning for the repo/scope. Returns [] until both signal families meet the
 * configured minimums (defaults: 1 autopilot run and 1 judgment).
 *
 * Never throws. Defensive against malformed entries.
 *
 * @param {Array} autopilotRuns — entries from .orchestrator/metrics/autopilot.jsonl
 * @param {Array} sessions — entries from .orchestrator/metrics/sessions.jsonl
 * @param {Array} skillJudgments — entries from .orchestrator/metrics/skill-judgments.jsonl
 * @param {object} [opts]
 * @param {string} [opts.scope] — subject scope override
 * @param {string} [opts.repo] — repo slug override
 * @param {number} [opts.minAutopilotRuns=1]
 * @param {number} [opts.minSkillJudgments=1]
 * @param {string} [opts.now] — ISO 8601 timestamp for created_at
 * @returns {Array<object>} learning records
 */
export function analyze(autopilotRuns, sessions, skillJudgments, opts = {}) {
  const now = typeof opts?.now === 'string' && opts.now.length > 0
    ? opts.now
    : new Date().toISOString();
  const minAutopilotRuns = minimumCount(opts?.minAutopilotRuns, DEFAULT_MIN_AUTOPILOT_RUNS);
  const minSkillJudgments = minimumCount(opts?.minSkillJudgments, DEFAULT_MIN_SKILL_JUDGMENTS);

  try {
    const runs = autopilotLoopRecords(autopilotRuns);
    const autopilot = summarizeAutopilot(runs, sessions);
    const skillJudge = summarizeSkillJudgments(skillJudgments);

    if (autopilot.n_runs < minAutopilotRuns) return [];
    if (skillJudge.total < minSkillJudgments) return [];

    const scope = inferScope(runs, sessions, skillJudgments, opts);
    return [buildLearning(scope, { autopilot, skill_judge: skillJudge }, now)];
  } catch {
    return [];
  }
}
