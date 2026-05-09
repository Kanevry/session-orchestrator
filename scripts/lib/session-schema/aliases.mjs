/**
 * session-schema/aliases.mjs — aliasLegacyEndedAt.
 *
 * Extracted from scripts/lib/session-schema.mjs (W1A3 split).
 * Pure function. Stdlib only. No imports from siblings or parent barrel.
 * isPlainObject is duplicated inline (Option 1 — submodule isolation).
 *
 * Exports: aliasLegacyEndedAt
 */

// ---------------------------------------------------------------------------
// Internal helper (intentional duplication — Option 1 isolation)
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrate legacy `ended_at` + `duration_ms` shape to canonical
 * `completed_at` (issue #321). Some pre-canonical writers produced records
 * with `ended_at` instead of `completed_at`; this helper aliases the field
 * so the canonical validator does not reject the record on a missing
 * required field.
 *
 * Behaviour:
 *   - If `completed_at` is absent and `ended_at` is a string, alias
 *     `completed_at <- ended_at`.
 *   - If both `completed_at` and `ended_at` are present and DIFFER, prefer
 *     `completed_at` (do not overwrite) and tag `_completed_at_conflict: true`
 *     for forensics.
 *   - If both `completed_at` and `started_at` end up present, drop the now-
 *     redundant `duration_ms` (derivable; canonical schema uses
 *     `duration_seconds`).
 *
 * Never throws. Returns either the original entry (no migration needed) or
 * a NEW object with the migration applied.
 *
 * @param {object} entry — session record
 * @returns {object} either the original entry or a NEW object
 */
export function aliasLegacyEndedAt(entry) {
  if (!isPlainObject(entry)) return entry;
  const hasCompleted = typeof entry.completed_at === 'string';
  const hasEnded = typeof entry.ended_at === 'string';
  if (!hasCompleted && !hasEnded) return entry;

  let next = entry;

  if (!hasCompleted && hasEnded) {
    next = { ...entry, completed_at: entry.ended_at };
  } else if (hasCompleted && hasEnded && entry.completed_at !== entry.ended_at) {
    next = { ...entry, _completed_at_conflict: true };
  }

  // Drop derivable duration_ms once we have both start + completed.
  if (
    'duration_ms' in next &&
    typeof next.completed_at === 'string' &&
    typeof next.started_at === 'string'
  ) {
    if (next === entry) next = { ...entry };
    delete next.duration_ms;
  }

  return next;
}
