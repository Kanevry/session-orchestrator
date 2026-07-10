/**
 * consolidator.mjs — Aggregate per-persona outputs into a final panel verdict (#457).
 *
 * Pure module: no I/O, no async, no side effects. Given a set of validated
 * persona outputs and a consolidation mode, computes the panel-wide verdict
 * along with the vote tally, threshold-met flag, and dissenting persona list.
 *
 * ── Tie-break / counting rules (W1-D3 H1 — pinned explicitly) ────────────────
 *
 * voting-quorum:
 *   M-of-N must vote `pass` to reach overall PASS. Ties (exactly M votes) → PASS
 *   because the threshold is inclusive (pass-count ≥ M). 0 pass votes → BLOCKED.
 *
 * hard-gate-threshold:
 *   ALL configured personas must vote `pass`. Anything less (even a single
 *   warn/fail/error) → BLOCKED. Threshold is effectively N-of-N (or M-of-N
 *   when the operator opts into strict mode and threshold.kind=='m-of-n').
 *
 * coordinator-summary:
 *   Aggregator hint only. No verdict is computed in this function. Returns
 *   `final_verdict: 'REQUIRES_COORDINATOR'` so the caller can route to a
 *   coordinator-level summarisation pass. A stderr WARN should be emitted at
 *   the call site (skill markdown layer), not here.
 *
 * Conservative-error rule (W1-D3 H4 — pinned):
 *   ANY persona output with mode != 'validated' (i.e. parse-error, compile-error,
 *   validation-failed) is counted as a FAIL vote. This is the most conservative
 *   choice: errors never let a borderline panel through.
 *
 * Empty input → BLOCKED, notes include 'no persona outputs'.
 *
 * ── Public shape ─────────────────────────────────────────────────────────────
 *
 *   ConsolidationResult = {
 *     final_verdict:    'PROCEED' | 'PROCEED_WITH_FOLLOWUPS' | 'BLOCKED' | 'REQUIRES_COORDINATOR',
 *     mode_used:        string,
 *     votes:            { pass, fail, warn, error, total },
 *     threshold_met:    boolean,
 *     dissenting_personas: string[],
 *     tie_break_applied: boolean,
 *     notes:            string[]
 *   }
 */

import path from 'node:path';

import { thresholdMet } from './threshold.mjs';

/**
 * Allowed consolidation modes. Exported for input validation by callers.
 */
export const CONSOLIDATION_MODES = Object.freeze([
  'voting-quorum',
  'hard-gate-threshold',
  'coordinator-summary',
]);

/**
 * Verdicts the persona panel can emit. The first three mirror the existing
 * implementer-agent verdict enum from agents/schemas/*.schema.json so the
 * panel result composes cleanly into downstream JSON.
 */
export const FINAL_VERDICTS = Object.freeze([
  'PROCEED',
  'PROCEED_WITH_FOLLOWUPS',
  'BLOCKED',
  'REQUIRES_COORDINATOR',
]);

/**
 * @typedef {Object} ValidatedPersonaOutput
 * @property {string} persona_name
 * @property {'pass'|'fail'|'warn'} [verdict]   — present when mode === 'validated'
 * @property {'validated'|'parse-error'|'compile-error'|'validation-failed'} mode
 * @property {string[]} [recommendations]
 * @property {string} [rationale]
 */

/**
 * @typedef {Object} ConsolidationConfig
 * @property {import('./threshold.mjs').ParsedThreshold} threshold
 * @property {boolean} [allowSplit]  — only meaningful for voting-quorum
 */

/**
 * @typedef {Object} ConsolidationResult
 * @property {'PROCEED'|'PROCEED_WITH_FOLLOWUPS'|'BLOCKED'|'REQUIRES_COORDINATOR'} final_verdict
 * @property {string} mode_used
 * @property {{pass:number, fail:number, warn:number, error:number, total:number}} votes
 * @property {boolean} threshold_met
 * @property {string[]} dissenting_personas
 * @property {boolean} tie_break_applied
 * @property {string[]} notes
 */

/**
 * Build a zeroed vote-tally accumulator.
 *
 * @returns {{pass:number, fail:number, warn:number, error:number, total:number}}
 */
function emptyVotes() {
  return { pass: 0, fail: 0, warn: 0, error: 0, total: 0 };
}

/**
 * Walk one persona output and update the running tally. Pure.
 *
 * @param {ValidatedPersonaOutput} out
 * @param {{pass:number, fail:number, warn:number, error:number, total:number}} votes
 */
