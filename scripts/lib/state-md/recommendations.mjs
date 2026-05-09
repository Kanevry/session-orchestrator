/**
 * Recommendation-fields contract for STATE.md v1.1 (extracted from state-md.mjs, issue #358).
 *
 * Self-contained leaf module — no imports from state-md.mjs (avoids circular deps).
 * Re-exported from scripts/lib/state-md.mjs for callsite compatibility.
 */

/**
 * Parses the 5 v1.1 Recommendation fields from a STATE.md frontmatter object
 * (as returned by `parseStateMd(...).frontmatter`).
 *
 * Returns `null` when NONE of the 5 fields are present (backward-compat:
 * pre-v1.1 STATE.md files).
 *
 * When a subset is present, populates the object with the parsed values and
 * sets missing fields to null. Type-mismatched fields are also coerced to
 * null (defensive — do not propagate garbage into downstream Mode-Selector).
 * Caller is responsible for emitting partial/type-mismatch warn events.
 *
 * @param {object} frontmatter
 * @returns {{mode: string|null, priorities: number[]|null, carryoverRatio: number|null, completionRate: number|null, rationale: string|null}|null}
 */
export function parseRecommendations(frontmatter) {
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return null;
  }
  const keys = [
    'recommended-mode',
    'top-priorities',
    'carryover-ratio',
    'completion-rate',
    'rationale',
  ];
  const anyPresent = keys.some((k) => Object.prototype.hasOwnProperty.call(frontmatter, k));
  if (!anyPresent) return null;

  const mode = typeof frontmatter['recommended-mode'] === 'string'
    ? frontmatter['recommended-mode']
    : null;
  const priorities = Array.isArray(frontmatter['top-priorities'])
    && frontmatter['top-priorities'].every((x) => Number.isInteger(x))
    ? frontmatter['top-priorities'].slice()
    : null;
  const carryoverRatio = typeof frontmatter['carryover-ratio'] === 'number'
    && !Number.isNaN(frontmatter['carryover-ratio'])
    ? frontmatter['carryover-ratio']
    : null;
  const completionRate = typeof frontmatter['completion-rate'] === 'number'
    && !Number.isNaN(frontmatter['completion-rate'])
    ? frontmatter['completion-rate']
    : null;
  const rationale = typeof frontmatter.rationale === 'string'
    ? frontmatter.rationale
    : null;

  return { mode, priorities, carryoverRatio, completionRate, rationale };
}
