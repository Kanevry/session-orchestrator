/**
 * Frontmatter mutation helpers for STATE.md.
 *
 * Pure functions — no file I/O.
 */

import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';

/**
 * Sets frontmatter.updated to the given ISO 8601 timestamp and returns the
 * new contents. If the file has no frontmatter, returns input unchanged.
 *
 * @param {string} contents
 * @param {string} isoTimestamp
 * @returns {string}
 */
export function touchUpdatedField(contents, isoTimestamp) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  parsed.frontmatter.updated = isoTimestamp;
  return serializeStateMd(parsed);
}

/**
 * Additively writes frontmatter keys. Only keys present in `fields` are
 * touched; all other existing frontmatter keys (including unknown
 * extensions) are preserved verbatim.
 *
 * Value semantics:
 *   - `null` or `undefined` value → key is DELETED from the frontmatter
 *   - anything else → key is set/overwritten
 *
 * No-ops if `contents` has no frontmatter (returns input unchanged).
 *
 * @param {string} contents
 * @param {object} fields
 * @returns {string}
 */
export function updateFrontmatterFields(contents, fields) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return contents;
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) {
      delete parsed.frontmatter[k];
    } else {
      parsed.frontmatter[k] = v;
    }
  }
  return serializeStateMd(parsed);
}
