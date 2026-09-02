/**
 * tests/lib/auto-dialectic.test.mjs
 *
 * Unit tests for `decideAndRecordAutoDialectic()` in scripts/lib/auto-dialectic.mjs
 * (GitLab #1200 part c). The auto-dialectic nudge decision fires at every session
 * close (`skills/session-end/phase-3-6-tail.md` § 3.6.7) but emitted NO telemetry —
 * 0 `orchestrator.dialectic.*` records across 164k fleet events. This wrapper
 * mechanically records the decision as `orchestrator.dialectic.nudge_decided`
 * without changing `shouldDispatchAutoDialectic()`'s own decision logic.
 *
 * Scope note: `shouldDispatchAutoDialectic()` and every pre-existing export of
 * this module already have full coverage at `tests/scripts/lib/auto-dialectic.test.mjs`
 * (the legacy test-tree location for this file) — this file covers ONLY the new
 * `decideAndRecordAutoDialectic()` wrapper and does not duplicate that coverage
 * (test-value.md § TV-004).
 */

import { describe, it, expect } from 'vitest';
import { decideAndRecordAutoDialectic } from '@lib/auto-dialectic.mjs';

describe('decideAndRecordAutoDialectic', () => {
  it('emits exactly one nudge_decided event with decided=false on the kill-switch path', async () => {
    const calls = [];
    const emitFn = async (...args) => {
      calls.push(args);
    };

    const decision = await decideAndRecordAutoDialectic({
      repoRoot: '/tmp/so-auto-dialectic-test-does-not-exist',
      cadence: 0,
      emitFn,
    });

    expect(decision.trigger).toBe(false);
    expect(calls).toHaveLength(1);
    const [type, payload] = calls[0];
    expect(type).toBe('orchestrator.dialectic.nudge_decided');
    expect(payload.decided).toBe(false);
  });

  it('emits exactly one nudge_decided event with decided=true on the cadence-threshold-met path', async () => {
    const calls = [];
    const emitFn = async (...args) => {
      calls.push(args);
    };

    const decision = await decideAndRecordAutoDialectic({
      repoRoot: '/tmp/so-auto-dialectic-test-does-not-exist',
      cadence: 3,
      signals: { lastRunAt: null, sessionsSinceLast: 5, learningsSinceLast: 2 },
      emitFn,
    });

    expect(decision.trigger).toBe(true);
    expect(calls).toHaveLength(1);
    const [type, payload] = calls[0];
    expect(type).toBe('orchestrator.dialectic.nudge_decided');
    expect(payload.decided).toBe(true);
  });

  it('a throwing emitFn does not change the returned decision', async () => {
    const emitFn = async () => {
      throw new Error('telemetry backend unreachable');
    };

    const decision = await decideAndRecordAutoDialectic({
      repoRoot: '/tmp/so-auto-dialectic-test-does-not-exist',
      cadence: 3,
      signals: { lastRunAt: null, sessionsSinceLast: 5, learningsSinceLast: 2 },
      emitFn,
    });

    expect(decision).toEqual({
      trigger: true,
      reason: 'cadence-threshold-met (sessions=5 >= cadence=3)',
      signals: { lastRunAt: null, sessionsSinceLast: 5, learningsSinceLast: 2 },
    });
  });

  it('record: false emits nothing', async () => {
    const calls = [];
    const emitFn = async (...args) => {
      calls.push(args);
    };

    const decision = await decideAndRecordAutoDialectic({
      repoRoot: '/tmp/so-auto-dialectic-test-does-not-exist',
      cadence: 0,
      emitFn,
      record: false,
    });

    expect(decision.trigger).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
