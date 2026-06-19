import { describe, it, expect } from 'vitest';
import { selectMode } from '../../../scripts/lib/mode-selector.mjs';
import {
  NON_EXECUTION_MODES,
  isNonExecutionMode,
} from '../../../scripts/lib/mode-selector/scoring.mjs';
import {
  PRECURSOR_MODES,
  isPrecursorMode,
  suggestPrecursors,
} from '../../../scripts/lib/recommendations-v0.mjs';

/**
 * Tests for the mode-selector precursor-surfacing additions (#678, Wave 3 P2).
 *
 * Guard (b): read-only precursor modes (discovery / plan-retro) must NEVER be
 * scoring-promoted into the primary executed `mode` via the global-max swap.
 * They stay RETAINED in alternatives[] as suggestions, and suggestPrecursors()
 * surfaces them separately for the dispatcher menu.
 */

// ---------------------------------------------------------------------------
// AC1 — Guard (b) non-promotion: a precursor that is the GLOBAL-MAX alternative
// must never become the primary `mode`. These fixtures use NON-spiral,
// NON-carryover signals so the SPIRAL/CARRYOVER branches (which CAN make
// plan-retro primary by policy) never fire — the swap path is the SUT.
// ---------------------------------------------------------------------------
describe('selectMode — guard (b) precursor non-promotion (#678)', () => {
  // discovery scores 0.65 (global max via 3-session trend bonus); every
  // executable mode sits at 0.40, tied with the passthrough primary feature.
  // No executable alt strictly outranks primary → no swap, primary stays feature.
  const discoveryGlobalMax = {
    recommendedMode: 'feature',
    recentSessions: [
      { session_type: 'discovery', completion_rate: 1.0 },
      { session_type: 'discovery', completion_rate: 1.0 },
      { session_type: 'discovery', completion_rate: 1.0 },
    ],
  };

  it('discovery as global-max alternative does NOT become the primary mode', () => {
    const r = selectMode(discoveryGlobalMax);
    expect(r.mode).toBe('feature');
  });

  it('primary mode is an EXECUTABLE mode when discovery is the global max', () => {
    const r = selectMode(discoveryGlobalMax);
    // The leak this guards against: a naive global-max would promote discovery
    // (0.65) into the primary. isNonExecutionMode must be false for the primary.
    expect(isNonExecutionMode(r.mode)).toBe(false);
    expect(r.mode).not.toBe('discovery');
    expect(r.mode).not.toBe('plan-retro');
  });

  // discovery scores 0.55 (global max); deep gets +0.10 tier bonus → 0.50,
  // strictly > the penalised passthrough feature@0.30 → swap fires. Guard (b)
  // promotes deep (the top EXECUTABLE alt), NOT discovery (the global max).
  const discoveryMaxButExecutableSwaps = {
    recommendedMode: 'feature',
    recentSessions: [
      { session_type: 'discovery', completion_rate: 1.0 },
      { session_type: 'discovery', completion_rate: 1.0 },
      { session_type: 'discovery', completion_rate: 1.0 },
    ],
    bootstrapLock: { tier: 'deep' },
  };

  it('swap promotes the top EXECUTABLE alternative, not the higher-scoring precursor', () => {
    const r = selectMode(discoveryMaxButExecutableSwaps);
    // discovery@0.55 is the global max but deep@0.50 is the highest EXECUTABLE
    // alternative. Guard (b) must promote deep, skipping discovery.
    expect(r.mode).toBe('deep');
    expect(r.confidence).toBe(0.5);
  });

  it('swap never promotes a precursor even when it is strictly the global max', () => {
    const r = selectMode(discoveryMaxButExecutableSwaps);
    expect(isNonExecutionMode(r.mode)).toBe(false);
    expect(r.mode).not.toBe('discovery');
  });

  // plan-retro scores 0.65 (global max) via 3-session trend bonus, with
  // completionRate 0.9 (no spiral) and carryoverRatio 0.0 (no carryover).
  const planRetroGlobalMax = {
    recommendedMode: 'feature',
    completionRate: 0.9,
    carryoverRatio: 0.0,
    recentSessions: [
      { session_type: 'plan-retro', completion_rate: 1.0 },
      { session_type: 'plan-retro', completion_rate: 1.0 },
      { session_type: 'plan-retro', completion_rate: 1.0 },
    ],
  };

  it('plan-retro as global-max alternative does NOT become the primary mode (non-spiral path)', () => {
    const r = selectMode(planRetroGlobalMax);
    expect(r.mode).toBe('feature');
    expect(isNonExecutionMode(r.mode)).toBe(false);
    expect(r.mode).not.toBe('plan-retro');
  });
});

