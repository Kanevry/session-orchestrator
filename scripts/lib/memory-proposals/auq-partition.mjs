/**
 * Partition a memory-proposal queue into AUQ-renderable batches of 4 (FIFO).
 *
 * Behavior:
 *   - Empty queue → no batches (silent skip)
 *   - 1-4 items → single batch
 *   - 5+ items → sequential FIFO batches of 4 (last batch may be < 4)
 *
 * Pure function — no I/O, no side effects.
 *
 * PROBATION NOTE (#548 A2): This module currently has 0 production call-sites.
 * It is consumed only by skills/session-end/SKILL.md prose (which inlines the
 * partitioning logic at AUQ render time, not via this exported function).
 * If no second production call-site emerges in PRD F2.x follow-ups
 * (auto-dream rollup, peer-cards consolidation), this module should be
 * inlined back into the consuming skill — it is a candidate seam, not a
 * settled boundary.
 *
 * Tests-to-impl ratio is 5.7× (~9 tests / ~7 LOC fn) — a canary for
 * over-tested speculative seams.
 *
 * DEADLINE (#554 A1): PRD F2.2 close — review-gated, not wall-clock. If no
 * production ESM-static call-site lands by PRD F2.2 close, the cleanup
 * action below MUST be executed by the session-end coordinator. (We chose
 * a feature-wave deadline over a wall-clock failing test to avoid
 * cross-timezone CI flakiness — see #554 W1-D4.)
 *
 * Cleanup action (if probation expires at PRD F2.2 close with 0 static callers):
 *   1. Inline the 8-line for-loop (lines 26-34 of this file) back into
 *      `skills/session-end/SKILL.md` (currently lines 370-377: replace the
 *      `_partitionForAuq` import + call with the inlined loop body).
 *   2. Delete `scripts/lib/memory-proposals/auq-partition.mjs` (this file).
 *   3. Delete `tests/scripts/lib/memory-proposals/auq-partition.test.mjs`.
 *   4. Update any remaining prose mentions of `_partitionForAuq` in skills/.
 *
 * @param {Array<object>} queue — items to partition (each item is a memory-proposal record).
 * @returns {{batches: object[][], totalBatches: number}}
 */
export function _partitionForAuq(queue) {
  if (!Array.isArray(queue) || queue.length === 0) {
    return { batches: [], totalBatches: 0 };
  }
  const BATCH_SIZE = 4;
  const batches = [];
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    batches.push(queue.slice(i, i + BATCH_SIZE));
  }
  return { batches, totalBatches: batches.length };
}
