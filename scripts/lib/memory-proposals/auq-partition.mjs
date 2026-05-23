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
