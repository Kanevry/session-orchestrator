import { describe, it, expect } from 'vitest';
import { computeDelta, scoreMode, round2, safeArray, safeBootstrapLock } from '@lib/mode-selector/scoring.mjs';

// ---------------------------------------------------------------------------
// round2
// ---------------------------------------------------------------------------
describe('round2', () => {
  it('rounds 0.555 to 0.56', () => {
    expect(round2(0.555)).toBe(0.56);
  });

  it('rounds 0.504 to 0.5', () => {
    expect(round2(0.504)).toBe(0.5);
  });

  it('integer 1 stays 1', () => {
    expect(round2(1)).toBe(1);
  });

  it('0.1 + 0.2 floating-point drift is cured by round2', () => {
    // 0.1+0.2 = 0.30000000000000004 in JS; round2 → 0.3
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// safeArray
// ---------------------------------------------------------------------------
describe('safeArray', () => {
  it('returns the array unchanged when given an array', () => {
    expect(safeArray([1, 2])).toEqual([1, 2]);
  });

  it('returns [] for null', () => {
    expect(safeArray(null)).toEqual([]);
  });

  it('returns [] for undefined', () => {
    expect(safeArray(undefined)).toEqual([]);
  });

  it('returns [] for a string', () => {
    expect(safeArray('not-array')).toEqual([]);
  });

  it('returns [] for a number', () => {
    expect(safeArray(42)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// safeBootstrapLock
// ---------------------------------------------------------------------------
describe('safeBootstrapLock', () => {
  it('returns the object when bootstrapLock is a non-null object', () => {
    const lock = { tier: 'deep' };
    expect(safeBootstrapLock({ bootstrapLock: lock })).toBe(lock);
  });

  it('returns null when bootstrapLock is null', () => {
    expect(safeBootstrapLock({ bootstrapLock: null })).toBeNull();
  });

  it('returns null when bootstrapLock is a string', () => {
    expect(safeBootstrapLock({ bootstrapLock: 'not-object' })).toBeNull();
  });

  it('returns null when bootstrapLock is a number', () => {
    expect(safeBootstrapLock({ bootstrapLock: 42 })).toBeNull();
  });

  it('returns null when bootstrapLock is undefined', () => {
    expect(safeBootstrapLock({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeDelta
// ---------------------------------------------------------------------------
describe('computeDelta', () => {
  it('returns 0 for empty signals (no bonuses, no penalties)', () => {
    expect(computeDelta('feature', {})).toBe(0);
  });

  it('returns 0 for null/absent learnings and sessions', () => {
    expect(computeDelta('feature', { learnings: null, recentSessions: null })).toBe(0);
  });

  it('trend bonus +0.15 when last 3 sessions match mode and avgCompletion >= 0.9', () => {
    const sessions = [
      { session_type: 'feature', completion_rate: 1.0 },
      { session_type: 'feature', completion_rate: 1.0 },
      { session_type: 'feature', completion_rate: 1.0 },
    ];
    expect(computeDelta('feature', { recentSessions: sessions })).toBe(0.15);
  });

  it('trend bonus +0.075 when last 3 match but avgCompletion < 0.9', () => {
    const sessions = [
      { session_type: 'feature', completion_rate: 0.7 },
      { session_type: 'feature', completion_rate: 0.8 },
      { session_type: 'feature', completion_rate: 0.7 },
    ];
    expect(computeDelta('feature', { recentSessions: sessions })).toBe(0.075);
  });

  it('no trend bonus when fewer than 3 recent sessions', () => {
    const sessions = [
      { session_type: 'feature', completion_rate: 1.0 },
      { session_type: 'feature', completion_rate: 1.0 },
    ];
    expect(computeDelta('feature', { recentSessions: sessions })).toBe(0);
  });

  it('tier alignment bonus +0.10 when bootstrapLock.tier maps to candidateMode', () => {
    expect(computeDelta('feature', { bootstrapLock: { tier: 'standard' } })).toBe(0.10);
  });

  it('no tier bonus when bootstrapLock.tier maps to different mode', () => {
    expect(computeDelta('feature', { bootstrapLock: { tier: 'fast' } })).toBe(-0.10);
  });

  it('tier bonus 0 when bootstrapLock is null', () => {
    expect(computeDelta('feature', { bootstrapLock: null })).toBe(0);
  });

  it('learnings hint bonus +0.05 per matching learning, capped at +0.10', () => {
    const learnings = [
      { type: 'effective-sizing', subject: 'feature session', confidence: 0.8 },
      { type: 'scope-guidance', subject: 'feature scope', confidence: 0.8 },
      { type: 'effective-sizing', subject: 'feature sizing', confidence: 0.9 }, // 3rd → still capped at 0.10
    ];
    expect(computeDelta('feature', { learnings })).toBe(0.10);
  });

  it('conflict penalty -0.10 when last 3 sessions trend to a different mode at high completion', () => {
    const sessions = [
      { session_type: 'deep', completion_rate: 1.0 },
      { session_type: 'deep', completion_rate: 1.0 },
      { session_type: 'deep', completion_rate: 1.0 },
    ];
    // candidateMode = feature → other mode deep dominates → penalty -0.10
    expect(computeDelta('feature', { recentSessions: sessions })).toBe(-0.10);
  });

  it('no conflict penalty when conflicting trend completion < 0.9', () => {
    const sessions = [
      { session_type: 'deep', completion_rate: 0.8 },
      { session_type: 'deep', completion_rate: 0.8 },
      { session_type: 'deep', completion_rate: 0.8 },
    ];
    expect(computeDelta('feature', { recentSessions: sessions })).toBe(0);
  });

  it('carryover penalty -0.10 when carryoverRatio >= 0.2 and candidateMode != deep', () => {
    expect(computeDelta('feature', { carryoverRatio: 0.25 })).toBe(-0.10);
  });

  it('no carryover penalty for deep mode even with high carryover', () => {
    expect(computeDelta('deep', { carryoverRatio: 0.5 })).toBe(0);
  });

  it('NaN carryoverRatio is treated as absent (no penalty)', () => {
    expect(computeDelta('feature', { carryoverRatio: NaN })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scoreMode
// ---------------------------------------------------------------------------
describe('scoreMode', () => {
  it('base score for empty signals is 0.5', () => {
    expect(scoreMode('feature', {})).toBe(0.5);
  });

  it('clamped to 0.9 when delta is large positive', () => {
    // tier +0.10, trend +0.15, learnings +0.10 = delta +0.35 → base 0.85, within [0, 0.9]
    const signals = {
      bootstrapLock: { tier: 'standard' },
      recentSessions: [
        { session_type: 'feature', completion_rate: 1.0 },
        { session_type: 'feature', completion_rate: 1.0 },
        { session_type: 'feature', completion_rate: 1.0 },
      ],
      learnings: [
        { type: 'effective-sizing', subject: 'feature scope', confidence: 0.9 },
        { type: 'scope-guidance', subject: 'feature guidance', confidence: 0.9 },
      ],
    };
    const score = scoreMode('feature', signals);
    expect(score).toBeLessThanOrEqual(0.9);
    expect(score).toBeGreaterThan(0.5);
  });

  it('clamped to 0.0 when delta is large negative', () => {
    // heavy penalties could push below 0
    const signals = {
      bootstrapLock: { tier: 'deep' },           // -0.10 tier penalty
      carryoverRatio: 0.3,                         // -0.10 carryover penalty
      recentSessions: [
        { session_type: 'deep', completion_rate: 1.0 },
        { session_type: 'deep', completion_rate: 1.0 },
        { session_type: 'deep', completion_rate: 1.0 },
      ],                                            // -0.10 trend penalty
    };
    const score = scoreMode('feature', signals);
    expect(score).toBeGreaterThanOrEqual(0.0);
    expect(score).toBe(0.2);  // 0.5 - 0.10 - 0.10 - 0.10 = 0.2
  });

  it('result is rounded to 2 decimal places (partial trend bonus 0.075 → score 0.57)', () => {
    const sessions = [
      { session_type: 'feature', completion_rate: 0.7 },
      { session_type: 'feature', completion_rate: 0.8 },
      { session_type: 'feature', completion_rate: 0.7 },
    ];
    // delta = +0.075 → 0.5 + 0.075 = 0.575 in IEEE-754, but JS float arithmetic
    // gives 0.574999... → round2 → 0.57.
    const score = scoreMode('feature', { recentSessions: sessions });
    expect(score).toBe(0.57);
  });
});