// ---------------------------------------------------------------------------
// AC2 — Precursor RETAINED as a suggestion in alternatives[] after the swap.
// ---------------------------------------------------------------------------
describe('selectMode — precursor retained in alternatives (#678)', () => {
  it('discovery global max is RETAINED in alternatives when primary stays feature', () => {
    const r = selectMode({
      recommendedMode: 'feature',
      recentSessions: [
        { session_type: 'discovery', completion_rate: 1.0 },
        { session_type: 'discovery', completion_rate: 1.0 },
        { session_type: 'discovery', completion_rate: 1.0 },
      ],
    });
    expect(r.alternatives).toContainEqual({ mode: 'discovery', confidence: 0.65 });
  });

  it('discovery global max is RETAINED in alternatives even after an executable-alt swap', () => {
    const r = selectMode({
      recommendedMode: 'feature',
      recentSessions: [
        { session_type: 'discovery', completion_rate: 1.0 },
        { session_type: 'discovery', completion_rate: 1.0 },
        { session_type: 'discovery', completion_rate: 1.0 },
      ],
      bootstrapLock: { tier: 'deep' },
    });
    expect(r.mode).toBe('deep');
    expect(r.alternatives).toContainEqual({ mode: 'discovery', confidence: 0.55 });
  });

  it('plan-retro global max is RETAINED in alternatives (non-spiral path)', () => {
    const r = selectMode({
      recommendedMode: 'feature',
      completionRate: 0.9,
      carryoverRatio: 0.0,
      recentSessions: [
        { session_type: 'plan-retro', completion_rate: 1.0 },
        { session_type: 'plan-retro', completion_rate: 1.0 },
        { session_type: 'plan-retro', completion_rate: 1.0 },
      ],
    });
    expect(r.alternatives).toContainEqual({ mode: 'plan-retro', confidence: 0.65 });
  });
});

