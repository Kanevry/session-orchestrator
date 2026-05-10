/**
 * autopilot/loop.mjs — runLoop: the main autopilot session controller.
 *
 * All I/O is injected via opts — no child-process spawning, no direct file I/O.
 * DAG: kill-switches (leaf) + flags (leaf) + telemetry (leaf) → loop → barrel
 */

import { KILL_SWITCHES, preIterationKillSwitch, postSessionKillSwitch } from './kill-switches.mjs';
import {
  FLAG_BOUNDS,
  DEFAULT_PEER_ABORT_THRESHOLD,
  DEFAULT_JSONL_PATH,
  DEFAULT_CARRYOVER_THRESHOLD,
} from './flags.mjs';
import {
  SCHEMA_VERSION,
  writeAutopilotJsonl,
  defaultRunId,
  readHostClass,
  finalizeState,
} from './telemetry.mjs';

// Internal clamp — mirrors flags.mjs internal; not re-exported there.
function clampNumber(value, { min, max, fallback }) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * @typedef {Object} AutopilotState
 * @property {number} schema_version @property {string} autopilot_run_id @property {string} started_at
 * @property {string} completed_at @property {number} duration_seconds @property {number} max_sessions
 * @property {number} max_hours @property {number} confidence_threshold @property {number} iterations_completed
 * @property {string|null} kill_switch @property {string|null} kill_switch_detail @property {string[]} sessions
 * @property {string|null} host_class @property {string|null} resource_verdict_at_start
 * @property {boolean} fallback_to_manual @property {boolean} dry_run @property {number} total_tokens_used
 * @property {string|null} worktree_path @property {string|null} parent_run_id @property {number} stall_recovery_count
 */

/**
 * Run the autopilot loop. All I/O is injected via opts — pass real implementations
 * in production, mocks in tests.
 *
 * @param {object} opts
 * @param {number} [opts.maxSessions] @param {number} [opts.maxHours]
 * @param {number} [opts.confidenceThreshold] @param {boolean} [opts.dryRun]
 * @param {() => Promise<{mode: string, confidence: number}>} [opts.modeSelector]
 * @param {(args: {mode: string, autopilotRunId: string}) => Promise<{session_id: string}>} [opts.sessionRunner]
 * @param {() => {verdict: string}} [opts.resourceEvaluator]
 * @param {() => Promise<number>} [opts.peerCounter]
 * @param {() => number} [opts.nowMs] @param {AbortSignal} [opts.abortSignal]
 * @param {string} [opts.jsonlPath] @param {string} [opts.runId] @param {string} [opts.branch]
 * @param {string} [opts.hostJsonPath] @param {number} [opts.peerAbortThreshold]
 * @param {number} [opts.carryoverThreshold] @param {number} [opts.maxTokens]
 * @param {string} [opts.autopilotJsonlPath] — STALL_TIMEOUT sampler input (defaults to jsonlPath)
 * @param {number} [opts.stallTimeoutSeconds] — STALL_TIMEOUT threshold seconds (default 600)
 * @param {string} [opts.worktreePath] @param {string} [opts.parentRunId]
 * @returns {Promise<AutopilotState>}
 */
