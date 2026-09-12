/**
 * tests/lib/session-schema/filters.test.mjs
 *
 * Covers scripts/lib/session-schema/filters.mjs (#834) — the abandoned-aware
 * session filters shared by every consumer whose window is meant to represent
 * REAL work rather than raw ledger lines.
 */

import { describe, it, expect } from 'vitest';
import {
  isRealSession,
  filterRealSessions,
  tailRealSessions,
  isCoordinatorDirectHousekeeping,
} from '@lib/session-schema/filters.mjs';
import * as barrel from '@lib/session-schema.mjs';

const real = (id) => ({ session_id: id, session_type: 'deep' });
const abandoned = (id) => ({ session_id: id, session_type: 'deep', status: 'abandoned' });
const completed = (id) => ({ session_id: id, session_type: 'deep', status: 'completed' });

describe('isRealSession', () => {
  it('returns true for a record with no status field', () => {
    expect(isRealSession(real('s-1'))).toBe(true);
  });

  it('returns true for status completed', () => {
    expect(isRealSession(completed('s-1'))).toBe(true);
  });

  it('returns false for status abandoned', () => {
    expect(isRealSession(abandoned('s-1'))).toBe(false);
  });

  it('returns false for null, undefined, arrays and primitives', () => {
    expect(isRealSession(null)).toBe(false);
    expect(isRealSession(undefined)).toBe(false);
    expect(isRealSession([])).toBe(false);
    expect(isRealSession('abandoned')).toBe(false);
    expect(isRealSession(42)).toBe(false);
  });
});

describe('filterRealSessions', () => {
  it('drops abandoned records and preserves source order', () => {
    const input = [real('a'), abandoned('b'), completed('c'), abandoned('d'), real('e')];
    expect(filterRealSessions(input).map((r) => r.session_id)).toEqual(['a', 'c', 'e']);
  });

  it('returns an empty array for non-array input', () => {
    expect(filterRealSessions(null)).toEqual([]);
    expect(filterRealSessions(undefined)).toEqual([]);
    expect(filterRealSessions('nope')).toEqual([]);
    expect(filterRealSessions({ 0: real('a'), length: 1 })).toEqual([]);
  });

  it('drops null members without throwing', () => {
    expect(filterRealSessions([real('a'), null, abandoned('b')]).map((r) => r.session_id)).toEqual(['a']);
  });
});

describe('tailRealSessions', () => {
  it('takes the last N REAL sessions, not the last N lines', () => {
    // 10 lines, the last 6 of which are phantoms — mirrors the real ledger
    // shape observed in this repo when #834 was filed.
    const input = [
      real('r1'), real('r2'), real('r3'), real('r4'),
      abandoned('p1'), abandoned('p2'), abandoned('p3'),
      abandoned('p4'), abandoned('p5'), abandoned('p6'),
    ];

    // The defect this pins: a raw slice(-4) would return four phantoms.
    expect(input.slice(-4).every((r) => r.status === 'abandoned')).toBe(true);

    expect(tailRealSessions(input, 4).map((r) => r.session_id)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('reaches further back than the raw line window to fill N', () => {
    const input = [real('old'), abandoned('p1'), real('mid'), abandoned('p2'), real('new')];
    expect(tailRealSessions(input, 3).map((r) => r.session_id)).toEqual(['old', 'mid', 'new']);
  });

  it('returns all real sessions when N exceeds the real count', () => {
    expect(tailRealSessions([real('a'), abandoned('b')], 99).map((r) => r.session_id)).toEqual(['a']);
  });

  it('returns an empty array for non-positive or non-finite N', () => {
    const input = [real('a'), real('b')];
    expect(tailRealSessions(input, 0)).toEqual([]);
    expect(tailRealSessions(input, -3)).toEqual([]);
    expect(tailRealSessions(input, NaN)).toEqual([]);
    expect(tailRealSessions(input, Infinity)).toEqual([]);
    expect(tailRealSessions(input, '2')).toEqual([]);
  });

  it('floors a fractional N rather than producing a fractional slice', () => {
    const input = [real('a'), real('b'), real('c')];
    expect(tailRealSessions(input, 2.9).map((r) => r.session_id)).toEqual(['b', 'c']);
  });

  it('returns an empty array for non-array input', () => {
    expect(tailRealSessions(null, 5)).toEqual([]);
  });
});

describe('isCoordinatorDirectHousekeeping', () => {
  const hk = { wave: 1, role: 'Housekeeping', agent_count: 0, coordinator_direct: true };
  const withWaves = (waves) => ({ session_id: 's-1', session_type: 'housekeeping', waves });

  it('returns true for the one-wave coordinator-direct Housekeeping writer shape', () => {
    expect(isCoordinatorDirectHousekeeping(withWaves([hk]))).toBe(true);
  });

  it('returns false when a real wave sits beside the Housekeeping wave', () => {
    const real = { wave: 2, role: 'Quality', agent_count: 3 };
    expect(isCoordinatorDirectHousekeeping(withWaves([hk, real]))).toBe(false);
  });

  it('returns false for a coordinator-direct wave that is not Housekeeping', () => {
    const implCore = { wave: 1, role: 'Impl-Core', coordinator_direct: true };
    expect(isCoordinatorDirectHousekeeping(withWaves([implCore]))).toBe(false);
  });

  it('returns false for empty or absent waves, and for non-records', () => {
    expect(isCoordinatorDirectHousekeeping(withWaves([]))).toBe(false);
    expect(isCoordinatorDirectHousekeeping({ session_type: 'housekeeping' })).toBe(false);
    expect(isCoordinatorDirectHousekeeping(null)).toBe(false);
  });
});

describe('barrel re-export', () => {
  it('exposes all three helpers from scripts/lib/session-schema.mjs', () => {
    expect(barrel.isRealSession).toBe(isRealSession);
    expect(barrel.filterRealSessions).toBe(filterRealSessions);
    expect(barrel.tailRealSessions).toBe(tailRealSessions);
  });
});
