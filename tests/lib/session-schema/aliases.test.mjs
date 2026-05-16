/**
 * tests/lib/session-schema/aliases.test.mjs
 *
 * Vitest suite for scripts/lib/session-schema/aliases.mjs.
 * Covers: ended_at → completed_at alias, conflict detection,
 * duration_ms cleanup, non-plain-object pass-through, non-mutation.
 */

import { describe, it, expect } from 'vitest';
import { aliasLegacyEndedAt } from '@lib/session-schema/aliases.mjs';

// ---------------------------------------------------------------------------
// Pass-through (no mutation / no migration needed)
// ---------------------------------------------------------------------------

describe('aliasLegacyEndedAt — pass-through', () => {
  it('returns null by reference', () => {
    expect(aliasLegacyEndedAt(null)).toBe(null);
  });

  it('returns string by reference', () => {
    expect(aliasLegacyEndedAt('nope')).toBe('nope');
  });

  it('returns array by reference', () => {
    const arr = [];
    expect(aliasLegacyEndedAt(arr)).toBe(arr);
  });

  it('returns entry unchanged when neither completed_at nor ended_at present', () => {
    const entry = { session_id: 's', started_at: '2026-04-24T08:00:00Z' };
    expect(aliasLegacyEndedAt(entry)).toBe(entry);
  });
});

// ---------------------------------------------------------------------------
// ended_at → completed_at alias
// ---------------------------------------------------------------------------

describe('aliasLegacyEndedAt — alias migration', () => {
  it('aliases ended_at → completed_at when only ended_at present', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      ended_at: '2026-04-24T09:00:00Z',
    };
    const out = aliasLegacyEndedAt(entry);
    expect(out.completed_at).toBe('2026-04-24T09:00:00Z');
  });

  it('returns a NEW object (does not mutate input) on migration', () => {
    const entry = {
      session_id: 's',
      ended_at: '2026-04-24T09:00:00Z',
    };
    const snapshot = JSON.parse(JSON.stringify(entry));
    const out = aliasLegacyEndedAt(entry);
    expect(out).not.toBe(entry);
    expect(entry).toEqual(snapshot);
  });

  it('preserves ended_at alongside the new completed_at', () => {
    const entry = { session_id: 's', ended_at: '2026-04-24T09:00:00Z' };
    const out = aliasLegacyEndedAt(entry);
    expect(out.ended_at).toBe('2026-04-24T09:00:00Z');
    expect(out._completed_at_conflict).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

describe('aliasLegacyEndedAt — conflict detection', () => {
  it('tags _completed_at_conflict when both present and differ', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
      ended_at: '2026-04-24T09:30:00Z',
    };
    const out = aliasLegacyEndedAt(entry);
    expect(out._completed_at_conflict).toBe(true);
    expect(out.completed_at).toBe('2026-04-24T09:00:00Z'); // canonical wins
  });

  it('no conflict tag when both present and equal', () => {
    const entry = {
      completed_at: '2026-04-24T09:00:00Z',
      ended_at: '2026-04-24T09:00:00Z',
    };
    const out = aliasLegacyEndedAt(entry);
    expect(out._completed_at_conflict).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// duration_ms cleanup
// ---------------------------------------------------------------------------

describe('aliasLegacyEndedAt — duration_ms cleanup', () => {
  it('drops duration_ms when completed_at + started_at end up present via alias', () => {
    const entry = {
      session_id: 's',
      started_at: '2026-04-24T08:00:00Z',
      ended_at: '2026-04-24T09:00:00Z',
      duration_ms: 3600000,
    };
    const out = aliasLegacyEndedAt(entry);
    expect('duration_ms' in out).toBe(false);
  });

  it('drops duration_ms when both completed_at and started_at already canonical', () => {
    const entry = {
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
      ended_at: '2026-04-24T09:00:00Z',
      duration_ms: 3600000,
    };
    const out = aliasLegacyEndedAt(entry);
    expect('duration_ms' in out).toBe(false);
  });

  it('leaves duration_ms intact when started_at is absent', () => {
    const entry = {
      session_id: 's',
      ended_at: '2026-04-24T09:00:00Z',
      duration_ms: 3600000,
    };
    const out = aliasLegacyEndedAt(entry);
    expect(out.duration_ms).toBe(3600000);
  });
});