export async function runLoop(opts = {}) {
  const maxSessions = Math.floor(clampNumber(opts.maxSessions, {
    min: FLAG_BOUNDS.maxSessions.min,
    max: FLAG_BOUNDS.maxSessions.max,
    fallback: FLAG_BOUNDS.maxSessions.default,
  }));
  const maxHours = clampNumber(opts.maxHours, {
    min: FLAG_BOUNDS.maxHours.min,
    max: FLAG_BOUNDS.maxHours.max,
    fallback: FLAG_BOUNDS.maxHours.default,
  });
  const confidenceThreshold = clampNumber(opts.confidenceThreshold, {
    min: FLAG_BOUNDS.confidenceThreshold.min,
    max: FLAG_BOUNDS.confidenceThreshold.max,
    fallback: FLAG_BOUNDS.confidenceThreshold.default,
  });
  const dryRun = Boolean(opts.dryRun);

  const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : () => Date.now();
  const jsonlPath = typeof opts.jsonlPath === 'string' && opts.jsonlPath.length > 0
    ? opts.jsonlPath
    : DEFAULT_JSONL_PATH;
  const peerAbortThreshold = typeof opts.peerAbortThreshold === 'number'
    ? opts.peerAbortThreshold
    : DEFAULT_PEER_ABORT_THRESHOLD;
  const carryoverThreshold = typeof opts.carryoverThreshold === 'number'
    ? opts.carryoverThreshold
    : DEFAULT_CARRYOVER_THRESHOLD;

  const startedAtMs = nowMs();
  const runId = typeof opts.runId === 'string' && opts.runId.length > 0
    ? opts.runId
    : defaultRunId(opts.branch, startedAtMs);
  const hostClass = readHostClass(opts.hostJsonPath ?? '.orchestrator/host.json');

  const maxHoursMs = maxHours * 3_600_000;
  const abort = opts.abortSignal ?? null;
  const isAborted = () => Boolean(abort && abort.aborted === true);

  // Capture initial verdict for telemetry (before any iteration runs).
  let initialVerdict = null;
  if (typeof opts.resourceEvaluator === 'function') {
    try {
      const v = opts.resourceEvaluator();
      initialVerdict = typeof v?.verdict === 'string' ? v.verdict : null;
    } catch {
      initialVerdict = null;
    }
  }

  /** @type {AutopilotState} */
  const state = {
    schema_version: SCHEMA_VERSION,
    autopilot_run_id: runId,
    started_at: new Date(startedAtMs).toISOString(),
    completed_at: '',
    duration_seconds: 0,
    max_sessions: maxSessions,
    max_hours: maxHours,
    confidence_threshold: confidenceThreshold,
    iterations_completed: 0,
    kill_switch: null,
    kill_switch_detail: null,
    sessions: [],
    host_class: hostClass,
    resource_verdict_at_start: initialVerdict,
    fallback_to_manual: false,
    dry_run: dryRun,
    total_tokens_used: 0,
    // ADR-364 additive fields — forward-compat; callers may omit, defaults are null/0.
    worktree_path: opts.worktreePath ?? null,
    parent_run_id: opts.parentRunId ?? null,
    stall_recovery_count: 0,
  };

  // Dry-run short-circuits: emit a state record without invoking the lifecycle.
  if (dryRun) {
    state.kill_switch_detail = 'dry-run preview — no sessions executed';
    finalizeState(state, nowMs);
    writeAutopilotJsonl(state, jsonlPath);
    return state;
  }

  // Main loop — pre-checks ordered cheapest-first: abort → sessions/hours → resource.
  let cumulativeTokens = 0;
  for (;;) {
    // Check inexpensive pre-conditions first.
    const elapsedMs = nowMs() - startedAtMs;
    let peerCount = null;
    if (typeof opts.peerCounter === 'function') {
      try {
        peerCount = await opts.peerCounter();
      } catch {
        peerCount = null;
      }
    }
    let verdict = initialVerdict;
    if (typeof opts.resourceEvaluator === 'function') {
      try {
        const v = opts.resourceEvaluator();
        verdict = typeof v?.verdict === 'string' ? v.verdict : verdict;
      } catch {
        // keep prior verdict on error
      }
    }

    const preCheck = preIterationKillSwitch({
      iterationsCompleted: state.iterations_completed,
      maxSessions,
      elapsedMs,
      maxHoursMs,
      resourceVerdict: verdict,
      peerCount,
      peerAbortThreshold,
      aborted: isAborted(),
      cumulativeTokensUsed: cumulativeTokens,
      // 0 = off sentinel: kill-switch activates only on explicit opt-in (#355).
      maxTokens: opts.maxTokens ?? 0,
    });
    if (preCheck !== null) {
      state.kill_switch = preCheck.kill;
      state.kill_switch_detail = preCheck.detail;
      break;
    }

    // Mode selection -------------------------------------------------------
    let recommendation = null;
    if (typeof opts.modeSelector === 'function') {
      try {
        recommendation = await opts.modeSelector();
      } catch (err) {
        state.kill_switch = KILL_SWITCHES.LOW_CONFIDENCE_FALLBACK;
        state.kill_switch_detail = `modeSelector threw: ${err?.message ?? String(err)}`;
        break;
      }
    }
    const confidence = typeof recommendation?.confidence === 'number'
      ? recommendation.confidence
      : 0;
    const recommendedMode = typeof recommendation?.mode === 'string'
      ? recommendation.mode
      : null;

    if (recommendedMode === null || confidence < confidenceThreshold) {
      // Iteration 1 sub-threshold → seamless fallback to manual.
      // Iteration 2+ sub-threshold → exit kill-switch (user must re-decide).
      if (state.iterations_completed === 0) {
        state.fallback_to_manual = true;
        state.kill_switch_detail = recommendedMode === null
          ? `iteration 1: no mode recommendation — fallback to manual`
          : `iteration 1: confidence=${confidence} < threshold=${confidenceThreshold} — fallback to manual`;
      } else {
        state.kill_switch = KILL_SWITCHES.LOW_CONFIDENCE_FALLBACK;
        state.kill_switch_detail = `iteration ${state.iterations_completed + 1}: confidence=${confidence} < threshold=${confidenceThreshold}`;
      }
      break;
    }

    // Run one session ------------------------------------------------------
    let sessionResult = null;
    if (typeof opts.sessionRunner === 'function') {
      try {
        sessionResult = await opts.sessionRunner({
          mode: recommendedMode,
          autopilotRunId: runId,
        });
      } catch (err) {
        state.kill_switch = KILL_SWITCHES.FAILED_WAVE;
        state.kill_switch_detail = `sessionRunner threw: ${err?.message ?? String(err)}`;
        break;
      }
    }

    if (sessionResult && typeof sessionResult.session_id === 'string') {
      state.sessions.push(sessionResult.session_id);
    }
    state.iterations_completed += 1;

    // Accumulate output tokens; stays 0 when sessionRunner omits `usage` (forward-compat).
    if (sessionResult && typeof sessionResult.usage === 'object' && sessionResult.usage !== null) {
      const outTokens = Number(
        sessionResult.usage.output_tokens ?? sessionResult.usage.total_tokens
      );
      if (Number.isFinite(outTokens) && outTokens > 0) {
        cumulativeTokens += outTokens;
      }
    }
    state.total_tokens_used = cumulativeTokens;

    // Post-session kill-switches (Phase C-1.b — spiral / failed-wave / carryover-too-high;
    // Phase C-2 / ADR-364 — stall-timeout via sampler).
    const postCheck = postSessionKillSwitch(sessionResult, {
      carryoverThreshold,
      autopilotJsonlPath: opts.autopilotJsonlPath ?? jsonlPath,
      stallTimeoutSeconds: opts.stallTimeoutSeconds ?? 600,
      nowMs: opts.nowMs,
    });
    if (postCheck !== null) {
      if (postCheck.kill === KILL_SWITCHES.STALL_TIMEOUT) {
        state.stall_recovery_count += 1;
      }
      state.kill_switch = postCheck.kill;
      state.kill_switch_detail = postCheck.detail;
      break;
    }

    // User aborted between iterations?
    if (isAborted()) {
      state.kill_switch = KILL_SWITCHES.USER_ABORT;
      state.kill_switch_detail = 'AbortSignal triggered between iterations';
      break;
    }
  }

  finalizeState(state, nowMs);
  writeAutopilotJsonl(state, jsonlPath);
  return state;
}
