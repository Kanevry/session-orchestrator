import { describe, it, expect } from 'vitest';
import { buildPassthroughRationale } from '../../../scripts/lib/mode-selector/rationale.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const threeSessions = (mode, completionRate = 1.0) => [
  { session_type: mode, completion_rate: completionRate },
  { session_type: mode, completion_rate: completionRate },
  { session_type: mode, completion_rate: completionRate },
];

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
describe('buildPassthroughRationale — determinism', () => {
  it('same inputs produce the same output (no random/date)', () => {
    const signals = { recentSessions: threeSessions('feature'), bootstrapLock: { tier: 'standard' } };
    const r1 = buildPassthroughRationale('feature', 0.75, signals);
    const r2 = buildPassthroughRationale('feature', 0.75, signals);
    expect(r1).toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// Stale-signals path (no active signals)
// ---------------------------------------------------------------------------
describe('buildPassthroughRationale — stale signals', () => {
  it('empty signals → "stale signals" rationale', () => {
    const r = buildPassthroughRationale('feature', 0.5, {});
    expect(r).toMatch(/stale/i);
  });

  it('null learnings + empty sessions + null bootstrapLock → stale rationale', () => {
    const r = buildPassthroughRationale('feature', 0.5, {
      learnings: [],
      recentSessions: [],
      bootstrapLock: null,
    });
    expect(r).toMatch(/stale/i);
  });
});

// ---------------------------------------------------------------------------
// Trend path
// ---------------------------------------------------------------------------
describe('buildPassthroughRationale — trend reinforcement', () => {
  it('3 matching sessions → rationale mentions "trend"', () => {
    const signals = { recentSessions: threeSessions('feature') };
    const r = buildPassthroughRationale('feature', 0.65, signals);
    expect(r).toMatch(/trend/i);
  });

  it('3 matching sessions + tier alignment → rationale mentions both "trend" and "tier"', () => {
    const signals = {
      recentSessions: threeSessions('feature'),
      bootstrapLock: { tier: 'standard' },
    };
    const r = buildPassthroughRationale('feature', 0.75, signals);
    expect(r).toMatch(/trend/i);
    expect(r).toMatch(/tier/i);
  });
});

// ---------------------------------------------------------------------------
// Tier-alignment path
// ---------------------------------------------------------------------------
describe('buildPassthroughRationale — tier alignment', () => {
  it('bootstrapLock.tier standard aligning with feature → rationale mentions tier', () => {
    const signals = { bootstrapLock: { tier: 'standard' } };
    const r = buildPassthroughRationale('feature', 0.6, signals);
    expect(r).toMatch(/tier/i);
  });

  it('tier name is embedded in the rationale string', () => {
    const signals = { bootstrapLock: { tier: 'fast' } };
    const r = buildPassthroughRationale('housekeeping', 0.6, signals);
    expect(r).toContain('fast');
  });
});

// ---------------------------------------------------------------------------
// 120-character clamp
// ---------------------------------------------------------------------------
describe('buildPassthroughRationale — 120-char clamp', () => {
  it('always returns a string with length <= 120', () => {
    const cases = [
      [{}, 0.5],
      [{ recentSessions: threeSessions('feature'), bootstrapLock: { tier: 'standard' } }, 0.75],
      [{ bootstrapLock: { tier: 'deep' } }, 0.6],
      [{ recentSessions: threeSessions('deep') }, 0.65],
    ];
    for (const [signals, confidence] of cases) {
      const r = buildPassthroughRationale('feature', confidence, signals);
      expect(r.length).toBeLessThanOrEqual(120);
    }
  });

  it('passthrough-only path (no trend/tier) rationale is a non-empty string', () => {
    const signals = { bootstrapLock: { tier: 'standard' }, recentSessions: [] };
    const r = buildPassthroughRationale('feature', 0.5, signals);
    expect(r.length).toBeGreaterThan(0);
  });
});