function tally(out, votes) {
  votes.total += 1;
  // Conservative-error rule (W1-D3 H4): any non-validated mode counts as FAIL.
  if (out?.mode !== 'validated') {
    votes.error += 1;
    votes.fail += 1;
    return;
  }
  if (out.verdict === 'pass') votes.pass += 1;
  else if (out.verdict === 'fail') votes.fail += 1;
  else if (out.verdict === 'warn') votes.warn += 1;
  else {
    // Validated mode but unknown verdict — treat as error/fail for safety.
    votes.error += 1;
    votes.fail += 1;
  }
}

/**
 * Determine which personas voted differently from the dominant outcome.
 * For `voting-quorum`: dominant = `pass` if threshold met else `fail`.
 * For `hard-gate-threshold`: dominant = `pass`; anything else is dissenting.
 *
 * @param {ValidatedPersonaOutput[]} outputs
 * @param {'pass'|'fail'} dominant
 * @returns {string[]} persona names that did NOT vote with the dominant outcome
 */
function dissentingFrom(outputs, dominant) {
  const names = [];
  for (const out of outputs) {
    const v = out?.mode === 'validated' ? out.verdict : 'error';
    if (v !== dominant) names.push(out.persona_name);
  }
  return names;
}

/**
 * Consolidate validated persona outputs into a final panel verdict.
 *
 * @param {ValidatedPersonaOutput[]} outputs
 * @param {'voting-quorum' | 'hard-gate-threshold' | 'coordinator-summary'} mode
 * @param {ConsolidationConfig} config
 * @returns {ConsolidationResult}
 */
export function consolidate(outputs, mode, config) {
  const notes = [];

  if (!Array.isArray(outputs)) {
    return {
      final_verdict: 'BLOCKED',
      mode_used: String(mode ?? ''),
      votes: emptyVotes(),
      threshold_met: false,
      dissenting_personas: [],
      tie_break_applied: false,
      notes: ['outputs must be an array'],
    };
  }

  if (!CONSOLIDATION_MODES.includes(mode)) {
    return {
      final_verdict: 'BLOCKED',
      mode_used: String(mode ?? ''),
      votes: emptyVotes(),
      threshold_met: false,
      dissenting_personas: [],
      tie_break_applied: false,
      notes: [`unknown consolidation mode: ${JSON.stringify(mode)}`],
    };
  }

  if (outputs.length === 0) {
    return {
      final_verdict: 'BLOCKED',
      mode_used: mode,
      votes: emptyVotes(),
      threshold_met: false,
      dissenting_personas: [],
      tie_break_applied: false,
      notes: ['no persona outputs'],
    };
  }

  // coordinator-summary short-circuits BEFORE tallying — we do not compute a
  // verdict here. The caller emits the operator-WARN at the skill layer.
  if (mode === 'coordinator-summary') {
    const votes = emptyVotes();
    for (const o of outputs) tally(o, votes);
    return {
      final_verdict: 'REQUIRES_COORDINATOR',
      mode_used: mode,
      votes,
      threshold_met: false,
      dissenting_personas: [],
      tie_break_applied: false,
      notes: ['coordinator-summary: defer panel verdict to caller'],
    };
  }

  if (config === null || typeof config !== 'object' || config.threshold === null || config.threshold === undefined) {
    return {
      final_verdict: 'BLOCKED',
      mode_used: mode,
      votes: emptyVotes(),
      threshold_met: false,
      dissenting_personas: [],
      tie_break_applied: false,
      notes: ['config.threshold is required'],
    };
  }

  const votes = emptyVotes();
  for (const o of outputs) tally(o, votes);

  const errorCount = votes.error;
  if (errorCount > 0) {
    notes.push(`${errorCount} persona output(s) failed schema/parse validation — counted as FAIL`);
  }

  const met = thresholdMet(config.threshold, { pass: votes.pass, total: votes.total });

  if (mode === 'voting-quorum') {
    // Tie-break: when threshold is "m-of-n" and pass count == m exactly, the
    // threshold IS met (>= comparison in thresholdMet), so PASS holds. We tag
    // tie_break_applied = true so audit trails can see the boundary case.
    const tieBreakApplied =
      config.threshold.kind === 'm-of-n' && votes.pass === config.threshold.m;

    let final;
    if (votes.pass === 0) {
      // 0 pass votes → BLOCKED regardless of threshold shape (defensive).
      final = 'BLOCKED';
    } else if (met) {
      // PROCEED_WITH_FOLLOWUPS if there are dissenters; PROCEED if unanimous.
      final = votes.pass === votes.total ? 'PROCEED' : 'PROCEED_WITH_FOLLOWUPS';
    } else {
      final = 'BLOCKED';
    }

    const dominantVerdict = final === 'BLOCKED' ? 'fail' : 'pass';
    return {
      final_verdict: final,
      mode_used: mode,
      votes,
      threshold_met: met,
      dissenting_personas: dissentingFrom(outputs, dominantVerdict),
      tie_break_applied: tieBreakApplied,
      notes,
    };
  }

  // mode === 'hard-gate-threshold'
  // Strict: every persona must vote pass. Any non-pass → BLOCKED.
  const allPass = votes.pass === votes.total && votes.total > 0;
  const final = allPass ? 'PROCEED' : 'BLOCKED';

  // For hard-gate, the threshold-met indicator follows the configured parser
  // (typically `all` or `n-of-n`). If a coordinator wired in `m-of-n` with M<N
  // under hard-gate mode the gate still requires unanimity — record the
  // discrepancy in notes for the audit trail.
  if (
    config.threshold.kind === 'm-of-n' &&
    config.threshold.m < config.threshold.n
  ) {
    notes.push(
      `hard-gate-threshold enforces unanimity; threshold m-of-n with m<n was supplied (${config.threshold.m}-of-${config.threshold.n}) — using unanimity gate.`,
    );
  }

  return {
    final_verdict: final,
    mode_used: mode,
    votes,
    threshold_met: allPass,
    dissenting_personas: dissentingFrom(outputs, 'pass'),
    tie_break_applied: false,
    notes,
  };
}

