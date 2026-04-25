import { describe, it, expect } from 'vitest';
import { selectMode } from '../../scripts/lib/mode-selector.mjs';

describe('selectMode — scaffold contract', () => {
  describe('fallback paths', () => {
    it('null signals → feature fallback at confidence 0.0', () => {
      const r = selectMode(null);
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.0);
      expect(r.rationale).toMatch(/scaffold.*null/i);
      expect(r.alternatives).toEqual([]);
    });

    it('undefined signals → feature fallback at confidence 0.0', () => {
      const r = selectMode(undefined);
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.0);
      expect(r.rationale).toMatch(/scaffold.*null/i);
      expect(r.alternatives).toEqual([]);
    });

    it('empty object → feature fallback at confidence 0.0', () => {
      const r = selectMode({});
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.0);
      expect(r.rationale).toMatch(/missing|invalid/i);
      expect(r.alternatives).toEqual([]);
    });

    it('unknown recommendedMode string → feature fallback at confidence 0.0', () => {
      const r = selectMode({ recommendedMode: 'unknown-mode-foo' });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.0);
      expect(r.rationale).toMatch(/missing|invalid/i);
      expect(r.alternatives).toEqual([]);
    });

    it.each([42, {}, [], true])(
      'non-string recommendedMode %j → feature fallback at confidence 0.0',
      (value) => {
        const r = selectMode({ recommendedMode: value });
        expect(r.mode).toBe('feature');
        expect(r.confidence).toBe(0.0);
        expect(r.alternatives).toEqual([]);
      },
    );
  });

  describe('passthrough path', () => {
    it.each(['housekeeping', 'feature', 'deep', 'discovery', 'evolve', 'plan-retro'])(
      'valid recommendedMode %s → passthrough at confidence 0.5',
      (mode) => {
        const r = selectMode({ recommendedMode: mode });
        expect(r.mode).toBe(mode);
        expect(r.confidence).toBe(0.5);
        expect(r.rationale).toMatch(/passthrough/i);
        expect(r.alternatives).toEqual([]);
      },
    );
  });

  describe('shape contract', () => {
    const cases = [
      null,
      undefined,
      {},
      { recommendedMode: 'deep' },
      { recommendedMode: 'garbage' },
    ];

    it('every return has exactly 4 keys: alternatives, confidence, mode, rationale', () => {
      for (const input of cases) {
        const r = selectMode(input);
        expect(Object.keys(r).sort()).toEqual(['alternatives', 'confidence', 'mode', 'rationale']);
      }
    });

    it('alternatives is always an empty array', () => {
      for (const input of cases) {
        const r = selectMode(input);
        expect(Array.isArray(r.alternatives)).toBe(true);
        expect(r.alternatives.length).toBe(0);
      }
    });

    it('rationale is at most 120 chars', () => {
      for (const input of cases) {
        const r = selectMode(input);
        expect(r.rationale.length).toBeLessThanOrEqual(120);
      }
    });
  });

  describe('reserved fields (Phase B-3+ — still inert)', () => {
    it('signals.backlog does not change the output', () => {
      const baseline = selectMode({ recommendedMode: 'deep' });
      const withBacklog = selectMode({ recommendedMode: 'deep', backlog: [{ id: 1 }] });
      expect(withBacklog).toEqual(baseline);
    });

    it('signals.vaultStaleness does not change the output', () => {
      const baseline = selectMode({ recommendedMode: 'deep' });
      const withVault = selectMode({ recommendedMode: 'deep', vaultStaleness: { stale: true } });
      expect(withVault).toEqual(baseline);
    });
  });
});

