/**
 * session-schema/timestamps.mjs — clampTimestampsMonotonic.
 *
 * Extracted from scripts/lib/session-schema.mjs (W1A3 split).
 * Pure function. Stdlib only. No imports from siblings or parent barrel.
 * isPlainObject is duplicated inline (Option 1 — submodule isolation).
 *
 * Exports: clampTimestampsMonotonic
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
 * Clamp `completed_at` to be >= `started_at` when an inversion is detected.
 *
 * Defends against clock skew, manual STATE.md frontmatter edits, and any
 * other writer that produces a `completed_at < started_at` violation. Rather
 * than throw and lose the session record entirely, we mathematically clamp
 * `completed_at` to equal `started_at` (duration = 0) and tag the entry with
 * forensics fields so the original timestamp is recoverable.
 *
 * Behaviour:
 *   - If either field is absent, return the entry unchanged (let validate
 *     surface the missing-field error).
 *   - If either field is unparsable, return the entry unchanged (validate
 *     will surface the parse error with a clearer message).
 *   - If `completed_at >= started_at`, return the entry unchanged.
 *   - Otherwise return a NEW object with:
 *       completed_at: <started_at>
 *       _clamped: true
 *       _original_completed_at: <orig completed_at>
 *
 * Never throws. Caller is responsible for emitting any warning log.
 *
 * @param {object} entry — session record (may be the raw input)
 * @returns {object} either the original entry (no clamp needed) or a NEW
 *                   object with clamp applied + forensics fields
 */
export function clampTimestampsMonotonic(entry) {
  if (!isPlainObject(entry)) return entry;
  if (typeof entry.started_at !== 'string' || typeof entry.completed_at !== 'string') {
    return entry;
  }
  const startedMs = Date.parse(entry.started_at);
  const completedMs = Date.parse(entry.completed_at);
  if (Number.isNaN(startedMs) || Number.isNaN(completedMs)) return entry;
  if (completedMs >= startedMs) return entry;
  return {
    ...entry,
    completed_at: entry.started_at,
    _clamped: true,
    _original_completed_at: entry.completed_at,
  };
}
