/**
 * tests/lib/wave-sizing.test.mjs
 *
 * Vitest unit tests for scripts/lib/wave-sizing.mjs (issue #194).
 * Covers graduated-isolation decision table, override precedence, and
 * enforcement auto-promotion when worktree isolation is absent.
 */

import { describe, it, expect } from 'vitest';
import { resolveIsolation, resolveEnforcement } from '@lib/wave-sizing.mjs';
import { VALID_SESSION_TYPES } from '@lib/session-schema/constants.mjs';

// ---------------------------------------------------------------------------
// resolveIsolation — graduation table
// ---------------------------------------------------------------------------

describe('resolveIsolation — graduation table', () => {
  it('agentCount=1, sessionType=feature → none (graduation floor)', () => {
    expect(resolveIsolation({ agentCount: 1, sessionType: 'feature' })).toBe('none');
  });

  it('agentCount=2, sessionType=deep → none', () => {
    expect(resolveIsolation({ agentCount: 2, sessionType: 'deep' })).toBe('none');
  });

  it('agentCount=3, sessionType=housekeeping → none (housekeeping cap)', () => {
    expect(resolveIsolation({ agentCount: 3, sessionType: 'housekeeping' })).toBe('none');
  });

  it('agentCount=4, sessionType=housekeeping → none (housekeeping cap)', () => {
    expect(resolveIsolation({ agentCount: 4, sessionType: 'housekeeping' })).toBe('none');
  });

  it('agentCount=3, sessionType=feature → worktree (mid-tier feature)', () => {
    expect(resolveIsolation({ agentCount: 3, sessionType: 'feature' })).toBe('worktree');
  });

  it('agentCount=4, sessionType=deep → worktree (mid-tier deep)', () => {
    expect(resolveIsolation({ agentCount: 4, sessionType: 'deep' })).toBe('worktree');
  });

  it('agentCount=5, sessionType=housekeeping → worktree (≥5 always)', () => {
    expect(resolveIsolation({ agentCount: 5, sessionType: 'housekeeping' })).toBe('worktree');
  });

  it('agentCount=8, sessionType=feature → worktree (≥5 always)', () => {
    expect(resolveIsolation({ agentCount: 8, sessionType: 'feature' })).toBe('worktree');
  });
});

// ---------------------------------------------------------------------------
// resolveIsolation — override precedence
// ---------------------------------------------------------------------------

