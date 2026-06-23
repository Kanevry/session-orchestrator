/**
 * memory-cleanup-stamp.mjs — Pure helper: stamp `memory_cleanup_at` on a
 * session record when `/memory-cleanup` ran this session.
 *
 * Issue #699 fix: a healthy no-op run of `/memory-cleanup` previously left
 * `memory_cleanup_at` unstamped, so `auto-dream.mjs` `readDreamSignals`
 * never advanced `lastCleanupAt` and `shouldDispatchAutoDream` kept firing a
 * false nudge. This helper stamps the field unconditionally whenever the
 * cleanup ran — including a healthy no-op where no memory files were mutated.
 *
 * Design constraints:
 *   - Pure function — no I/O, no side-effects.
 *   - No-throw — invalid inputs return the record unchanged (defensive).
 *   - Testable seam — the Quality wave (Q2) unit-tests this function directly.
 *   - No external deps — Node 20+ stdlib only (none needed here).
 */

/**
 * Stamp `memory_cleanup_at` on a session record when `/memory-cleanup` ran.
 *
 * A cleanup run includes ALL outcomes: dry-run, apply-pending, AND healthy
 * no-op (MEMORY.md already healthy — no files mutated). The cadence marker
 * MUST advance even on a no-op so `shouldDispatchAutoDream` does not fire a
 * false nudge on the next session.
 *
 * @param {object} record       The in-memory session record object (not mutated).
 * @param {object} opts
 * @param {boolean} opts.ranCleanup  True when `/memory-cleanup` ran this session
 *   in any mode (dry-run, apply-pending, or interactive/healthy no-op).
 *   False or absent → return record unchanged.
 * @param {string}  opts.completedAt ISO-8601 UTC timestamp to write as
 *   `memory_cleanup_at`. Typically the session's `completed_at` value.
 *   Required when `ranCleanup === true`; if missing, returns record unchanged
 *   (defensive — never throws).
 * @returns {object} Shallow-cloned record with `memory_cleanup_at` set, OR
 *   the original record object when no stamp is applied.
 */
export function stampMemoryCleanup(record, { ranCleanup, completedAt } = {}) {
  // Guard: only stamp when the cleanup actually ran.
  if (ranCleanup !== true) {
    return record;
  }

  // Guard: completedAt is required to stamp; if missing, skip defensively.
  if (typeof completedAt !== 'string' || completedAt.length === 0) {
    return record;
  }

  // Guard: record must be a plain object; anything else is returned unchanged.
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }

  // Return a shallow clone with the stamp applied — never mutate the input.
  return { ...record, memory_cleanup_at: completedAt };
}
