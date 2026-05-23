/**
 * tests/scripts/lib/memory-proposals/auq-partition.test.mjs
 *
 * Unit tests for scripts/lib/memory-proposals/auq-partition.mjs.
 *
 * Coverage targets:
 *  - _partitionForAuq() — pure function partitioning a memory-proposal queue
 *    into AUQ-renderable batches of 4 (FIFO).
 *
 * Behavior contract (per scripts/lib/memory-proposals/auq-partition.mjs):
 *  - Empty queue / non-array input → { batches: [], totalBatches: 0 } (silent skip)
 *  - 1..4 items → single batch of original items, FIFO order
 *  - 5+ items → sequential FIFO batches of 4; last batch may be < 4
 *
 * Style: describe/it, hardcoded literal expected values, no branching in tests.
 * Each test uses `.toEqual` for exact deep equality.
 *
 * Falsification notes (justify each test's value per .claude/rules/test-quality.md):
 *  - If BATCH_SIZE were 5: test 4 (5 items) would yield 1 batch not 2 → test fails.
 *  - If FIFO were not preserved (e.g., reverse): test 5 (9 items) would see
 *    batches[0] = [6,7,8,9] not [1,2,3,4] → test fails.
 *  - If empty-array guard were removed: tests 1, 6, 7, 8 would throw or return
 *    a non-empty shape → tests fail.
 *  - If `totalBatches` were computed differently (e.g., based on input length
 *    not batches.length): test 4 (5 items) would yield totalBatches=5 not 2.
 *  - If `.slice` were `.splice` (mutating): would not affect single-shot tests
 *    but would corrupt the input — covered by test that the function does NOT
 *    mutate the input array (test 10).
 */

import { describe, expect, it } from 'vitest';

import { _partitionForAuq } from '@lib/memory-proposals/auq-partition.mjs';

describe('_partitionForAuq', () => {
  // -------------------------------------------------------------------------
  // 1. Empty queue → silent skip
  // -------------------------------------------------------------------------
  it('partitions empty queue to no batches (silent skip)', () => {
    expect(_partitionForAuq([])).toEqual({ batches: [], totalBatches: 0 });
  });

  // -------------------------------------------------------------------------
  // 2. Single item → one batch of one
  // -------------------------------------------------------------------------
  it('partitions single item to one batch', () => {
    expect(_partitionForAuq([{ id: 'a' }])).toEqual({
      batches: [[{ id: 'a' }]],
      totalBatches: 1,
    });
  });

  // -------------------------------------------------------------------------
  // 3. Exactly 4 items → one batch of 4 (boundary: even multiple)
  // -------------------------------------------------------------------------
  it('partitions exactly 4 items to one batch (boundary)', () => {
    expect(
      _partitionForAuq([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]),
    ).toEqual({
      batches: [[{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]],
      totalBatches: 1,
    });
  });

  // -------------------------------------------------------------------------
  // 4. 5 items → 4 + 1 (FIFO preserved at boundary crossing)
  // -------------------------------------------------------------------------
  it('partitions 5 items to two batches (4+1, FIFO)', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    const d = { id: 'd' };
    const e = { id: 'e' };
    expect(_partitionForAuq([a, b, c, d, e])).toEqual({
      batches: [
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
        [{ id: 'e' }],
      ],
      totalBatches: 2,
    });
  });

  // -------------------------------------------------------------------------
  // 5. 9 items → 4 + 4 + 1 (FIFO preserved across multiple batches)
  // -------------------------------------------------------------------------
  it('partitions 9 items to three batches (4+4+1, FIFO preserved)', () => {
    expect(_partitionForAuq([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual({
      batches: [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9],
      ],
      totalBatches: 3,
    });
  });

  // -------------------------------------------------------------------------
  // 6. null input → silent skip
  // -------------------------------------------------------------------------
  it('returns empty when input is null', () => {
    expect(_partitionForAuq(null)).toEqual({ batches: [], totalBatches: 0 });
  });

  // -------------------------------------------------------------------------
  // 7. undefined input → silent skip
  // -------------------------------------------------------------------------
  it('returns empty when input is undefined', () => {
    expect(_partitionForAuq(undefined)).toEqual({ batches: [], totalBatches: 0 });
  });

  // -------------------------------------------------------------------------
  // 8. non-array input → silent skip
  // -------------------------------------------------------------------------
  it('returns empty when input is not an array', () => {
    expect(_partitionForAuq('not-array')).toEqual({ batches: [], totalBatches: 0 });
  });

  // -------------------------------------------------------------------------
  // 9. Exactly 8 items → 4 + 4 (boundary: even multiple, no remainder)
  // -------------------------------------------------------------------------
  it('partitions 8 items to two batches of exactly 4 each', () => {
    expect(_partitionForAuq([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({
      batches: [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ],
      totalBatches: 2,
    });
  });

  // -------------------------------------------------------------------------
  // 10. Input mutation guard — function MUST NOT mutate caller's queue
  // -------------------------------------------------------------------------
  it('does not mutate the input array', () => {
    const input = [1, 2, 3, 4, 5, 6, 7];
    _partitionForAuq(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
