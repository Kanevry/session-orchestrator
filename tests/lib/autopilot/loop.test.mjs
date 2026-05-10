/**
 * tests/lib/autopilot/loop.test.mjs
 * Unit tests for autopilot/loop.mjs — runLoop with injected mocks.
 * Tests: dry-run short-circuit, pre-iteration kill-switches, post-session
 * kill-switches, token accumulation, AbortSignal, fallback-to-manual.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runLoop } from '../../../scripts/lib/autopilot/loop.mjs';
import { KILL_SWITCHES } from '../../../scripts/lib/autopilot/kill-switches.mjs';

let tmp;
let jsonlPath;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ap-loop-'));
  jsonlPath = path.join(tmp, 'autopilot.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared mock factory
// ---------------------------------------------------------------------------

function makeMocks(overrides = {}) {
  const sessionRunner = overrides.sessionRunner
    ?? (async ({ mode, autopilotRunId }) => ({ session_id: `${autopilotRunId}-${mode}` }));
  const modeSelector = overrides.modeSelector
    ?? (async () => ({ mode: 'feature', confidence: 0.95 }));
  const resourceEvaluator = overrides.resourceEvaluator
    ?? (() => ({ verdict: 'green' }));
  const peerCounter = overrides.peerCounter ?? (async () => 0);
  return { sessionRunner, modeSelector, resourceEvaluator, peerCounter };
}

// ---------------------------------------------------------------------------
// Dry-run short-circuit
// ---------------------------------------------------------------------------

describe('runLoop — dry-run short-circuit', () => {
  it('does not invoke sessionRunner when dryRun=true', async () => {
    let runs = 0;
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    await runLoop({
      dryRun: true,
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.85,
      sessionRunner: async () => { runs += 1; return { session_id: 'should-not-run' }; },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'dry-test',
    });
    expect(runs).toBe(0);
  });

  it('returns state with dry_run=true and 0 iterations', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      dryRun: true,
      maxSessions: 5,
      maxHours: 4,
      sessionRunner: async () => ({ session_id: 'x' }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'dry-state-test',
    });
    expect(state.dry_run).toBe(true);
    expect(state.iterations_completed).toBe(0);
    expect(state.sessions).toEqual([]);
  });

  it('writes a JSONL record even in dry-run mode', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    await runLoop({
      dryRun: true,
      maxSessions: 1,
      maxHours: 1,
      sessionRunner: async () => ({ session_id: 'x' }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'dry-jsonl-test',
    });
    expect(existsSync(jsonlPath)).toBe(true);
    const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim());
    expect(record.dry_run).toBe(true);
    expect(record.autopilot_run_id).toBe('dry-jsonl-test');
  });
});

// ---------------------------------------------------------------------------
// Pre-iteration kill-switches
// ---------------------------------------------------------------------------

describe('runLoop — pre-iteration: max-sessions-reached', () => {
  it('runs exactly one session then halts on maxSessions=1', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId, mode }) => {
        runs += 1;
        return { session_id: `${autopilotRunId}-${mode}` };
      },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'max-sess-1',
    });
    expect(runs).toBe(1);
    expect(state.iterations_completed).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
  });

  it('runs exactly three sessions then halts on maxSessions=3', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 3,
      maxHours: 24,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId, mode }) => {
        runs += 1;
        return { session_id: `${autopilotRunId}-${runs}-${mode}` };
      },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'max-sess-3',
    });
    expect(runs).toBe(3);
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
    expect(state.sessions).toHaveLength(3);
  });
});

describe('runLoop — pre-iteration: max-hours-exceeded', () => {
  it('fires before iter 1 when elapsed already exceeds maxHours', async () => {
    const startMs = Date.parse('2026-04-25T10:00:00Z');
    let calls = 0;
    const nowMs = () => {
      calls += 1;
      return calls === 1 ? startMs : startMs + 3_600_000; // second call: +1h
    };
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 0.5,
      confidenceThreshold: 0.5,
      sessionRunner: async () => { runs += 1; return { session_id: 'x' }; },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      nowMs,
      jsonlPath,
      runId: 'max-hours-test',
    });
    expect(runs).toBe(0);
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_HOURS_EXCEEDED);
  });
});

describe('runLoop — pre-iteration: resource-overload', () => {
  it('fires when verdict=critical AND peers > peerAbortThreshold', async () => {
    const { modeSelector } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async () => { runs += 1; return { session_id: 'x' }; },
      modeSelector,
      resourceEvaluator: () => ({ verdict: 'critical' }),
      peerCounter: async () => 8,
      peerAbortThreshold: 6,
      jsonlPath,
      runId: 'resource-overload-test',
    });
    expect(runs).toBe(0);
    expect(state.kill_switch).toBe(KILL_SWITCHES.RESOURCE_OVERLOAD);
    expect(state.kill_switch_detail).toMatch(/peers=8/);
  });

  it('does NOT fire when verdict=critical but peers <= peerAbortThreshold', async () => {
    const { modeSelector } = makeMocks();
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId }) => ({ session_id: `${autopilotRunId}-x` }),
      modeSelector,
      resourceEvaluator: () => ({ verdict: 'critical' }),
      peerCounter: async () => 6,
      peerAbortThreshold: 6,
      jsonlPath,
      runId: 'resource-no-fire',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
  });
});

describe('runLoop — pre-iteration: token-budget-exceeded', () => {
  it('fires TOKEN_BUDGET_EXCEEDED when cumulative tokens >= maxTokens after iter 1', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      maxTokens: 500_000,
      sessionRunner: async ({ autopilotRunId }) => {
        runs += 1;
        return { session_id: `${autopilotRunId}-r${runs}`, usage: { output_tokens: 600_000 } };
      },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'token-budget-test',
    });
    expect(runs).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.TOKEN_BUDGET_EXCEEDED);
    expect(state.total_tokens_used).toBe(600_000);
  });

  it('token accumulator is monotonic — halts when running total crosses threshold', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 10,
      maxHours: 4,
      confidenceThreshold: 0.5,
      maxTokens: 250_000,
      sessionRunner: async ({ autopilotRunId }) => {
        runs += 1;
        return { session_id: `${autopilotRunId}-r${runs}`, usage: { output_tokens: 100_000 } };
      },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'token-accumulate',
    });
    // 100k + 100k + 100k = 300k >= 250k → fires at start of iter 4
    expect(runs).toBe(3);
    expect(state.total_tokens_used).toBe(300_000);
    expect(state.kill_switch).toBe(KILL_SWITCHES.TOKEN_BUDGET_EXCEEDED);
  });

  it('does not fire when maxTokens omitted (default off sentinel = 0)', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 2,
      maxHours: 4,
      confidenceThreshold: 0.5,
      // maxTokens not provided — kill-switch should stay off
      sessionRunner: async ({ autopilotRunId }) => {
        runs += 1;
        return { session_id: `${autopilotRunId}-r${runs}`, usage: { output_tokens: 999_999 } };
      },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'token-off',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
    expect(runs).toBe(2);
  });
});

describe('runLoop — pre-iteration: user-abort', () => {
  it('fires user-abort immediately when AbortSignal already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async () => { runs += 1; return { session_id: 'x' }; },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      abortSignal: ctrl.signal,
      jsonlPath,
      runId: 'user-abort-pre',
    });
    expect(runs).toBe(0);
    expect(state.kill_switch).toBe(KILL_SWITCHES.USER_ABORT);
    expect(state.iterations_completed).toBe(0);
  });

  it('fires user-abort between iterations after first session completes', async () => {
    const ctrl = new AbortController();
    const { resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId, mode }) => {
        runs += 1;
        if (runs === 1) ctrl.abort();
        return { session_id: `${autopilotRunId}-${runs}-${mode}` };
      },
      modeSelector: async () => ({ mode: 'feature', confidence: 0.95 }),
      resourceEvaluator,
      peerCounter,
      abortSignal: ctrl.signal,
      jsonlPath,
      runId: 'user-abort-between',
    });
    expect(runs).toBe(1);
    expect(state.iterations_completed).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.USER_ABORT);
    expect(state.sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Post-session kill-switches
// ---------------------------------------------------------------------------

describe('runLoop — post-session: spiral', () => {
  it('fires spiral when agent_summary.spiral > 0 after iter 1', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId }) => {
        runs += 1;
        return {
          session_id: `${autopilotRunId}-r${runs}`,
          agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 2 },
        };
      },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'spiral-test',
    });
    expect(runs).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.SPIRAL);
    expect(state.kill_switch_detail).toMatch(/spiral=2/);
  });
});

describe('runLoop — post-session: failed-wave', () => {
  it('fires failed-wave when agent_summary.failed > 0', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId }) => {
        runs += 1;
        return {
          session_id: `${autopilotRunId}-r${runs}`,
          agent_summary: { complete: 0, partial: 0, failed: 3, spiral: 0 },
        };
      },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'failed-wave-test',
    });
    expect(runs).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.FAILED_WAVE);
    expect(state.kill_switch_detail).toMatch(/failed=3/);
  });

  it('fires sessionRunner-threw failed-wave when sessionRunner throws', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async () => { throw new Error('spawn failed'); },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'runner-throw-test',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.FAILED_WAVE);
    expect(state.kill_switch_detail).toMatch(/sessionRunner threw/);
  });
});

describe('runLoop — post-session: carryover-too-high', () => {
  it('fires carryover-too-high when carryover/planned > 0.5 (default)', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId }) => {
        runs += 1;
        return {
          session_id: `${autopilotRunId}-r${runs}`,
          agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
          effectiveness: { planned_issues: 4, carryover: 3 }, // 0.75 > 0.5
        };
      },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'carryover-test',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.CARRYOVER_TOO_HIGH);
    expect(state.kill_switch_detail).toMatch(/threshold=0\.5/);
  });

  it('does not fire when carryover/planned <= threshold (boundary 0.5)', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId }) => ({
        session_id: `${autopilotRunId}-x`,
        effectiveness: { planned_issues: 4, carryover: 2 }, // 0.5, NOT > 0.5
      }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'carryover-boundary',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
  });

  it('opts.carryoverThreshold overrides default', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      carryoverThreshold: 0.2,
      sessionRunner: async ({ autopilotRunId }) => ({
        session_id: `${autopilotRunId}-x`,
        effectiveness: { planned_issues: 10, carryover: 3 }, // 0.3 > 0.2
      }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'carryover-strict',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.CARRYOVER_TOO_HIGH);
    expect(state.kill_switch_detail).toMatch(/threshold=0\.2/);
  });
});

// ---------------------------------------------------------------------------
// Fallback-to-manual
// ---------------------------------------------------------------------------

describe('runLoop — fallback-to-manual', () => {
  it('iter 1 sub-threshold → fallback_to_manual=true, kill_switch=null', async () => {
    const { resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.85,
      sessionRunner: async () => ({ session_id: 'x' }),
      modeSelector: async () => ({ mode: 'feature', confidence: 0.4 }),
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'fallback-iter1',
    });
    expect(state.fallback_to_manual).toBe(true);
    expect(state.kill_switch).toBeNull();
    expect(state.iterations_completed).toBe(0);
    expect(state.kill_switch_detail).toMatch(/iteration 1/);
  });

  it('iter 2+ sub-threshold → kill_switch=low-confidence-fallback', async () => {
    const { resourceEvaluator, peerCounter } = makeMocks();
    let modeCalls = 0;
    const modeSelector = async () => {
      modeCalls += 1;
      return modeCalls === 1
        ? { mode: 'feature', confidence: 0.95 }
        : { mode: 'feature', confidence: 0.3 };
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.85,
      sessionRunner: async ({ autopilotRunId }) => ({ session_id: `${autopilotRunId}-x` }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'fallback-iter2',
    });
    expect(state.fallback_to_manual).toBe(false);
    expect(state.kill_switch).toBe(KILL_SWITCHES.LOW_CONFIDENCE_FALLBACK);
    expect(state.kill_switch_detail).toMatch(/iteration 2/);
    expect(state.iterations_completed).toBe(1);
  });

  it('modeSelector throws → kill_switch=low-confidence-fallback', async () => {
    const { resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async () => ({ session_id: 'x' }),
      modeSelector: async () => { throw new Error('selector failed'); },
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'mode-throw',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.LOW_CONFIDENCE_FALLBACK);
    expect(state.kill_switch_detail).toMatch(/modeSelector threw/);
  });
});

// ---------------------------------------------------------------------------
// ADR-364 additive fields — opts.worktreePath / opts.parentRunId / stall_recovery_count
// ---------------------------------------------------------------------------

describe('runLoop — ADR-364 additive fields', () => {
  it('worktree_path and parent_run_id from opts appear in the JSONL record', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId }) => ({ session_id: `${autopilotRunId}-x` }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'adr364-with-opts',
      worktreePath: '/tmp/wt-foo',
      parentRunId: 'parent-r1',
    });
    const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').pop());
    expect(record.worktree_path).toBe('/tmp/wt-foo');
    expect(record.parent_run_id).toBe('parent-r1');
    expect(record.stall_recovery_count).toBe(0);
  });

  it('worktree_path and parent_run_id default to null when opts omit them', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId }) => ({ session_id: `${autopilotRunId}-x` }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'adr364-defaults',
      // worktreePath and parentRunId intentionally absent
    });
    expect(state.worktree_path).toBeNull();
    expect(state.parent_run_id).toBeNull();
    expect(state.stall_recovery_count).toBe(0);
  });

  it('stall_recovery_count is 0 in dry-run short-circuit path', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      dryRun: true,
      maxSessions: 5,
      maxHours: 4,
      sessionRunner: async () => ({ session_id: 'x' }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'adr364-dryrun',
      worktreePath: '/tmp/wt-dry',
      parentRunId: 'parent-dry',
    });
    expect(state.worktree_path).toBe('/tmp/wt-dry');
    expect(state.parent_run_id).toBe('parent-dry');
    expect(state.stall_recovery_count).toBe(0);
  });

  it('JSONL record written for opts-with-values contains non-null worktree_path and parent_run_id', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    await runLoop({
      dryRun: true,
      maxSessions: 1,
      maxHours: 1,
      sessionRunner: async () => ({ session_id: 'x' }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'adr364-jsonl-verify',
      worktreePath: '/tmp/wt-bar',
      parentRunId: 'parent-bar',
    });
    const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim());
    expect(record.worktree_path).toBe('/tmp/wt-bar');
    expect(record.parent_run_id).toBe('parent-bar');
    expect(record.stall_recovery_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// State shape + telemetry
// ---------------------------------------------------------------------------

describe('runLoop — state shape and telemetry record', () => {
  it('written JSONL record contains all schema_version-1 fields', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId }) => ({ session_id: `${autopilotRunId}-x` }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'shape-test',
    });
    const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').pop());
    expect(record).toMatchObject({
      schema_version: 1,
      autopilot_run_id: 'shape-test',
      iterations_completed: 1,
      kill_switch: KILL_SWITCHES.MAX_SESSIONS_REACHED,
      fallback_to_manual: false,
      dry_run: false,
    });
    expect(typeof record.started_at).toBe('string');
    expect(typeof record.completed_at).toBe('string');
    expect(typeof record.duration_seconds).toBe('number');
  });

  it('autopilotRunId is propagated to sessionRunner on every iteration', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const observed = [];
    await runLoop({
      maxSessions: 3,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId, mode }) => {
        observed.push(autopilotRunId);
        return { session_id: `${autopilotRunId}-${mode}-${observed.length}` };
      },
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'propagation-test',
    });
    expect(observed).toHaveLength(3);
    expect(observed.every((id) => id === 'propagation-test')).toBe(true);
  });

  it('JSONL record written even when kill-switch fires before iter 1', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async () => ({ session_id: 'x' }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      abortSignal: ctrl.signal,
      jsonlPath,
      runId: 'pre-iter-kill-record',
    });
    expect(existsSync(jsonlPath)).toBe(true);
    const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim());
    expect(record.kill_switch).toBe(KILL_SWITCHES.USER_ABORT);
  });

  it('token accumulator stays at 0 when sessionRunner omits usage field', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      maxSessions: 2,
      maxHours: 4,
      confidenceThreshold: 0.5,
      maxTokens: 500_000,
      sessionRunner: async ({ autopilotRunId }) => ({ session_id: `${autopilotRunId}-x` }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'token-compat',
    });
    expect(state.total_tokens_used).toBe(0);
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
  });
});

// ---------------------------------------------------------------------------
// STALL_TIMEOUT wire-up (issue #371)
// ---------------------------------------------------------------------------

describe('runLoop — STALL_TIMEOUT wire-up (issue #371)', () => {
  it('increments state.stall_recovery_count when STALL_TIMEOUT fires', async () => {
    // Seed a stale autopilot.jsonl at a DIFFERENT path than the loop's output —
    // this lets us pre-stale the sampler input without contaminating the
    // loop's own append-once write.
    const stalePath = path.join(tmp, 'stale-autopilot.jsonl');
    writeFileSync(stalePath, JSON.stringify({ marker: 'old' }) + '\n');
    // Force a fixed clock so we control deltaMs deterministically.
    const fakeNow = 2_000_000_000_000;
    const staleMs = fakeNow - 1000 * 1000; // 1000s in the past (>= 600 threshold)
    utimesSync(stalePath, new Date(staleMs), new Date(staleMs));

    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async ({ autopilotRunId }) => ({
        session_id: `${autopilotRunId}-r1`,
        agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
      }),
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'stall-recovery-test',
      // Point the STALL sampler at the stale path; supply the fixed clock.
      autopilotJsonlPath: stalePath,
      stallTimeoutSeconds: 600,
      nowMs: () => fakeNow,
    });

    expect(state.kill_switch).toBe(KILL_SWITCHES.STALL_TIMEOUT);
    expect(state.stall_recovery_count).toBe(1);
    expect(state.kill_switch_detail).toMatch(/stalled \d+s/);

    // Verify the JSONL record carries the recovery counter through telemetry.
    const records = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const last = JSON.parse(records[records.length - 1]);
    expect(last.stall_recovery_count).toBe(1);
    expect(last.kill_switch).toBe('stall-timeout');
  });
});
