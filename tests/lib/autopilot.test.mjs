import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseFlags,
  runLoop,
  writeAutopilotJsonl,
  KILL_SWITCHES,
  FLAG_BOUNDS,
  SCHEMA_VERSION,
  DEFAULT_PEER_ABORT_THRESHOLD,
  DEFAULT_JSONL_PATH,
  DEFAULT_CARRYOVER_THRESHOLD,
} from '../../scripts/lib/autopilot.mjs';

let tmp;
let jsonlPath;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'autopilot-'));
  jsonlPath = path.join(tmp, 'autopilot.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('autopilot — exported constants', () => {
  it('SCHEMA_VERSION is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('KILL_SWITCHES enumerates all 8 kill-switches (5 pre-iteration + 3 post-session)', () => {
    const values = Object.values(KILL_SWITCHES);
    expect(values).toContain('max-sessions-reached');
    expect(values).toContain('max-hours-exceeded');
    expect(values).toContain('resource-overload');
    expect(values).toContain('low-confidence-fallback');
    expect(values).toContain('user-abort');
    expect(values).toContain('spiral');
    expect(values).toContain('failed-wave');
    expect(values).toContain('carryover-too-high');
  });

  it('DEFAULT_PEER_ABORT_THRESHOLD is 6', () => {
    expect(DEFAULT_PEER_ABORT_THRESHOLD).toBe(6);
  });

  it('DEFAULT_JSONL_PATH is .orchestrator/metrics/autopilot.jsonl', () => {
    expect(DEFAULT_JSONL_PATH).toBe('.orchestrator/metrics/autopilot.jsonl');
  });

  it('DEFAULT_CARRYOVER_THRESHOLD is 0.5', () => {
    expect(DEFAULT_CARRYOVER_THRESHOLD).toBe(0.5);
  });

  it('FLAG_BOUNDS encodes spec defaults', () => {
    expect(FLAG_BOUNDS.maxSessions).toEqual({ min: 1, max: 50, default: 5 });
    expect(FLAG_BOUNDS.maxHours).toEqual({ min: 0.5, max: 24.0, default: 4.0 });
    expect(FLAG_BOUNDS.confidenceThreshold).toEqual({ min: 0, max: 1, default: 0.85 });
  });
});

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe('parseFlags — bounds clamping', () => {
  it('empty argv yields all defaults', () => {
    expect(parseFlags([])).toEqual({
      maxSessions: 5,
      maxHours: 4.0,
      confidenceThreshold: 0.85,
      dryRun: false,
    });
  });

  it('non-array argv defaults silently', () => {
    expect(parseFlags(null)).toEqual({
      maxSessions: 5,
      maxHours: 4.0,
      confidenceThreshold: 0.85,
      dryRun: false,
    });
    expect(parseFlags(undefined).maxSessions).toBe(5);
  });

  it('clamps max-sessions over upper bound to 50', () => {
    expect(parseFlags(['--max-sessions=999']).maxSessions).toBe(50);
  });

  it('clamps max-sessions under lower bound to 1', () => {
    expect(parseFlags(['--max-sessions=0']).maxSessions).toBe(1);
    expect(parseFlags(['--max-sessions=-5']).maxSessions).toBe(1);
  });

  it('clamps max-hours below 0.5 to 0.5', () => {
    expect(parseFlags(['--max-hours=0']).maxHours).toBe(0.5);
    expect(parseFlags(['--max-hours=-1']).maxHours).toBe(0.5);
  });

  it('clamps max-hours above 24.0 to 24.0', () => {
    expect(parseFlags(['--max-hours=100']).maxHours).toBe(24.0);
  });

  it('clamps confidence-threshold to [0.0, 1.0]', () => {
    expect(parseFlags(['--confidence-threshold=2']).confidenceThreshold).toBe(1);
    expect(parseFlags(['--confidence-threshold=-0.5']).confidenceThreshold).toBe(0);
  });

  it('non-numeric values fall back to defaults', () => {
    const f = parseFlags(['--max-sessions=abc', '--max-hours=NaN', '--confidence-threshold=foo']);
    expect(f.maxSessions).toBe(5);
    expect(f.maxHours).toBe(4.0);
    expect(f.confidenceThreshold).toBe(0.85);
  });

  it('--dry-run flag toggles dryRun=true', () => {
    expect(parseFlags(['--dry-run']).dryRun).toBe(true);
    expect(parseFlags(['--dryRun']).dryRun).toBe(true);
    expect(parseFlags([]).dryRun).toBe(false);
  });

  it('mixed valid + clamped flags resolve independently', () => {
    expect(parseFlags(['--max-sessions=3', '--max-hours=999', '--dry-run'])).toEqual({
      maxSessions: 3,
      maxHours: 24.0,
      confidenceThreshold: 0.85,
      dryRun: true,
    });
  });

  it('unknown flags are ignored', () => {
    const f = parseFlags(['--max-sessions=2', '--unknown-flag=foo', '--bogus']);
    expect(f.maxSessions).toBe(2);
  });

  it('floors max-sessions to integer', () => {
    expect(parseFlags(['--max-sessions=3.7']).maxSessions).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// writeAutopilotJsonl atomicity
// ---------------------------------------------------------------------------

describe('writeAutopilotJsonl — atomic tmp+rename', () => {
  it('writes a JSONL line for the given state', () => {
    const state = {
      schema_version: 1,
      autopilot_run_id: 'main-2026-04-25-1042-autopilot',
      iterations_completed: 0,
      kill_switch: null,
      sessions: [],
    };
    writeAutopilotJsonl(state, jsonlPath);
    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      schema_version: 1,
      autopilot_run_id: 'main-2026-04-25-1042-autopilot',
    });
  });

  it('appends to existing JSONL — preserves prior records', () => {
    writeAutopilotJsonl({ autopilot_run_id: 'first' }, jsonlPath);
    writeAutopilotJsonl({ autopilot_run_id: 'second' }, jsonlPath);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).autopilot_run_id).toBe('first');
    expect(JSON.parse(lines[1]).autopilot_run_id).toBe('second');
  });

  it('leaves no .tmp- residue after success', () => {
    writeAutopilotJsonl({ autopilot_run_id: 'x' }, jsonlPath);
    const residue = readdirSync(tmp).filter((n) => n.includes('.tmp-'));
    expect(residue).toEqual([]);
  });

  it('creates parent directories if missing', () => {
    const nested = path.join(tmp, 'a', 'b', 'c', 'autopilot.jsonl');
    writeAutopilotJsonl({ autopilot_run_id: 'nested' }, nested);
    expect(existsSync(nested)).toBe(true);
  });

  it('throws TypeError on non-object state', () => {
    expect(() => writeAutopilotJsonl(null, jsonlPath)).toThrow(TypeError);
    expect(() => writeAutopilotJsonl('not-an-object', jsonlPath)).toThrow(TypeError);
  });

  it('throws TypeError on non-string path', () => {
    expect(() => writeAutopilotJsonl({}, '')).toThrow(TypeError);
    expect(() => writeAutopilotJsonl({}, null)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// runLoop — kill-switch paths
// ---------------------------------------------------------------------------

function makeMocks(overrides = {}) {
  const sessionRunner = overrides.sessionRunner
    ?? (async ({ mode, autopilotRunId }) => ({ session_id: `${autopilotRunId}-${mode}` }));
  const modeSelector = overrides.modeSelector
    ?? (async () => ({ mode: 'feature', confidence: 0.95, rationale: 'mock' }));
  const resourceEvaluator = overrides.resourceEvaluator
    ?? (() => ({ verdict: 'green' }));
  const peerCounter = overrides.peerCounter ?? (async () => 0);
  return { sessionRunner, modeSelector, resourceEvaluator, peerCounter };
}

describe('runLoop — kill-switch: max-sessions-reached', () => {
  it('--max-sessions=1 runs exactly one iteration then exits', async () => {
    const { sessionRunner, modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const wrappedRunner = async (args) => {
      runs += 1;
      return sessionRunner(args);
    };
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: wrappedRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'test-run-1',
    });
    expect(runs).toBe(1);
    expect(state.iterations_completed).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
    expect(state.sessions).toHaveLength(1);
    expect(state.fallback_to_manual).toBe(false);
  });

  it('--max-sessions=3 with a fast clock runs three iterations', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const sessionRunner = async ({ mode, autopilotRunId }) => {
      runs += 1;
      return { session_id: `${autopilotRunId}-${runs}-${mode}` };
    };
    const state = await runLoop({
      maxSessions: 3,
      maxHours: 24,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'test-run-3',
    });
    expect(runs).toBe(3);
    expect(state.iterations_completed).toBe(3);
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
    expect(state.sessions).toHaveLength(3);
  });
});

describe('runLoop — kill-switch: max-hours-exceeded', () => {
  it('--max-hours=0.5 with elapsed > 30min triggers max-hours-exceeded before iter 1', async () => {
    const { sessionRunner, modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const startMs = Date.parse('2026-04-25T10:00:00Z');
    let calls = 0;
    const nowMs = () => {
      calls += 1;
      // First call is started_at; subsequent calls jump 1h ahead
      return calls === 1 ? startMs : startMs + 3_600_000;
    };
    let runs = 0;
    const wrappedRunner = async (args) => {
      runs += 1;
      return sessionRunner(args);
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 0.5,
      confidenceThreshold: 0.5,
      sessionRunner: wrappedRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      nowMs,
      jsonlPath,
      runId: 'test-run-mh',
    });
    expect(runs).toBe(0);
    expect(state.iterations_completed).toBe(0);
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_HOURS_EXCEEDED);
  });
});

describe('runLoop — kill-switch: resource-overload', () => {
  it('verdict=critical AND peers > peerAbortThreshold fires resource-overload before iter 1', async () => {
    const { sessionRunner, modeSelector } = makeMocks();
    let runs = 0;
    const wrappedRunner = async (args) => {
      runs += 1;
      return sessionRunner(args);
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: wrappedRunner,
      modeSelector,
      resourceEvaluator: () => ({ verdict: 'critical' }),
      peerCounter: async () => 8,
      peerAbortThreshold: 6,
      jsonlPath,
      runId: 'test-run-ro',
    });
    expect(runs).toBe(0);
    expect(state.kill_switch).toBe(KILL_SWITCHES.RESOURCE_OVERLOAD);
    expect(state.kill_switch_detail).toMatch(/peers=8/);
  });

  it('verdict=critical with peers <= threshold does NOT fire (still critical, but inside budget)', async () => {
    const { sessionRunner, modeSelector } = makeMocks();
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator: () => ({ verdict: 'critical' }),
      peerCounter: async () => 6,
      peerAbortThreshold: 6,
      jsonlPath,
      runId: 'test-run-ro2',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
  });
});

describe('runLoop — kill-switch: low-confidence-fallback', () => {
  it('iter 1 sub-threshold → fallback_to_manual=true, iterations_completed=0, kill_switch=null', async () => {
    const { sessionRunner, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const wrappedRunner = async (args) => {
      runs += 1;
      return sessionRunner(args);
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.85,
      sessionRunner: wrappedRunner,
      modeSelector: async () => ({ mode: 'feature', confidence: 0.4 }),
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'test-run-lc1',
    });
    expect(runs).toBe(0);
    expect(state.fallback_to_manual).toBe(true);
    expect(state.iterations_completed).toBe(0);
    expect(state.kill_switch).toBeNull();
    expect(state.kill_switch_detail).toMatch(/iteration 1/);
  });

  it('iter 2+ sub-threshold → kill_switch=low-confidence-fallback, fallback_to_manual=false', async () => {
    const { sessionRunner, resourceEvaluator, peerCounter } = makeMocks();
    let modeCalls = 0;
    const modeSelector = async () => {
      modeCalls += 1;
      // First call: high confidence; subsequent calls: low confidence
      return modeCalls === 1
        ? { mode: 'feature', confidence: 0.95 }
        : { mode: 'feature', confidence: 0.3 };
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.85,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'test-run-lc2',
    });
    expect(state.iterations_completed).toBe(1);
    expect(state.fallback_to_manual).toBe(false);
    expect(state.kill_switch).toBe(KILL_SWITCHES.LOW_CONFIDENCE_FALLBACK);
    expect(state.kill_switch_detail).toMatch(/iteration 2/);
  });

  it('--confidence-threshold=0.0 always auto-executes (debug mode)', async () => {
    const { sessionRunner, resourceEvaluator, peerCounter } = makeMocks();
    const state = await runLoop({
      maxSessions: 2,
      maxHours: 4,
      confidenceThreshold: 0.0,
      sessionRunner,
      modeSelector: async () => ({ mode: 'feature', confidence: 0.0 }),
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'test-run-debug',
    });
    expect(state.iterations_completed).toBe(2);
    expect(state.fallback_to_manual).toBe(false);
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
  });
});