// ---------------------------------------------------------------------------
// diffGroundingSources (#730 Epic H — Grounding-Review-Variante, v1)
// ---------------------------------------------------------------------------

/**
 * Normalise a source-path string for grounding-diff comparison. Pure string
 * operation — no filesystem access, no existence check. Backslashes become
 * forward slashes, `.`/`..` segments are lexically collapsed, and a leading
 * `./` is stripped so `./foo/bar.md`, `foo/bar.md`, and `foo\bar.md` all
 * compare equal.
 *
 * @param {unknown} p
 * @returns {string} normalised path, or '' when `p` is not a non-empty string
 */
function normalizeSourcePath(p) {
  if (typeof p !== 'string' || p.trim() === '') return '';
  const slashed = p.trim().replace(/\\/g, '/');
  return path.posix.normalize(slashed).replace(/^\.\//, '');
}

/**
 * @typedef {Object} GroundingDiffResult
 * @property {string[]} unconfirmed_author_sources — sources the target author claimed
 *   (`authorSources`) that NO persona's `derived_sources` independently confirmed.
 * @property {string[]} newly_derived — sources at least one persona independently
 *   derived that were NOT in the author's claimed list.
 * @property {number} personas_reporting — count of `outputs` entries that reported at
 *   least one `derived_sources` entry.
 */

/**
 * Diff an author's claimed source list against what reviewing personas
 * independently re-derived (`derived_sources` on each output, populated when
 * a persona was dispatched with `groundingMode: 're-derive'` —
 * see `buildPersonaPrompt` in `persona-runner.mjs`).
 *
 * Pure and advisory-only: this diff is NEVER consumed by `consolidate()` or
 * `tally()` and has NO influence on `final_verdict`. It is signal for the
 * caller (skill/report layer) to surface to the operator, never a gate.
 *
 * v1 scope: only meaningful when the caller explicitly supplies
 * `authorSources` (e.g. a "Sources" section the coordinator parsed out of the
 * target). When `authorSources` is empty/absent, `unconfirmed_author_sources`
 * is trivially `[]` and the diff degrades to reporting `newly_derived` +
 * `personas_reporting` only.
 *
 * @param {string[]} authorSources — paths the target itself claims as sources
 * @param {Array<{derived_sources?: Array<{path?: string, supports_claim?: string}>}>} outputs
 *   — persona outputs (same shape consolidate() consumes; only `derived_sources` is read)
 * @returns {GroundingDiffResult}
 */
export function diffGroundingSources(authorSources, outputs) {
  const authorSet = new Set(
    (Array.isArray(authorSources) ? authorSources : [])
      .map(normalizeSourcePath)
      .filter((p) => p !== ''),
  );

  const derivedSet = new Set();
  let personasReporting = 0;

  for (const out of Array.isArray(outputs) ? outputs : []) {
    const derived = Array.isArray(out?.derived_sources) ? out.derived_sources : [];
    if (derived.length === 0) continue;
    personasReporting += 1;
    for (const entry of derived) {
      const normalized = normalizeSourcePath(entry?.path);
      if (normalized !== '') derivedSet.add(normalized);
    }
  }

  const unconfirmedAuthorSources = [...authorSet].filter((p) => !derivedSet.has(p)).sort();
  const newlyDerived = [...derivedSet].filter((p) => !authorSet.has(p)).sort();

  return {
    unconfirmed_author_sources: unconfirmedAuthorSources,
    newly_derived: newlyDerived,
    personas_reporting: personasReporting,
  };
}
