/**
 * learnings/filters.mjs — filtering helpers for learnings entries.
 *
 * Extracted from scripts/lib/learnings.mjs (issue #358).
 * Depends on normalizeLearning from the schema layer in the parent module.
 */

import { normalizeLearning } from './schema.mjs';

// ---------------------------------------------------------------------------
// Filtering helpers (used by C3 export + /evolve hardware-pattern queries)
// ---------------------------------------------------------------------------

/**
 * Filter learnings by scope. Returns a new array.
 * @param {object[]} entries
 * @param {string|string[]} scope
 * @returns {object[]}
 */
export function filterByScope(entries, scope) {
  const scopes = Array.isArray(scope) ? scope : [scope];
  return entries.filter((e) => scopes.includes(normalizeLearning(e).scope));
}

/**
 * Filter learnings by host_class. Returns a new array.
 * @param {object[]} entries
 * @param {string} hostClass
 * @returns {object[]}
 */
export function filterByHostClass(entries, hostClass) {
  return entries.filter((e) => normalizeLearning(e).host_class === hostClass);
}

/**
 * Filter learnings by type.
 * @param {object[]} entries
 * @param {string} type
 * @returns {object[]}
 */
export function filterByType(entries, type) {
  return entries.filter((e) => e.type === type);
}
