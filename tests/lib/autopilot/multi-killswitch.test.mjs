// tests/lib/autopilot/multi-killswitch.test.mjs
//
// Behavioral unit tests for scripts/lib/autopilot/multi-killswitch.mjs.
// All functions are pure (no I/O); no mocks are needed — only controlled inputs.

import { describe, it, expect } from 'vitest';
import {
  STALE_SUBAGENT_MIN,
  calculateConcurrencyCap,
  evaluateMultiKillSwitches,
  decideCohortAction,
  shouldStopOrchestrator,
} from '@lib/autopilot/multi-killswitch.mjs';

// ---------------------------------------------------------------------------
// STALE_SUBAGENT_MIN constant
// ---------------------------------------------------------------------------

describe('STALE_SUBAGENT_MIN', () => {
  it('equals the expected string constant', () => {
    expect(STALE_SUBAGENT_MIN).toBe('stale-subagent-min');
  });
});

// ---------------------------------------------------------------------------
// calculateConcurrencyCap
// ---------------------------------------------------------------------------

describe('calculateConcurrencyCap', () => {
  it.each([
    ['high RAM (22 GB) is capped at staticFloor 3', { ram_free_gb: 22 }, 3],
    ['low RAM (6 GB) yields max(1, floor(6/4)-1) = 1', { ram_free_gb: 6 }, 1],
    ['critical RAM (2 GB) yields floor', { ram_free_gb: 2 }, 1],
    ['missing ram_free_gb defaults to safe floor', {}, 1],
  ])('%s', (_label, snapshot, expected) => {
    expect(calculateConcurrencyCap(snapshot)).toBe(expected);
  });

  it('macOS memory pressure < 15% caps at 1 regardless of RAM', () => {
    expect(calculateConcurrencyCap({ ram_free_gb: 22, memory_pressure_pct_free: 10 })).toBe(1);
  });

  it('macOS memory pressure >= 15% does NOT trigger the cap', () => {
    expect(calculateConcurrencyCap({ ram_free_gb: 22, memory_pressure_pct_free: 20 })).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// evaluateMultiKillSwitches
// ---------------------------------------------------------------------------

describe('evaluateMultiKillSwitches', () => {
  it('returns null for an empty loops array', () => {
    expect(evaluateMultiKillSwitches([])).toBeNull();
  });

  it('returns null when all running loops are fresh (no stale activity)', () => {
    const now = Date.now();
    const loops = [
      { loopId: 'L1', status: 'running', lastActivityAt: now - 100 },
    ];
    const result = evaluateMultiKillSwitches(loops, { nowMs: () => now });
    expect(result).toBeNull();
  });

  it('returns stale-subagent-min kill when a running loop exceeds the threshold', () => {
    const now = Date.now();
    const staleMs = 601 * 1000; // 601 seconds > default 600s threshold
    const loops = [
      { loopId: 'stale-1', status: 'running', lastActivityAt: now - staleMs },
    ];
    const result = evaluateMultiKillSwitches(loops, { nowMs: () => now });
    expect(result).toMatchObject({
      kill: 'stale-subagent-min',
      loopId: 'stale-1',
    });
  });

  it('does NOT fire for a stale loop whose status is complete (not running)', () => {
    const now = Date.now();
    const staleMs = 601 * 1000;
    const loops = [
      { loopId: 'done-1', status: 'complete', lastActivityAt: now - staleMs },
    ];
    const result = evaluateMultiKillSwitches(loops, { nowMs: () => now });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decideCohortAction
// ---------------------------------------------------------------------------

describe('decideCohortAction', () => {
  it('returns retry for first spiral with no prior recovery on the failed loop', () => {
    const loops = [
      { loopId: 'L1', killSwitch: 'spiral', spiralRecoveryCount: 0 },
      { loopId: 'L2', killSwitch: null, spiralRecoveryCount: 0 },
    ];
    const result = decideCohortAction(loops, 'L1');
    expect(result.action).toBe('retry');
  });

  it('returns cohort-abort when the failed loop already has spiralRecoveryCount >= 1', () => {
    const loops = [
      { loopId: 'L1', killSwitch: 'spiral', spiralRecoveryCount: 1 },
    ];
    const result = decideCohortAction(loops, 'L1');
    expect(result.action).toBe('cohort-abort');
  });

  it('returns cohort-abort when 2+ loops have spiraled', () => {
    const loops = [
      { loopId: 'L1', killSwitch: 'spiral', spiralRecoveryCount: 0 },
      { loopId: 'L2', killSwitch: 'spiral', spiralRecoveryCount: 0 },
    ];
    const result = decideCohortAction(loops, 'L1');
    expect(result.action).toBe('cohort-abort');
  });
});

// ---------------------------------------------------------------------------
// shouldStopOrchestrator
// ---------------------------------------------------------------------------

describe('shouldStopOrchestrator', () => {
  it('returns stop=false for a healthy mid-run state', () => {
    const state = {
      activeLoops: [{ loopId: 'L1', killSwitch: null, spiralRecoveryCount: 0 }],
      readyBacklog: [{ issueIid: 42 }],
      lastCompletionAt: Date.now() - 10_000,
    };
    const result = shouldStopOrchestrator(state, { nowMs: () => Date.now() });
    expect(result).toEqual({ stop: false });
  });

  it('returns stop=true reason=backlog-empty when activeLoops and readyBacklog are both empty', () => {
    const state = { activeLoops: [], readyBacklog: [], lastCompletionAt: Date.now() };
    const result = shouldStopOrchestrator(state);
    expect(result).toEqual({ stop: true, reason: 'backlog-empty' });
  });

  it('returns stop=true reason=first-kill-switch when cohort-abort is triggered by a spiral loop', () => {
    // Two spiraled loops → decideCohortAction returns cohort-abort
    const now = Date.now();
    const state = {
      activeLoops: [
        { loopId: 'L1', killSwitch: 'spiral', spiralRecoveryCount: 0 },
        { loopId: 'L2', killSwitch: 'spiral', spiralRecoveryCount: 0 },
      ],
      readyBacklog: [{ issueIid: 1 }],
      lastCompletionAt: now - 1000,
    };
    const result = shouldStopOrchestrator(state, { nowMs: () => now });
    expect(result).toEqual({ stop: true, reason: 'first-kill-switch' });
  });

  it('returns stop=true reason=inactivity-timeout when inactivity exceeds threshold', () => {
    const now = Date.now();
    const state = {
      activeLoops: [{ loopId: 'L1', killSwitch: null, spiralRecoveryCount: 0 }],
      readyBacklog: [],
      lastCompletionAt: now - 400_000, // 400s > default 300s
    };
    const result = shouldStopOrchestrator(state, {
      nowMs: () => now,
      inactivityTimeoutMs: 300_000,
    });
    expect(result).toEqual({ stop: true, reason: 'inactivity-timeout' });
  });
});
