/**
 * tests/lib/autopilot/kill-switches.test.mjs
 *
 * Dedicated test file for scripts/lib/autopilot/kill-switches.mjs.
 * Created in ADR-364 thin-slice (STALL_TIMEOUT scaffold).
 */

import { describe, it, expect } from 'vitest';
import {
  KILL_SWITCHES,
  preIterationKillSwitch,
  postSessionKillSwitch,
} from '../../../scripts/lib/autopilot/kill-switches.mjs';

// ---------------------------------------------------------------------------
// KILL_SWITCHES enum
// ---------------------------------------------------------------------------

describe('KILL_SWITCHES enum', () => {
  it('includes STALL_TIMEOUT with the correct kebab-case value', () => {
    expect(KILL_SWITCHES.STALL_TIMEOUT).toBe('stall-timeout');
  });

  it('exports exactly 10 kill-switches', () => {
    expect(Object.keys(KILL_SWITCHES)).toHaveLength(10);
  });

  it('STALL_TIMEOUT does not collide with any existing identifier', () => {
    const values = Object.values(KILL_SWITCHES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is frozen (cannot be mutated at runtime)', () => {
    expect(() => {
      KILL_SWITCHES.STALL_TIMEOUT = 'mutated';
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// postSessionKillSwitch — STALL_TIMEOUT scaffold (ADR-364 §3 DoD)
// ---------------------------------------------------------------------------

describe('postSessionKillSwitch — STALL_TIMEOUT scaffold (ADR-364 §3 DoD)', () => {
  // Per-input behavioural canary — if STALL_TIMEOUT_SAMPLER_WIRED is ever flipped
  // back to true without wiring the sampler, the scaffold returns
  // { kill: STALL_TIMEOUT, detail: 'sampler-not-wired' } and these assertions fail.
  it.each([
    [
      'happy carryover-ok',
      { agent_summary: { complete: 1, failed: 0, partial: 0, spiral: 0 } },
      { carryoverThreshold: 0.5 },
    ],
    ['empty session result', {}, { carryoverThreshold: 0.5 }],
    [
      'high carryover (other switch may fire)',
      { effectiveness: { planned_issues: 10, carryover: 5 } },
      { carryoverThreshold: 0.3 },
    ],
  ])('STALL_TIMEOUT scaffold never fires (%s)', (_name, sessionResult, opts) => {
    const result = postSessionKillSwitch(sessionResult, opts);
    // Other post-session switches may fire; STALL_TIMEOUT must never be the cause.
    if (result === null) return;
    expect(result.kill).not.toBe(KILL_SWITCHES.STALL_TIMEOUT);
  });

  it('returns null when sessionResult is null', () => {
    expect(postSessionKillSwitch(null, { carryoverThreshold: 0.5 })).toBeNull();
  });

  it('returns null when sessionResult is empty object and carryover below threshold', () => {
    expect(
      postSessionKillSwitch(
        { effectiveness: { planned_issues: 10, carryover: 2 } },
        { carryoverThreshold: 0.5 }
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// preIterationKillSwitch — regression check after STALL_TIMEOUT addition
// ---------------------------------------------------------------------------

describe('preIterationKillSwitch — regression check after STALL_TIMEOUT addition', () => {
  it('still fires TOKEN_BUDGET_EXCEEDED when cumulative tokens exceed maxTokens', () => {
    const result = preIterationKillSwitch({
      maxTokens: 1000,
      cumulativeTokensUsed: 1500,
    });
    expect(result?.kill).toBe(KILL_SWITCHES.TOKEN_BUDGET_EXCEEDED);
  });

  it('returns null when no kill condition is met', () => {
    const result = preIterationKillSwitch({
      aborted: false,
      iterationsCompleted: 2,
      maxSessions: 10,
      elapsedMs: 1_000,
      maxHoursMs: 3_600_000,
      maxTokens: 100_000,
      cumulativeTokensUsed: 500,
      resourceVerdict: 'green',
      peerCount: 0,
      peerAbortThreshold: 5,
    });
    expect(result).toBeNull();
  });

  it('fires USER_ABORT when aborted is true', () => {
    const result = preIterationKillSwitch({ aborted: true });
    expect(result?.kill).toBe(KILL_SWITCHES.USER_ABORT);
  });
});