describe('runLoop — kill-switch: user-abort', () => {
  it('AbortSignal already aborted before loop entry → kill_switch=user-abort, no sessions run', async () => {
    const { sessionRunner, modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const ctrl = new AbortController();
    ctrl.abort();
    let runs = 0;
    const wrappedRunner = async (args) => {
      runs += 1;
      return sessionRunner(args);
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: wrappedRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      abortSignal: ctrl.signal,
      jsonlPath,
      runId: 'test-run-abort',
    });
    expect(runs).toBe(0);
    expect(state.iterations_completed).toBe(0);
    expect(state.kill_switch).toBe(KILL_SWITCHES.USER_ABORT);
  });

  it('AbortSignal flipped between iterations stops the loop after the in-flight session', async () => {
    const { resourceEvaluator, peerCounter } = makeMocks();
    const ctrl = new AbortController();
    let runs = 0;
    const wrappedRunner = async ({ mode, autopilotRunId }) => {
      runs += 1;
      if (runs === 1) ctrl.abort();
      return { session_id: `${autopilotRunId}-${runs}-${mode}` };
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: wrappedRunner,
      modeSelector: async () => ({ mode: 'feature', confidence: 0.95 }),
      resourceEvaluator,
      peerCounter,
      abortSignal: ctrl.signal,
      jsonlPath,
      runId: 'test-run-abort2',
    });
    expect(runs).toBe(1);
    expect(state.iterations_completed).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.USER_ABORT);
    expect(state.sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// runLoop — dry-run + telemetry
// ---------------------------------------------------------------------------

describe('runLoop — --dry-run', () => {
  it('does not invoke sessionRunner, writes record with dry_run=true', async () => {
    let runs = 0;
    const sessionRunner = async () => { runs += 1; return { session_id: 'should-not-run' }; };
    const state = await runLoop({
      dryRun: true,
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.85,
      sessionRunner,
      modeSelector: async () => ({ mode: 'feature', confidence: 0.95 }),
      resourceEvaluator: () => ({ verdict: 'green' }),
      peerCounter: async () => 0,
      jsonlPath,
      runId: 'test-run-dry',
    });
    expect(runs).toBe(0);
    expect(state.dry_run).toBe(true);
    expect(state.iterations_completed).toBe(0);
    expect(state.sessions).toEqual([]);
    expect(existsSync(jsonlPath)).toBe(true);
    const line = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').pop());
    expect(line.dry_run).toBe(true);
  });
});

describe('runLoop — telemetry record shape', () => {
  it('written record contains all schema_version-1 fields', async () => {
    const { sessionRunner, modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'shape-test',
    });
    const line = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').pop());
    expect(line).toMatchObject({
      schema_version: 1,
      autopilot_run_id: 'shape-test',
      iterations_completed: 1,
      kill_switch: KILL_SWITCHES.MAX_SESSIONS_REACHED,
      sessions: expect.any(Array),
      fallback_to_manual: false,
      dry_run: false,
      max_sessions: 1,
      max_hours: 4,
      confidence_threshold: 0.5,
    });
    expect(typeof line.started_at).toBe('string');
    expect(typeof line.completed_at).toBe('string');
    expect(typeof line.duration_seconds).toBe('number');
  });

  it('autopilot.jsonl record is written even when a kill-switch fires before iter 1', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async () => ({ session_id: 'unreached' }),
      modeSelector: async () => ({ mode: 'feature', confidence: 0.95 }),
      resourceEvaluator: () => ({ verdict: 'green' }),
      peerCounter: async () => 0,
      abortSignal: ctrl.signal,
      jsonlPath,
      runId: 'kill-before-iter1',
    });
    expect(existsSync(jsonlPath)).toBe(true);
    const line = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').pop());
    expect(line.autopilot_run_id).toBe('kill-before-iter1');
    expect(line.kill_switch).toBe(KILL_SWITCHES.USER_ABORT);
  });

  it('default runId is constructed from branch + UTC date+time', async () => {
    const fixedMs = Date.parse('2026-04-25T08:42:00Z');
    let calls = 0;
    const nowMs = () => {
      calls += 1;
      return fixedMs + calls;
    };
    const ctrl = new AbortController();
    ctrl.abort();
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner: async () => ({ session_id: 'x' }),
      modeSelector: async () => ({ mode: 'feature', confidence: 0.95 }),
      resourceEvaluator: () => ({ verdict: 'green' }),
      peerCounter: async () => 0,
      abortSignal: ctrl.signal,
      nowMs,
      jsonlPath,
      branch: 'main',
    });
    expect(state.autopilot_run_id).toMatch(/^main-2026-04-25-0842-autopilot$/);
  });
});

