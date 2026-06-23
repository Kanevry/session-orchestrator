/**
 * tests/lib/memory-cleanup-stamp.test.mjs
 *
 * Unit tests for scripts/lib/memory-cleanup-stamp.mjs (Issue #699).
 *
 * stampMemoryCleanup is a pure function — no I/O, no external deps.
 * All tests assert on the REAL return value; nothing is mocked.
 *
 * Falsification guarantee: if stampMemoryCleanup() stopped stamping
 * memory_cleanup_at (e.g., removed the `{ ...record, memory_cleanup_at }` line),
 * the "stamps memory_cleanup_at" tests below would fail because
 * `result.memory_cleanup_at` would be `undefined`, not the hardcoded timestamp.
 */

import { describe, it, expect } from 'vitest';
import { stampMemoryCleanup } from '@lib/memory-cleanup-stamp.mjs';

// ---------------------------------------------------------------------------
// Happy path — ranCleanup:true + valid completedAt
// ---------------------------------------------------------------------------

describe('stampMemoryCleanup — ranCleanup:true + valid completedAt', () => {
  it('returns a NEW object (shallow clone) with memory_cleanup_at set to completedAt', () => {
    const record = { session_id: 'sess-1', started_at: '2026-06-20T10:00:00Z' };
    const result = stampMemoryCleanup(record, {
      ranCleanup: true,
      completedAt: '2026-06-20T11:00:00Z',
    });
    expect(result.memory_cleanup_at).toBe('2026-06-20T11:00:00Z');
  });

  it('does NOT mutate the original record (purity guarantee)', () => {
    const record = { session_id: 'sess-2', started_at: '2026-06-20T10:00:00Z' };
    stampMemoryCleanup(record, {
      ranCleanup: true,
      completedAt: '2026-06-20T11:00:00Z',
    });
    // The original object must not have gained memory_cleanup_at.
    expect(record.memory_cleanup_at).toBeUndefined();
  });

  it('returns a different object reference than the input (shallow clone)', () => {
    const record = { session_id: 'sess-3' };
    const result = stampMemoryCleanup(record, {
      ranCleanup: true,
      completedAt: '2026-06-21T09:00:00Z',
    });
    expect(result).not.toBe(record);
  });

  it('preserves all existing fields on the returned clone', () => {
    const record = { session_id: 'sess-4', session_type: 'deep', total_waves: 3 };
    const result = stampMemoryCleanup(record, {
      ranCleanup: true,
      completedAt: '2026-06-21T09:00:00Z',
    });
    expect(result.session_id).toBe('sess-4');
    expect(result.session_type).toBe('deep');
    expect(result.total_waves).toBe(3);
    expect(result.memory_cleanup_at).toBe('2026-06-21T09:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// #699 fix — healthy no-op cleanup MUST stamp (this is the regression guard)
// ---------------------------------------------------------------------------

describe('stampMemoryCleanup — no-op cleanup semantics (#699 fix)', () => {
  it('stamps memory_cleanup_at even when the cleanup was a healthy no-op (no files mutated)', () => {
    // Before #699, a no-op cleanup would NOT stamp memory_cleanup_at, causing
    // shouldDispatchAutoDream to keep firing false cadence nudges.
    // This test fails if the helper stops stamping on no-op runs.
    const record = {
      session_id: 'noop-1',
      started_at: '2026-06-21T08:00:00Z',
      completed_at: '2026-06-21T08:30:00Z',
      // No memory_cleanup_at yet — simulates a session where cleanup ran but was a no-op
    };
    const result = stampMemoryCleanup(record, {
      ranCleanup: true,
      completedAt: '2026-06-21T08:30:00Z',
    });
    expect(result.memory_cleanup_at).toBe('2026-06-21T08:30:00Z');
    // Original must stay pristine.
    expect(record.memory_cleanup_at).toBeUndefined();
  });

  it('stamps memory_cleanup_at for a dry-run cleanup (ranCleanup:true applies to dry-run too)', () => {
    const record = { session_id: 'dryrun-1', completed_at: '2026-06-22T10:00:00Z' };
    const result = stampMemoryCleanup(record, {
      ranCleanup: true,
      completedAt: '2026-06-22T10:00:00Z',
    });
    expect(result.memory_cleanup_at).toBe('2026-06-22T10:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// ranCleanup falsy — return record unchanged
// ---------------------------------------------------------------------------

describe('stampMemoryCleanup — ranCleanup falsy', () => {
  it('ranCleanup:false → returns the original record unchanged (no memory_cleanup_at added)', () => {
    const record = { session_id: 'no-cleanup-1', started_at: '2026-06-20T10:00:00Z' };
    const result = stampMemoryCleanup(record, {
      ranCleanup: false,
      completedAt: '2026-06-20T11:00:00Z',
    });
    expect(result).toBe(record);
    expect(result.memory_cleanup_at).toBeUndefined();
  });

  it('ranCleanup:undefined → returns the original record unchanged', () => {
    const record = { session_id: 'no-cleanup-2' };
    const result = stampMemoryCleanup(record, { completedAt: '2026-06-20T11:00:00Z' });
    expect(result).toBe(record);
    expect(result.memory_cleanup_at).toBeUndefined();
  });

  it('no opts at all → returns the original record unchanged', () => {
    const record = { session_id: 'no-cleanup-3' };
    const result = stampMemoryCleanup(record);
    expect(result).toBe(record);
    expect(result.memory_cleanup_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// completedAt missing / invalid — defensive no-stamp (no-throw)
// ---------------------------------------------------------------------------

describe('stampMemoryCleanup — ranCleanup:true + invalid/missing completedAt', () => {
  it('completedAt missing → returns record unchanged, does NOT throw', () => {
    const record = { session_id: 'bad-ts-1' };
    const result = stampMemoryCleanup(record, { ranCleanup: true });
    expect(result).toBe(record);
    expect(result.memory_cleanup_at).toBeUndefined();
  });

  it('completedAt empty string → returns record unchanged, does NOT throw', () => {
    const record = { session_id: 'bad-ts-2' };
    const result = stampMemoryCleanup(record, { ranCleanup: true, completedAt: '' });
    expect(result).toBe(record);
    expect(result.memory_cleanup_at).toBeUndefined();
  });

  it('completedAt is a number (not a string) → returns record unchanged, does NOT throw', () => {
    const record = { session_id: 'bad-ts-3' };
    // @ts-ignore — passing wrong type on purpose to test runtime guard
    const result = stampMemoryCleanup(record, { ranCleanup: true, completedAt: 1234567890 });
    expect(result).toBe(record);
    expect(result.memory_cleanup_at).toBeUndefined();
  });

  it('completedAt is null → returns record unchanged, does NOT throw', () => {
    const record = { session_id: 'bad-ts-4' };
    // @ts-ignore
    const result = stampMemoryCleanup(record, { ranCleanup: true, completedAt: null });
    expect(result).toBe(record);
    expect(result.memory_cleanup_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invalid record types — defensive passthrough (no-throw)
// ---------------------------------------------------------------------------

describe('stampMemoryCleanup — invalid record types', () => {
  it('record is null → returns null unchanged, does NOT throw', () => {
    const result = stampMemoryCleanup(null, { ranCleanup: true, completedAt: '2026-06-22T10:00:00Z' });
    expect(result).toBe(null);
  });

  it('record is an array → returns the array unchanged, does NOT throw', () => {
    const arr = [1, 2, 3];
    const result = stampMemoryCleanup(arr, { ranCleanup: true, completedAt: '2026-06-22T10:00:00Z' });
    expect(result).toBe(arr);
  });

  it('record is a string → returns the string unchanged, does NOT throw', () => {
    const result = stampMemoryCleanup('not-an-object', {
      ranCleanup: true,
      completedAt: '2026-06-22T10:00:00Z',
    });
    expect(result).toBe('not-an-object');
  });

  it('record is undefined → returns undefined unchanged, does NOT throw', () => {
    const result = stampMemoryCleanup(undefined, {
      ranCleanup: true,
      completedAt: '2026-06-22T10:00:00Z',
    });
    expect(result).toBeUndefined();
  });
});
