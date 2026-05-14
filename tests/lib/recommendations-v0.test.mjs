import { describe, it, expect } from 'vitest';
import { computeV0Recommendation, isValidMode } from '@lib/recommendations-v0.mjs';

describe('computeV0Recommendation', () => {
  describe('rule branches', () => {
    it('branch 1: completionRate < 0.5 → plan-retro', () => {
      const r = computeV0Recommendation({
        completionRate: 0.3,
        carryoverRatio: 0.1,
        carryoverIssues: [42],
      });
      expect(r.mode).toBe('plan-retro');
      expect(r.rationale).toBe('v0: completion <50% → retro');
      expect(r.priorities).toEqual([42]);
    });

    it('branch 2: carryoverRatio ≥ 0.3 (completion OK) → deep', () => {
      const r = computeV0Recommendation({
        completionRate: 0.8,
        carryoverRatio: 0.4,
        carryoverIssues: [100, 101],
      });
      expect(r.mode).toBe('deep');
      expect(r.rationale).toBe('v0: carryover ≥30% → deep');
    });

    it('branch 3: clean completion → feature', () => {
      const r = computeV0Recommendation({
        completionRate: 1.0,
        carryoverRatio: 0.0,
        carryoverIssues: [],
      });
      expect(r.mode).toBe('feature');
      expect(r.rationale).toBe('v0: default clean completion');
      expect(r.priorities).toEqual([]);
    });

    it('branch 1 wins over branch 2 when both fire', () => {
      const r = computeV0Recommendation({
        completionRate: 0.2,
        carryoverRatio: 0.5,
        carryoverIssues: [1, 2, 3],
      });
      expect(r.mode).toBe('plan-retro');
    });
  });

  describe('boundary cases', () => {
    it('completionRate exactly 0.50 → branch 1 does NOT fire', () => {
      const r = computeV0Recommendation({
        completionRate: 0.5,
        carryoverRatio: 0.0,
        carryoverIssues: [],
      });
      expect(r.mode).toBe('feature');
    });

    it('carryoverRatio exactly 0.30 → branch 2 fires', () => {
      const r = computeV0Recommendation({
        completionRate: 1.0,
        carryoverRatio: 0.3,
        carryoverIssues: [],
      });
      expect(r.mode).toBe('deep');
    });

    it('priorities capped at 5 entries', () => {
      const r = computeV0Recommendation({
        completionRate: 0.8,
        carryoverRatio: 0.4,
        carryoverIssues: [1, 2, 3, 4, 5, 6, 7, 8],
      });
      expect(r.priorities).toHaveLength(5);
      expect(r.priorities).toEqual([1, 2, 3, 4, 5]);
    });

    it('coerces string issue IDs to integers', () => {
      const r = computeV0Recommendation({
        completionRate: 0.8,
        carryoverRatio: 0.4,
        carryoverIssues: ['272', '273'],
      });
      expect(r.priorities).toEqual([272, 273]);
    });

    it('throws on non-numeric completionRate', () => {
      expect(() =>
        computeV0Recommendation({
          completionRate: 'nope',
          carryoverRatio: 0,
        }),
      ).toThrow(TypeError);
    });

    it('throws on NaN carryoverRatio', () => {
      expect(() =>
        computeV0Recommendation({
          completionRate: 0.8,
          carryoverRatio: NaN,
        }),
      ).toThrow(TypeError);
    });
  });
});

describe('isValidMode', () => {
  it('accepts all 6 canonical modes', () => {
    for (const m of ['housekeeping', 'feature', 'deep', 'discovery', 'evolve', 'plan-retro']) {
      expect(isValidMode(m)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isValidMode('express')).toBe(false);
    expect(isValidMode('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidMode(null)).toBe(false);
    expect(isValidMode(undefined)).toBe(false);
    expect(isValidMode(42)).toBe(false);
  });
});