describe('selectMode — heuristic v1', () => {
  // -----------------------------------------------------------------------
  // Branch 1: SPIRAL
  // -----------------------------------------------------------------------
  describe('SPIRAL branch', () => {
    it('completionRate < 0.5 → plan-retro at confidence 0.8', () => {
      const r = selectMode({ completionRate: 0.4 });
      expect(r.mode).toBe('plan-retro');
      expect(r.confidence).toBe(0.8);
    });

    it('completionRate exactly 0.0 → plan-retro', () => {
      const r = selectMode({ completionRate: 0.0 });
      expect(r.mode).toBe('plan-retro');
      expect(r.confidence).toBe(0.8);
    });

    it('completionRate exactly 0.499 → plan-retro', () => {
      const r = selectMode({ completionRate: 0.499 });
      expect(r.mode).toBe('plan-retro');
      expect(r.confidence).toBe(0.8);
    });

    it('completionRate exactly 0.5 → does NOT trigger SPIRAL', () => {
      const r = selectMode({ completionRate: 0.5 });
      expect(r.mode).not.toBe('plan-retro');
    });

    it('SPIRAL rationale mentions low completion', () => {
      const r = selectMode({ completionRate: 0.3 });
      expect(r.rationale).toMatch(/low completion|retrospective/i);
    });

    it('SPIRAL alternatives are [{mode:feature,confidence:0.3},{mode:discovery,confidence:0.25}]', () => {
      const r = selectMode({ completionRate: 0.3 });
      expect(r.alternatives).toEqual([
        { mode: 'feature', confidence: 0.3 },
        { mode: 'discovery', confidence: 0.25 },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Branch 2: CARRYOVER
  // -----------------------------------------------------------------------
  describe('CARRYOVER branch', () => {
    it('carryoverRatio >= 0.3 → deep at confidence 0.75', () => {
      const r = selectMode({ carryoverRatio: 0.3 });
      expect(r.mode).toBe('deep');
      expect(r.confidence).toBe(0.75);
    });

    it('carryoverRatio exactly 0.3 → deep', () => {
      const r = selectMode({ carryoverRatio: 0.3 });
      expect(r.mode).toBe('deep');
    });

    it('carryoverRatio 1.0 → deep', () => {
      const r = selectMode({ carryoverRatio: 1.0 });
      expect(r.mode).toBe('deep');
      expect(r.confidence).toBe(0.75);
    });

    it('carryoverRatio 0.29 → does NOT trigger CARRYOVER', () => {
      const r = selectMode({ carryoverRatio: 0.29 });
      expect(r.mode).not.toBe('deep');
    });

    it('CARRYOVER rationale mentions carryover percentage', () => {
      const r = selectMode({ carryoverRatio: 0.4 });
      expect(r.rationale).toMatch(/carryover/i);
    });

    it('CARRYOVER alternatives are [{mode:feature,confidence:0.3},{mode:plan-retro,confidence:0.2}]', () => {
      const r = selectMode({ carryoverRatio: 0.5 });
      expect(r.alternatives).toEqual([
        { mode: 'feature', confidence: 0.3 },
        { mode: 'plan-retro', confidence: 0.2 },
      ]);
    });

    it('SPIRAL takes priority over CARRYOVER when both trigger', () => {
      const r = selectMode({ completionRate: 0.3, carryoverRatio: 0.5 });
      expect(r.mode).toBe('plan-retro');
      expect(r.confidence).toBe(0.8);
    });
  });

  // -----------------------------------------------------------------------
  // High-confidence path (additive bonuses)
  // -----------------------------------------------------------------------
  describe('high-confidence path', () => {
    const threeSessions = [
      { session_type: 'feature', completion_rate: 1.0 },
      { session_type: 'feature', completion_rate: 1.0 },
      { session_type: 'feature', completion_rate: 1.0 },
    ];

    it('trend bonus +0.15 when last 3 sessions match and avgCompletion >= 0.9', () => {
      const r = selectMode({ recommendedMode: 'feature', recentSessions: threeSessions });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.65);
    });

    it('trend + tier bonus → 0.75 when bootstrapLock.tier standard aligns with feature', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: threeSessions,
        bootstrapLock: { tier: 'standard' },
      });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.75);
    });

    it('trend + tier + 1 learnings hint → 0.80', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: threeSessions,
        bootstrapLock: { tier: 'standard' },
        learnings: [{ type: 'effective-sizing', subject: 'feature session scope', confidence: 0.7 }],
      });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.80);
    });

    it('trend + tier + 2 learnings hints → 0.85 (learnings capped at +0.10)', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: threeSessions,
        bootstrapLock: { tier: 'standard' },
        learnings: [
          { type: 'effective-sizing', subject: 'feature scope guidance', confidence: 0.7 },
          { type: 'scope-guidance', subject: 'feature sizing', confidence: 0.8 },
        ],
      });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.85);
    });

    it('all-bonuses-maxed result is at or below the 0.9 confidence cap', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: threeSessions,
        bootstrapLock: { tier: 'standard' },
        learnings: [
          { type: 'effective-sizing', subject: 'feature scope', confidence: 0.9 },
          { type: 'scope-guidance', subject: 'feature guidance', confidence: 0.9 },
          { type: 'effective-sizing', subject: 'feature sizing', confidence: 0.9 },
        ],
      });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBeLessThanOrEqual(0.9);
      expect(r.confidence).toBe(0.85);
    });

    it('high-confidence result has non-empty alternatives array sorted desc by confidence', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: threeSessions,
        bootstrapLock: { tier: 'standard' },
      });
      expect(r.alternatives.length).toBeGreaterThan(0);
      expect(r.alternatives.length).toBeLessThanOrEqual(3);
      for (let i = 1; i < r.alternatives.length; i++) {
        expect(r.alternatives[i - 1].confidence).toBeGreaterThanOrEqual(r.alternatives[i].confidence);
      }
    });

    it('alternatives do not include the chosen mode', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: threeSessions,
        bootstrapLock: { tier: 'standard' },
      });
      for (const alt of r.alternatives) {
        expect(alt.mode).not.toBe('feature');
      }
    });

    it('rationale mentions trend reinforcement when trend signal is present', () => {
      const r = selectMode({ recommendedMode: 'feature', recentSessions: threeSessions });
      expect(r.rationale).toMatch(/trend/i);
    });

    it('trend bonus +0.075 (partial) when last 3 match but avgCompletion < 0.9', () => {
      const partialSessions = [
        { session_type: 'feature', completion_rate: 0.7 },
        { session_type: 'feature', completion_rate: 0.8 },
        { session_type: 'feature', completion_rate: 0.7 },
      ];
      const r = selectMode({ recommendedMode: 'feature', recentSessions: partialSessions });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.57);
    });
  });

  // -----------------------------------------------------------------------
  // Conflicting-signals path
  // -----------------------------------------------------------------------
  describe('conflicting-signals path', () => {
    const threeFeatureSessions = [
      { session_type: 'feature', completion_rate: 1.0 },
      { session_type: 'feature', completion_rate: 1.0 },
      { session_type: 'feature', completion_rate: 1.0 },
    ];

    it('recommendedMode deep + trend all feature → trend penalty -0.10 on deep, swap to feature@0.65 (#299)', () => {
      const r = selectMode({
        recommendedMode: 'deep',
        recentSessions: threeFeatureSessions,
      });
      // Global-max swap (#299): passthrough deep@0.40 < trend-bonused feature@0.65 → swap.
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.65);
      expect(r.rationale).toMatch(/global-max swap/);
      expect(r.alternatives).toContainEqual({ mode: 'deep', confidence: 0.40 });
    });

    it('recommendedMode deep + trend all feature + bootstrapLock standard → swap to feature@0.75 (#299)', () => {
      const r = selectMode({
        recommendedMode: 'deep',
        recentSessions: threeFeatureSessions,
        bootstrapLock: { tier: 'standard' },
      });
      // Global-max swap: passthrough deep@0.30 < feature@0.75 (trend +0.15, tier +0.10) → swap.
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.75);
      expect(r.rationale).toMatch(/global-max swap/);
      expect(r.alternatives).toContainEqual({ mode: 'deep', confidence: 0.30 });
    });

    it('recommendedMode deep + carryoverRatio 0.25 → no penalty (deep is carryover-immune)', () => {
      const r = selectMode({
        recommendedMode: 'deep',
        carryoverRatio: 0.25,
      });
      expect(r.mode).toBe('deep');
      expect(r.confidence).toBe(0.50);
    });

    it('recommendedMode feature + carryoverRatio 0.25 → carryover penalty -0.10 → confidence 0.40', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        carryoverRatio: 0.25,
      });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.40);
    });

    it('extreme penalties on feature + alt deep with full bonuses → swap to deep (#299, primary clamp still works)', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [
          { session_type: 'deep', completion_rate: 1.0 },
          { session_type: 'deep', completion_rate: 1.0 },
          { session_type: 'deep', completion_rate: 1.0 },
        ],
        bootstrapLock: { tier: 'deep' },
        carryoverRatio: 0.25,
      });
      // Global-max swap: passthrough feature@0.20 (clamped) < deep@0.75 (trend +0.15, tier +0.10) → swap.
      expect(r.mode).toBe('deep');
      expect(r.confidence).toBe(0.75);
      // Demoted feature is preserved at its (clamped) score in alternatives.
      expect(r.alternatives).toContainEqual({ mode: 'feature', confidence: 0.20 });
    });
  });

  // -----------------------------------------------------------------------
  // Stale-signals path
  // -----------------------------------------------------------------------
  describe('stale-signals path', () => {
    it('null/absent reserved fields → confidence 0.5 and stale-signals rationale', () => {
      const r = selectMode({ recommendedMode: 'feature' });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
      expect(r.rationale).toMatch(/stale/i);
    });

    it('empty arrays and null bootstrapLock → confidence 0.5', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [],
        bootstrapLock: null,
        learnings: [],
      });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
    });

    it('only 1 recentSession (below threshold of 3) → no trend bonus → confidence 0.5', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [{ session_type: 'feature', completion_rate: 1.0 }],
        bootstrapLock: null,
        learnings: [],
      });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
    });

    it('stale-signals case → alternatives is []', () => {
      const r = selectMode({ recommendedMode: 'feature' });
      expect(r.alternatives).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Alternatives generation
  // -----------------------------------------------------------------------
  describe('alternatives generation', () => {
    it('SPIRAL branch → alternatives exactly [{mode:feature,confidence:0.3},{mode:discovery,confidence:0.25}]', () => {
      const r = selectMode({ completionRate: 0.3 });
      expect(r.alternatives).toEqual([
        { mode: 'feature', confidence: 0.3 },
        { mode: 'discovery', confidence: 0.25 },
      ]);
    });

    it('CARRYOVER branch → alternatives exactly [{mode:feature,confidence:0.3},{mode:plan-retro,confidence:0.2}]', () => {
      const r = selectMode({ carryoverRatio: 0.5 });
      expect(r.alternatives).toEqual([
        { mode: 'feature', confidence: 0.3 },
        { mode: 'plan-retro', confidence: 0.2 },
      ]);
    });

    it('PASSTHROUGH-WEIGHTED with active signals → alternatives is non-empty array', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [
          { session_type: 'feature', completion_rate: 1.0 },
          { session_type: 'feature', completion_rate: 1.0 },
          { session_type: 'feature', completion_rate: 1.0 },
        ],
        bootstrapLock: { tier: 'standard' },
      });
      expect(r.alternatives.length).toBeGreaterThan(0);
      expect(r.alternatives.length).toBeLessThanOrEqual(3);
    });

    it('PASSTHROUGH-WEIGHTED alternatives entries each have {mode:string, confidence:number >= 0.1}', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        bootstrapLock: { tier: 'standard' },
      });
      for (const alt of r.alternatives) {
        expect(typeof alt.mode).toBe('string');
        expect(typeof alt.confidence).toBe('number');
        expect(alt.confidence).toBeGreaterThanOrEqual(0.1);
      }
    });

    it('PASSTHROUGH-WEIGHTED alternatives sorted descending by confidence', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [
          { session_type: 'feature', completion_rate: 1.0 },
          { session_type: 'feature', completion_rate: 1.0 },
          { session_type: 'feature', completion_rate: 1.0 },
        ],
        bootstrapLock: { tier: 'standard' },
      });
      for (let i = 1; i < r.alternatives.length; i++) {
        expect(r.alternatives[i - 1].confidence).toBeGreaterThanOrEqual(r.alternatives[i].confidence);
      }
    });

    it('PASSTHROUGH-WEIGHTED alternatives never include the chosen mode', () => {
      const r = selectMode({
        recommendedMode: 'deep',
        bootstrapLock: { tier: 'deep' },
      });
      for (const alt of r.alternatives) {
        expect(alt.mode).not.toBe('deep');
      }
    });

    it('DEFAULT branch (null signals) → alternatives is []', () => {
      const r = selectMode(null);
      expect(r.alternatives).toEqual([]);
    });

    it('bare passthrough (no active signals) → alternatives is []', () => {
      const r = selectMode({ recommendedMode: 'feature' });
      expect(r.alternatives).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Defensive parsing
  // -----------------------------------------------------------------------
  describe('defensive parsing', () => {
    it('signals.recentSessions as string → treated as empty, no bonus', () => {
      const r = selectMode({ recommendedMode: 'feature', recentSessions: 'not-an-array' });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
    });

    it('signals.recentSessions as number → treated as empty, no bonus', () => {
      const r = selectMode({ recommendedMode: 'feature', recentSessions: 42 });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
    });

    it('signals.learnings as non-array → treated as empty, no bonus', () => {
      const r = selectMode({ recommendedMode: 'feature', learnings: 'bad-value' });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
    });

    it('signals.bootstrapLock as string → treated as falsy, no bonus or penalty', () => {
      const r = selectMode({ recommendedMode: 'feature', bootstrapLock: 'not-an-object' });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
    });

    it('signals.bootstrapLock as number → treated as falsy, no bonus or penalty', () => {
      const r = selectMode({ recommendedMode: 'feature', bootstrapLock: 42 });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
    });

    it('signals.carryoverRatio as NaN → CARRYOVER branch does NOT fire', () => {
      const r = selectMode({ carryoverRatio: NaN });
      expect(r.mode).not.toBe('deep');
      expect(r.confidence).toBe(0.0);
    });

    it('signals.carryoverRatio as string → CARRYOVER branch does NOT fire', () => {
      const r = selectMode({ carryoverRatio: '0.5' });
      expect(r.mode).not.toBe('deep');
    });

    it('signals.completionRate as NaN → SPIRAL branch does NOT fire', () => {
      const r = selectMode({ completionRate: NaN });
      expect(r.mode).not.toBe('plan-retro');
    });

    it('signals.completionRate as string → SPIRAL branch does NOT fire', () => {
      const r = selectMode({ completionRate: '0.3' });
      expect(r.mode).not.toBe('plan-retro');
    });

    it.each([
      null,
      undefined,
      {},
      { completionRate: 'bad', carryoverRatio: null, recommendedMode: 123 },
      { recentSessions: { 0: 'not-an-array' }, learnings: true, bootstrapLock: [] },
    ])('function never throws regardless of input shape: %j', (input) => {
      expect(() => selectMode(input)).not.toThrow();
    });

    it('bootstrapLock with non-string tier → no tier bonus, no tier penalty', () => {
      // covers the `typeof bootstrapLock.tier === 'string' ? ... : null` false-branch
      const r = selectMode({ recommendedMode: 'feature', bootstrapLock: { tier: 99 } });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
    });

    it('recentSessions with non-number completion_rate → no penalty fires, but partial trend bonus does → swap to deep@0.57 (#299)', () => {
      // Covers the false branch of `typeof s.completion_rate === 'number'` inside reduce.
      // avgCompletion = 0 (all non-numeric) < 0.9 → no penalty on feature primary.
      // BUT alt deep still gets the partial trend bonus (+0.075, the avg<0.9 branch),
      // so deep ≈ 0.575 (round2 → 0.57 due to JS float) outranks feature@0.5 → global-max swap.
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [
          { session_type: 'deep', completion_rate: 'not-a-number' },
          { session_type: 'deep', completion_rate: 'not-a-number' },
          { session_type: 'deep', completion_rate: 'not-a-number' },
        ],
      });
      expect(r.mode).toBe('deep');
      expect(r.confidence).toBe(0.57);
      expect(r.alternatives).toContainEqual({ mode: 'feature', confidence: 0.5 });
    });

    it('bootstrapLock with non-string tier in buildPassthroughRationale → still produces valid rationale', () => {
      // covers line 277 false-branch in buildPassthroughRationale (tier = null path)
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [
          { session_type: 'feature', completion_rate: 1.0 },
          { session_type: 'feature', completion_rate: 1.0 },
          { session_type: 'feature', completion_rate: 1.0 },
        ],
        bootstrapLock: { tier: 99 },
      });
      expect(r.mode).toBe('feature');
      expect(r.rationale.length).toBeGreaterThan(0);
      expect(r.rationale.length).toBeLessThanOrEqual(120);
    });
  });

  // -----------------------------------------------------------------------
  // Global-max swap (#299) — primary recommendation must be the global max
  // -----------------------------------------------------------------------
  describe('global-max swap (#299)', () => {
    it('passthrough primary < alt → swap promotes alt, demotes primary into alternatives', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [
          { session_type: 'deep', completion_rate: 1.0 },
          { session_type: 'deep', completion_rate: 1.0 },
          { session_type: 'deep', completion_rate: 1.0 },
        ],
        bootstrapLock: { tier: 'deep' },
      });
      // feature gets penalty -0.10 (3-deep trend) -0.10 (deep tier) → 0.30.
      // deep gets +0.15 trend +0.10 tier → 0.75. Strict > → swap.
      expect(r.mode).toBe('deep');
      expect(r.confidence).toBe(0.75);
      expect(r.rationale).toMatch(/global-max swap/);
      expect(r.alternatives).toContainEqual({ mode: 'feature', confidence: 0.30 });
      // Alternatives still sorted DESC by confidence.
      for (let i = 1; i < r.alternatives.length; i++) {
        expect(r.alternatives[i - 1].confidence).toBeGreaterThanOrEqual(r.alternatives[i].confidence);
      }
    });

    it('tie at primary confidence → no swap (stability — passthrough preference)', () => {
      // recentSessions: 1 entry triggers hasActiveSignals so alternatives DO get computed,
      // but with only 1 session no trend bonus or penalty applies anywhere → all candidates
      // tie at base 0.5. Strict > prevents swap on equality, so primary stays at feature.
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [{ session_type: 'feature', completion_rate: 1.0 }],
      });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
      // Alts may exist but none strictly outrank primary.
      for (const alt of r.alternatives) {
        expect(alt.confidence).toBeLessThanOrEqual(0.5);
      }
    });

    it('ties between primary and alts under active signals → no swap (strict greater-than)', () => {
      // bootstrapLock present makes hasActiveSignals true so alternatives get computed,
      // but with no other distinguishing signals all candidates score identically at 0.5.
      // Strict > prevents swap on equality.
      const r = selectMode({
        recommendedMode: 'feature',
        bootstrapLock: { tier: 99 }, // non-string tier → no tier bonus or penalty
      });
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.5);
      // All alternatives at most equal to primary; primary stays.
      for (const alt of r.alternatives) {
        expect(alt.confidence).toBeLessThanOrEqual(0.5);
      }
    });

    it('SPIRAL branch unaffected: hard-coded primary 0.8 > hard-coded alts ≤0.3', () => {
      const r = selectMode({ completionRate: 0.3 });
      expect(r.mode).toBe('plan-retro');
      expect(r.confidence).toBe(0.8);
      expect(r.rationale).not.toMatch(/global-max swap/);
    });

    it('CARRYOVER branch unaffected: hard-coded primary 0.75 > hard-coded alts ≤0.3', () => {
      const r = selectMode({ carryoverRatio: 0.5 });
      expect(r.mode).toBe('deep');
      expect(r.confidence).toBe(0.75);
      expect(r.rationale).not.toMatch(/global-max swap/);
    });

    it('DEFAULT branch (no recommendedMode) unaffected: empty alternatives → no swap path', () => {
      const r = selectMode({});
      expect(r.mode).toBe('feature');
      expect(r.confidence).toBe(0.0);
      expect(r.alternatives).toEqual([]);
      expect(r.rationale).not.toMatch(/global-max swap/);
    });

    it('post-swap alternatives are capped at top-3', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [
          { session_type: 'deep', completion_rate: 1.0 },
          { session_type: 'deep', completion_rate: 1.0 },
          { session_type: 'deep', completion_rate: 1.0 },
        ],
        bootstrapLock: { tier: 'deep' },
      });
      expect(r.mode).toBe('deep');
      expect(r.alternatives.length).toBeLessThanOrEqual(3);
    });

    it('post-swap rationale stays under the 120-char clamp', () => {
      const r = selectMode({
        recommendedMode: 'feature',
        recentSessions: [
          { session_type: 'deep', completion_rate: 1.0 },
          { session_type: 'deep', completion_rate: 1.0 },
          { session_type: 'deep', completion_rate: 1.0 },
        ],
        bootstrapLock: { tier: 'deep' },
      });
      expect(r.rationale.length).toBeLessThanOrEqual(120);
    });
  });
});
