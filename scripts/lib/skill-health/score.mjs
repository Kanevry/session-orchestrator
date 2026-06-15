/**
 * score.mjs — Layer (advisory) per-skill health scorer for #648.
 *
 * READ-ONLY ADVISORY. Per #648 the health surface NEVER auto-edits any skill file.
 * This module is PURE: no fs, no JSONL reads, no network, no Date.now(). Callers
 * pass pre-joined data in (L2 join.bySkill + optional L3 judgment counts) and
 * receive back an array of advisory verdict rows. It mutates nothing and emits no
 * side effects — the firewall between "surfacing a diagnosis" and "acting on it"
 * is enforced here by construction.
 *
 * Part of Epic #645/#648 — Skill Self-Evolution Foundation, per-skill health surface.
 */

/**
 * Minimum 'selected' samples before we trust a per-skill verdict.
 * ~20–30 samples/skill trust threshold (#648). No prior constant existed —
 * introduced here as the canonical floor.
 */
export const MIN_SAMPLES_FOR_VERDICT = 20;

/**
 * Strong applied=no floor: mirrors scripts/lib/sunset/walker.mjs:643 —
 * ≥2 applied=no judgments with 0 applied=yes is a strong "selected-but-not-applied"
 * signal (the trigger description is firing without the skill actually being used).
 */
export const STRONG_APPLIED_NO_FLOOR = 2;

/**
 * Pure scorer for per-skill health (#648). No I/O.
 *
 * @param {object} args
 * @param {Record<string,{skill:string,selections:number,sessions:string[],outcomes:object}>} args.bySkill
 *        — joinSkillOutcomes().bySkill (L2 join). selections = count of 'selected' events.
 * @param {Map<string,{appliedYes:number,appliedNo:number,appliedUnknown:number,completedYes:number,completedNo:number,completedUnknown:number,total:number,lastTs:string|null}>} [args.judgmentsBySkill]
 *        — readSkillJudgmentCounts().bySkill (L3). Defaults to empty Map (no L3 telemetry today).
 * @param {number} [args.minSamples=MIN_SAMPLES_FOR_VERDICT]
 * @param {boolean} [args.lowConfidence=false] — pass-through coverage<window guardrail.
 * @returns {Array<{skill:string,verdict:string,diagnosis:string,samples:number,confidence:number}>}
 */
export function scoreSkillHealth({
  bySkill,
  judgmentsBySkill = new Map(),
  minSamples = MIN_SAMPLES_FOR_VERDICT,
  lowConfidence = false,
} = {}) {
  // Guard against null/undefined bySkill — treat as {} (returns []).
  const skillMap = bySkill && typeof bySkill === 'object' ? bySkill : {};

  const rows = [];

  for (const skill of Object.keys(skillMap)) {
    const entry = skillMap[skill] ?? {};
    const samples = entry.selections ?? 0;

    // (2) Below sample threshold OR explicit low-confidence guardrail → no trust.
    if (samples < minSamples || lowConfidence === true) {
      rows.push({
        skill,
        verdict: 'insufficient signal',
        diagnosis: 'below sample threshold (' + samples + '/' + minSamples + ')',
        samples,
        confidence: 0,
      });
      continue;
    }

    // (3) No L3 judgment data for this skill → no actionable advisory.
    const j = judgmentsBySkill.get(skill);
    if (!j || j.total === 0) {
      rows.push({
        skill,
        verdict: 'insufficient signal',
        diagnosis: 'no L3 judgment data',
        samples,
        confidence: 0,
      });
      continue;
    }

    // confidence when L3 present: a simple normalized signal in [0,1]. We use the
    // ratio of judgment volume to the sample threshold, capped at 1 — more L3
    // judgments ⇒ higher confidence in the advisory verdict, saturating at minSamples.
    const confidence = Math.min(1, j.total / minSamples);

    // (4) Strong "selected but rarely applied" signal → trigger description unclear.
    if (j.appliedNo >= STRONG_APPLIED_NO_FLOOR && j.appliedYes === 0) {
      rows.push({
        skill,
        verdict: 'trigger description unclear',
        diagnosis: 'selected but rarely applied',
        samples,
        confidence,
      });
      continue;
    }

    // (5) Applied but completion is dominated by failures → instructions wrong.
    if (j.appliedYes > 0 && j.completedNo > j.completedYes) {
      rows.push({
        skill,
        verdict: 'instructions wrong',
        diagnosis: 'applied but low completion',
        samples,
        confidence,
      });
      continue;
    }

    // (6) Has L3 data but no actionable pattern.
    rows.push({
      skill,
      verdict: 'insufficient signal',
      diagnosis: 'no actionable signal',
      samples,
      confidence,
    });
  }

  // Deterministic ordering: sort by skill ascending.
  rows.sort((a, b) => (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));

  return rows;
}
