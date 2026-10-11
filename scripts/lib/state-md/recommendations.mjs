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
  const priorities = parsePriorities(frontmatter['top-priorities']);
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

/** An entry that is exactly an issue reference of THIS repo: `42` or `#42`. */
const ISSUE_REF_RE = /^#?\d+$/;

/**
 * Normalises `top-priorities` to issue numbers. Integers pass; strings that are
 * exactly an issue ref (`"#42"`, `"42"`) become integers; every other entry is
 * dropped. A hand-written `"#370 fix banner"` or `"other-repo#74"` is never
 * mined for digits, because the number may belong to another repo. An array
 * that held entries but keeps none is a type mismatch (`null`), as before.
 *
 * @param {unknown} raw
 * @returns {number[]|null}
 */
function parsePriorities(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = [];
  for (const entry of raw) {
    if (Number.isInteger(entry)) ids.push(entry);
    else if (typeof entry === 'string' && ISSUE_REF_RE.test(entry.trim())) {
      ids.push(Number.parseInt(entry.trim().replace('#', ''), 10));
    }
  }
  return raw.length > 0 && ids.length === 0 ? null : ids;
}