describe('resolveIsolation — override precedence', () => {
  it('configIsolation=worktree beats graduation (1 agent + worktree override → worktree)', () => {
    expect(resolveIsolation({ agentCount: 1, sessionType: 'feature', configIsolation: 'worktree' })).toBe('worktree');
  });

  it('configIsolation=none at 8 agents → none (explicit user override)', () => {
    expect(resolveIsolation({ agentCount: 8, sessionType: 'deep', configIsolation: 'none' })).toBe('none');
  });

  it('collisionRisk=high at agentCount=2 → worktree (collision override)', () => {
    expect(resolveIsolation({ agentCount: 2, sessionType: 'feature', collisionRisk: 'high' })).toBe('worktree');
  });

  it('collisionRisk=high ignored when configIsolation=none (user override wins)', () => {
    expect(resolveIsolation({ agentCount: 2, sessionType: 'feature', collisionRisk: 'high', configIsolation: 'none' })).toBe('none');
  });

  it('collisionRisk=medium has no special override — falls through to table', () => {
    expect(resolveIsolation({ agentCount: 2, sessionType: 'deep', collisionRisk: 'medium' })).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// resolveIsolation — validation errors
// ---------------------------------------------------------------------------

describe('resolveIsolation — validation', () => {
  it('throws TypeError for agentCount=0', () => {
    expect(() => resolveIsolation({ agentCount: 0, sessionType: 'feature' })).toThrow(TypeError);
    expect(() => resolveIsolation({ agentCount: 0, sessionType: 'feature' })).toThrow('positive integer');
  });

  it('throws TypeError for agentCount=-1', () => {
    expect(() => resolveIsolation({ agentCount: -1, sessionType: 'feature' })).toThrow(TypeError);
  });

  it('throws TypeError for agentCount=\'foo\'', () => {
    expect(() => resolveIsolation({ agentCount: 'foo', sessionType: 'feature' })).toThrow(TypeError);
  });

  it('throws TypeError for agentCount=null', () => {
    expect(() => resolveIsolation({ agentCount: null, sessionType: 'feature' })).toThrow(TypeError);
  });

  it('throws TypeError for agentCount=1.5 (non-integer)', () => {
    expect(() => resolveIsolation({ agentCount: 1.5, sessionType: 'feature' })).toThrow(TypeError);
  });

  it('throws TypeError for invalid sessionType', () => {
    expect(() => resolveIsolation({ agentCount: 3, sessionType: 'sprint' })).toThrow(TypeError);
    expect(() => resolveIsolation({ agentCount: 3, sessionType: 'sprint' })).toThrow('housekeeping|feature|deep');
  });

  it('throws TypeError for invalid collisionRisk', () => {
    expect(() => resolveIsolation({ agentCount: 2, sessionType: 'feature', collisionRisk: 'extreme' })).toThrow(TypeError);
  });

  it('throws TypeError for invalid configIsolation', () => {
    expect(() => resolveIsolation({ agentCount: 2, sessionType: 'feature', configIsolation: 'maybe' })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// resolveIsolation — additional edge-case coverage (W4)
// ---------------------------------------------------------------------------

describe('resolveIsolation — additional edge cases', () => {
  it('throws TypeError for agentCount=2.5 (non-integer float)', () => {
    expect(() => resolveIsolation({ agentCount: 2.5, sessionType: 'feature' })).toThrow(TypeError);
    expect(() => resolveIsolation({ agentCount: 2.5, sessionType: 'feature' })).toThrow('positive integer');
  });

  it('collisionRisk=medium at agentCount=2 does NOT force worktree — falls through to none', () => {
    expect(resolveIsolation({ agentCount: 2, sessionType: 'feature', collisionRisk: 'medium' })).toBe('none');
  });

  it('collisionRisk=medium at agentCount=1 does NOT force worktree — falls through to none', () => {
    expect(resolveIsolation({ agentCount: 1, sessionType: 'deep', collisionRisk: 'medium' })).toBe('none');
  });

  it('agentCount=4, sessionType=feature → worktree (upper bound of 3–4 tier)', () => {
    expect(resolveIsolation({ agentCount: 4, sessionType: 'feature' })).toBe('worktree');
  });
});

// ---------------------------------------------------------------------------
// resolveEnforcement — additional edge-case coverage (W4)
// ---------------------------------------------------------------------------

describe('resolveEnforcement — additional edge cases', () => {
  it('throws TypeError for unknown isolation token "foo"', () => {
    expect(() => resolveEnforcement({ isolation: 'foo', configEnforcement: 'warn' })).toThrow(TypeError);
    expect(() => resolveEnforcement({ isolation: 'foo', configEnforcement: 'warn' })).toThrow('worktree|none');
  });
});

// ---------------------------------------------------------------------------
// resolveEnforcement
// ---------------------------------------------------------------------------

describe('resolveEnforcement', () => {
  it('none + warn → strict (auto-promote)', () => {
    expect(resolveEnforcement({ isolation: 'none', configEnforcement: 'warn' })).toBe('strict');
  });

  it('none + off → off (user explicit opt-out respected)', () => {
    expect(resolveEnforcement({ isolation: 'none', configEnforcement: 'off' })).toBe('off');
  });

  it('none + strict → strict (already strict, keep)', () => {
    expect(resolveEnforcement({ isolation: 'none', configEnforcement: 'strict' })).toBe('strict');
  });

  it('worktree + warn → warn (pass-through)', () => {
    expect(resolveEnforcement({ isolation: 'worktree', configEnforcement: 'warn' })).toBe('warn');
  });

  it('worktree + off → off (pass-through)', () => {
    expect(resolveEnforcement({ isolation: 'worktree', configEnforcement: 'off' })).toBe('off');
  });

  it('worktree + strict → strict (pass-through)', () => {
    expect(resolveEnforcement({ isolation: 'worktree', configEnforcement: 'strict' })).toBe('strict');
  });

  it('none + missing configEnforcement defaults to warn → strict', () => {
    expect(resolveEnforcement({ isolation: 'none' })).toBe('strict');
  });

  it('throws TypeError for invalid isolation', () => {
    expect(() => resolveEnforcement({ isolation: 'maybe', configEnforcement: 'warn' })).toThrow(TypeError);
    expect(() => resolveEnforcement({ isolation: 'maybe', configEnforcement: 'warn' })).toThrow('worktree|none');
  });

  it('throws TypeError for invalid configEnforcement', () => {
    expect(() => resolveEnforcement({ isolation: 'none', configEnforcement: 'moderate' })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// SSOT — the session-type enum is IMPORTED, not re-declared
// ---------------------------------------------------------------------------

describe('VALID_SESSION_TYPES is the SSOT set (same members as session-schema/constants)', () => {
  // wave-sizing.mjs does not export its accepted set, so the parity proof is
  // BEHAVIOURAL: a representative SSOT member is accepted and a non-member is
  // rejected. Iterating the whole enum added nothing falsifiable — it compared
  // VALID_SESSION_TYPES with itself, and both sides move together.
  it('accepts an SSOT member and rejects a value outside the enum', () => {
    expect(VALID_SESSION_TYPES).toContain('housekeeping');
    expect(() => resolveIsolation({ agentCount: 3, sessionType: 'housekeeping' })).not.toThrow();

    expect(VALID_SESSION_TYPES).not.toContain('ultradeep');
    expect(() => resolveIsolation({ agentCount: 3, sessionType: 'ultradeep' })).toThrow(TypeError);
  });
});
