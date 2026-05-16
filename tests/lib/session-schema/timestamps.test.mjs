/**
 * tests/lib/session-schema/timestamps.test.mjs
 *
 * Vitest suite for scripts/lib/session-schema/timestamps.mjs.
 * Covers: no-op paths (both fields absent, one absent, equal timestamps,
 * completed > started), inversion detection + clamp, forensics fields,
 * non-mutation, non-plain-object pass-through.
 */

import { describe, it, expect } from 'vitest';
import { clampTimestampsMonotonic } from '@lib/session-schema/timestamps.mjs';

// ---------------------------------------------------------------------------
// No-op paths (entry returned unchanged by reference)
// ---------------------------------------------------------------------------

describe('clampTimestampsMonotonic — no-op paths', () => {
  it('returns null by reference', () => {
    expect(clampTimestampsMonotonic(null)).toBe(null);
  });

  it('returns string by reference', () => {
    expect(clampTimestampsMonotonic('nope')).toBe('nope');
  });

  it('returns array by reference', () => {
    const arr = [1, 2, 3];
    expect(clampTimestampsMonotonic(arr)).toBe(arr);
  });

  it('returns entry unchanged when neither timestamp field present', () => {
    const entry = { session_id: 'sess-no-ts' };
    expect(clampTimestampsMonotonic(entry)).toBe(entry);
  });

  it('returns entry unchanged when only started_at present', () => {
    const entry = { session_id: 's', started_at: '2026-04-24T08:00:00Z' };
    expect(clampTimestampsMonotonic(entry)).toBe(entry);
  });

  it('returns entry unchanged when only completed_at present', () => {
    const entry = { session_id: 's', completed_at: '2026-04-24T08:00:00Z' };
    expect(clampTimestampsMonotonic(entry)).toBe(entry);
  });

  it('returns entry unchanged when started_at is unparsable', () => {
    const entry = {
      started_at: 'not-a-date',
      completed_at: '2026-04-24T08:00:00Z',
    };
    expect(clampTimestampsMonotonic(entry)).toBe(entry);
  });

  it('returns entry unchanged when completed_at is unparsable', () => {
    const entry = {
      started_at: '2026-04-24T08:00:00Z',
      completed_at: 'still-not-a-date',
    };
    expect(clampTimestampsMonotonic(entry)).toBe(entry);
  });

  it('returns entry unchanged when completed_at equals started_at (zero-duration)', () => {
    const entry = {
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T08:00:00Z',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toBe(entry);
    expect(out._clamped).toBeUndefined();
  });

  it('returns entry unchanged when completed_at is later than started_at', () => {
    const entry = {
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T09:30:00Z',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out).toBe(entry);
    expect(out._clamped).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Clamp paths (inversion detected)
// ---------------------------------------------------------------------------

describe('clampTimestampsMonotonic — inversion clamp', () => {
  it('returns a NEW object (does not mutate input) on inversion', () => {
    const entry = {
      session_id: 'inv-1',
      started_at: '2026-04-24T10:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
    };
    const snapshot = JSON.parse(JSON.stringify(entry));
    const out = clampTimestampsMonotonic(entry);
    expect(out).not.toBe(entry);
    expect(entry).toEqual(snapshot);
  });

  it('sets completed_at to started_at on inversion', () => {
    const entry = {
      started_at: '2026-04-24T10:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
    };
    const out = clampTimestampsMonotonic(entry);
    expect(out.completed_at).toBe('2026-04-24T10:00:00Z');
    expect(out.completed_at).toBe(out.started_at);
  });

  it('sets _clamped: true on the result', () => {
    const entry = {
      started_at: '2026-04-24T10:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
    };
    expect(clampTimestampsMonotonic(entry)._clamped).toBe(true);
  });

  it('sets _original_completed_at to the original value', () => {
    const original = '2026-04-24T09:00:00Z';
    const entry = {
      started_at: '2026-04-24T10:00:00Z',
      completed_at: original,
    };
    expect(clampTimestampsMonotonic(entry)._original_completed_at).toBe(original);
  });

  it('full deterministic clamp shape — 1h inversion', () => {
    const entry = {
      session_id: 'inv-1h',
      started_at: '2026-04-24T11:00:00Z',
      completed_at: '2026-04-24T10:00:00Z',
    };
    expect(clampTimestampsMonotonic(entry)).toEqual({
      session_id: 'inv-1h',
      started_at: '2026-04-24T11:00:00Z',
      completed_at: '2026-04-24T11:00:00Z',
      _clamped: true,
      _original_completed_at: '2026-04-24T10:00:00Z',
    });
  });
});