// ---------------------------------------------------------------------------
// AC-exception — SPIRAL branch CAN make plan-retro the PRIMARY by explicit
// policy (routes to /plan, a read-only precursor). This is intended, not a
// guard-(b) violation: SPIRAL fires before the swap path.
// ---------------------------------------------------------------------------
describe('selectMode — SPIRAL branch plan-retro primary is intended (#678)', () => {
  it('very low completionRate → plan-retro primary by explicit policy', () => {
    const r = selectMode({ completionRate: 0.3 });
    expect(r.mode).toBe('plan-retro');
    expect(r.confidence).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// AC3 — suggestPrecursors branches.
// ---------------------------------------------------------------------------
describe('suggestPrecursors — branch coverage (#678)', () => {
  it('low completionRate → plan-retro suggestion routed to /plan', () => {
    const result = suggestPrecursors({
      completionRate: 0.4,
      carryoverRatio: 0.0,
      recentSessions: [{ session_type: 'feature' }],
    });
    expect(result).toEqual([
      {
        mode: 'plan-retro',
        route: '/plan',
        rationale: 'low completion / carryover → plan-retro precursor',
      },
    ]);
  });

  it('high carryoverRatio → plan-retro suggestion routed to /plan', () => {
    const result = suggestPrecursors({
      completionRate: 0.9,
      carryoverRatio: 0.5,
      recentSessions: [{ session_type: 'feature' }],
    });
    expect(result).toEqual([
      {
        mode: 'plan-retro',
        route: '/plan',
        rationale: 'low completion / carryover → plan-retro precursor',
      },
    ]);
  });

  it('cold start (empty recentSessions) → discovery suggestion routed to /discovery', () => {
    const result = suggestPrecursors({
      completionRate: 0.9,
      carryoverRatio: 0.0,
      recentSessions: [],
    });
    expect(result).toEqual([
      {
        mode: 'discovery',
        route: '/discovery',
        rationale: 'cold start / explore-first hint → discovery precursor',
      },
    ]);
  });

  it('explicit discoveryHint → discovery suggestion routed to /discovery', () => {
    const result = suggestPrecursors({
      completionRate: 0.9,
      carryoverRatio: 0.0,
      recentSessions: [{ session_type: 'feature' }],
      discoveryHint: true,
    });
    expect(result).toEqual([
      {
        mode: 'discovery',
        route: '/discovery',
        rationale: 'cold start / explore-first hint → discovery precursor',
      },
    ]);
  });

  it('both conditions (low completion + cold start) → plan-retro then discovery', () => {
    const result = suggestPrecursors({
      completionRate: 0.4,
      carryoverRatio: 0.0,
      recentSessions: [],
    });
    expect(result).toEqual([
      {
        mode: 'plan-retro',
        route: '/plan',
        rationale: 'low completion / carryover → plan-retro precursor',
      },
      {
        mode: 'discovery',
        route: '/discovery',
        rationale: 'cold start / explore-first hint → discovery precursor',
      },
    ]);
  });

  it('clean/healthy signals → no suggestions', () => {
    const result = suggestPrecursors({
      completionRate: 0.9,
      carryoverRatio: 0.0,
      recentSessions: [{ session_type: 'feature' }],
    });
    expect(result).toEqual([]);
  });

  it('null signals → no suggestions', () => {
    expect(suggestPrecursors(null)).toEqual([]);
  });

  it('every suggested mode is a precursor route (never an execution mode)', () => {
    const result = suggestPrecursors({
      completionRate: 0.4,
      carryoverRatio: 0.0,
      recentSessions: [],
    });
    expect(result).toHaveLength(2);
    expect(isPrecursorMode(result[0].mode)).toBe(true);
    expect(isPrecursorMode(result[1].mode)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 — set membership / predicate functions.
// ---------------------------------------------------------------------------
describe('precursor / non-execution membership predicates (#678)', () => {
  it('NON_EXECUTION_MODES contains exactly discovery and plan-retro', () => {
    expect([...NON_EXECUTION_MODES].sort()).toEqual(['discovery', 'plan-retro']);
  });

  it('PRECURSOR_MODES contains exactly discovery and plan-retro', () => {
    expect([...PRECURSOR_MODES].sort()).toEqual(['discovery', 'plan-retro']);
  });

  it.each(['discovery', 'plan-retro'])('isNonExecutionMode(%s) is true', (mode) => {
    expect(isNonExecutionMode(mode)).toBe(true);
  });

  it.each(['feature', 'deep', 'housekeeping', 'evolve'])(
    'isNonExecutionMode(%s) is false (executable mode)',
    (mode) => {
      expect(isNonExecutionMode(mode)).toBe(false);
    },
  );

  it.each(['discovery', 'plan-retro'])('isPrecursorMode(%s) is true', (mode) => {
    expect(isPrecursorMode(mode)).toBe(true);
  });

  it.each(['feature', 'deep', 'housekeeping', 'evolve'])(
    'isPrecursorMode(%s) is false (executable mode)',
    (mode) => {
      expect(isPrecursorMode(mode)).toBe(false);
    },
  );

  it.each([42, null, undefined, {}, []])(
    'isNonExecutionMode(%j) is false for non-string input',
    (value) => {
      expect(isNonExecutionMode(value)).toBe(false);
    },
  );

  it.each([42, null, undefined, {}, []])(
    'isPrecursorMode(%j) is false for non-string input',
    (value) => {
      expect(isPrecursorMode(value)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// AC5 — zero-regression sanity: representative primaries unaffected.
// ---------------------------------------------------------------------------
describe('selectMode — zero-regression anchors (#678)', () => {
  it('plain feature passthrough → feature primary', () => {
    const r = selectMode({ recommendedMode: 'feature' });
    expect(r.mode).toBe('feature');
    expect(r.confidence).toBe(0.5);
  });

  it('housekeeping trend + tier alignment → housekeeping primary', () => {
    const r = selectMode({
      recommendedMode: 'housekeeping',
      bootstrapLock: { tier: 'fast' },
      recentSessions: [
        { session_type: 'housekeeping', completion_rate: 1.0 },
        { session_type: 'housekeeping', completion_rate: 1.0 },
        { session_type: 'housekeeping', completion_rate: 1.0 },
      ],
    });
    expect(r.mode).toBe('housekeeping');
    expect(r.confidence).toBe(0.75);
  });

  it('carryover ≥ 0.3 → deep primary (executable carryover-clear)', () => {
    const r = selectMode({ carryoverRatio: 0.5 });
    expect(r.mode).toBe('deep');
    expect(r.confidence).toBe(0.75);
    expect(isNonExecutionMode(r.mode)).toBe(false);
  });
});
