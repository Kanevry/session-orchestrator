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