// ---------------------------------------------------------------------------
// Post-session kill-switches (Phase C-1.b, #300)
// ---------------------------------------------------------------------------

describe('runLoop — kill-switch: spiral', () => {
  it('agent_summary.spiral > 0 after iter 1 fires kill_switch=spiral', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const sessionRunner = async ({ autopilotRunId, mode }) => {
      runs += 1;
      return {
        session_id: `${autopilotRunId}-${mode}-${runs}`,
        agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 2 },
      };
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'spiral-test',
    });
    expect(runs).toBe(1);
    expect(state.iterations_completed).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.SPIRAL);
    expect(state.kill_switch_detail).toMatch(/agent_summary\.spiral=2/);
    expect(state.sessions).toHaveLength(1);
  });

  it('agent_summary.spiral === 0 (no spiral) does NOT fire — loop continues to next gate', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const sessionRunner = async ({ autopilotRunId }) => ({
      session_id: `${autopilotRunId}-clean`,
      agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
    });
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'no-spiral-test',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
    expect(state.iterations_completed).toBe(1);
  });
});

describe('runLoop — kill-switch: failed-wave', () => {
  it('agent_summary.failed > 0 after iter 1 fires kill_switch=failed-wave', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const sessionRunner = async ({ autopilotRunId }) => {
      runs += 1;
      return {
        session_id: `${autopilotRunId}-r${runs}`,
        agent_summary: { complete: 0, partial: 0, failed: 3, spiral: 0 },
      };
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'failed-wave-test',
    });
    expect(runs).toBe(1);
    expect(state.iterations_completed).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.FAILED_WAVE);
    expect(state.kill_switch_detail).toMatch(/agent_summary\.failed=3/);
  });

  it('spiral takes precedence over failed when both fields fire', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const sessionRunner = async ({ autopilotRunId }) => ({
      session_id: `${autopilotRunId}-both`,
      agent_summary: { complete: 0, partial: 0, failed: 1, spiral: 1 },
    });
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'both-fire',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.SPIRAL);
  });
});

describe('runLoop — kill-switch: carryover-too-high', () => {
  it('carryover/planned > threshold (default 0.5) fires kill_switch=carryover-too-high', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    let runs = 0;
    const sessionRunner = async ({ autopilotRunId }) => {
      runs += 1;
      return {
        session_id: `${autopilotRunId}-co${runs}`,
        agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
        effectiveness: { planned_issues: 5, carryover: 4, completion_rate: 0.2 },
      };
    };
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'carryover-test',
    });
    expect(runs).toBe(1);
    expect(state.iterations_completed).toBe(1);
    expect(state.kill_switch).toBe(KILL_SWITCHES.CARRYOVER_TOO_HIGH);
    expect(state.kill_switch_detail).toMatch(/carryover\/planned=0\.8/);
    expect(state.kill_switch_detail).toMatch(/threshold=0\.5/);
  });

  it('ratio at-or-below threshold does NOT fire (boundary 0.5 with planned=4, carryover=2)', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const sessionRunner = async ({ autopilotRunId }) => ({
      session_id: `${autopilotRunId}-boundary`,
      effectiveness: { planned_issues: 4, carryover: 2 }, // ratio = 0.5, NOT > 0.5
    });
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'boundary-test',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
    expect(state.iterations_completed).toBe(1);
  });

  it('planned_issues=0 does NOT fire even if carryover>0 (avoids div-by-zero)', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const sessionRunner = async ({ autopilotRunId }) => ({
      session_id: `${autopilotRunId}-zero`,
      effectiveness: { planned_issues: 0, carryover: 3 },
    });
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'zero-planned',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
  });

  it('opts.carryoverThreshold overrides DEFAULT_CARRYOVER_THRESHOLD', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const sessionRunner = async ({ autopilotRunId }) => ({
      session_id: `${autopilotRunId}-strict`,
      effectiveness: { planned_issues: 10, carryover: 3 }, // ratio 0.3, would NOT fire at default 0.5
    });
    const state = await runLoop({
      maxSessions: 5,
      maxHours: 4,
      confidenceThreshold: 0.5,
      carryoverThreshold: 0.2, // strict — fires at 0.3 > 0.2
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'strict-threshold',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.CARRYOVER_TOO_HIGH);
    expect(state.kill_switch_detail).toMatch(/threshold=0\.2/);
  });

  it('absent agent_summary AND effectiveness → no post-session kill (forward-compat)', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const sessionRunner = async ({ autopilotRunId }) => ({
      session_id: `${autopilotRunId}-bare`,
      // No agent_summary, no effectiveness — older sessionRunner contract.
    });
    const state = await runLoop({
      maxSessions: 1,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'bare-test',
    });
    expect(state.kill_switch).toBe(KILL_SWITCHES.MAX_SESSIONS_REACHED);
    expect(state.iterations_completed).toBe(1);
  });
});

describe('runLoop — autopilotRunId propagation (#300)', () => {
  it('sessionRunner receives autopilotRunId === state.autopilot_run_id every iteration', async () => {
    const { modeSelector, resourceEvaluator, peerCounter } = makeMocks();
    const observedRunIds = [];
    const sessionRunner = async ({ autopilotRunId, mode }) => {
      observedRunIds.push(autopilotRunId);
      return { session_id: `${autopilotRunId}-${mode}-${observedRunIds.length}` };
    };
    const state = await runLoop({
      maxSessions: 3,
      maxHours: 4,
      confidenceThreshold: 0.5,
      sessionRunner,
      modeSelector,
      resourceEvaluator,
      peerCounter,
      jsonlPath,
      runId: 'propagation-test',
    });
    expect(state.autopilot_run_id).toBe('propagation-test');
    expect(observedRunIds).toHaveLength(3);
    expect(observedRunIds.every((id) => id === 'propagation-test')).toBe(true);
    expect(state.iterations_completed).toBe(3);
    expect(state.sessions).toEqual([
      'propagation-test-feature-1',
      'propagation-test-feature-2',
      'propagation-test-feature-3',
    ]);
  });
});
