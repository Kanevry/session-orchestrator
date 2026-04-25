/**
 * autopilot.mjs — Phase C-1 runtime for /autopilot loop command.
 *
 * Issue #295 (Epic #271 v3.2 Autopilot, Phase C). Ships:
 *   - parseFlags(argv): silent-clamp flag parsing
 *   - runLoop(opts):    iterate session lifecycle until a kill-switch fires
 *   - writeAutopilotJsonl(state, path): atomic tmp+rename writer
 *   - KILL_SWITCHES, FLAG_BOUNDS, SCHEMA_VERSION constants
 *
 * 5 kill-switches enforced in this phase:
 *   max-sessions-reached, max-hours-exceeded, low-confidence-fallback,
 *   user-abort, resource-overload.
 *
 * Deferred to Phase C-1.b (require wave-executor signal extraction):
 *   spiral, failed-wave, carryover-too-high. Stubs in `_postSessionKillSwitch`.
 *
 * Pure orchestration: all I/O (session lifecycle, mode selection, resource
 * probing, peer count, wall clock) is injected via opts so the loop is unit-
 * testable without spawning child processes.
 *
 * Reference contract: docs/prd/2026-04-25-autopilot-loop.md
 *                     skills/autopilot/SKILL.md
 */

import { writeFileSync, renameSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

export const KILL_SWITCHES = Object.freeze({
  // Shipped Phase C-1
  MAX_SESSIONS_REACHED: 'max-sessions-reached',
  MAX_HOURS_EXCEEDED: 'max-hours-exceeded',
  RESOURCE_OVERLOAD: 'resource-overload',
  LOW_CONFIDENCE_FALLBACK: 'low-confidence-fallback',
  USER_ABORT: 'user-abort',
  // Deferred Phase C-1.b
  SPIRAL: 'spiral',
  FAILED_WAVE: 'failed-wave',
  CARRYOVER_TOO_HIGH: 'carryover-too-high',
});

export const FLAG_BOUNDS = Object.freeze({
  maxSessions: { min: 1, max: 50, default: 5 },
  maxHours: { min: 0.5, max: 24.0, default: 4.0 },
  confidenceThreshold: { min: 0.0, max: 1.0, default: 0.85 },
});

/** Default peer Claude-process count above which `resource-overload` fires when verdict is critical. */
export const DEFAULT_PEER_ABORT_THRESHOLD = 6;

/** Default JSONL path for autopilot loop records. */
export const DEFAULT_JSONL_PATH = '.orchestrator/metrics/autopilot.jsonl';

/** Default carryover ratio threshold (deferred kill-switch, kept here for symmetry). */
export const DEFAULT_CARRYOVER_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function clampNumber(value, { min, max, fallback }) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseNumeric(raw) {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `/autopilot` argv into an opts object. Out-of-range numeric flags clamp
 * silently to bounds. Unknown flags are ignored. `--dry-run` is a boolean flag.
 *
 * @param {string[]} argv — argument tokens (e.g. ['--max-sessions=3', '--dry-run'])
 * @returns {{maxSessions: number, maxHours: number, confidenceThreshold: number, dryRun: boolean}}
 */
export function parseFlags(argv) {
  const tokens = Array.isArray(argv) ? argv : [];

  let rawSessions = null;
  let rawHours = null;
  let rawConfidence = null;
  let dryRun = false;

  for (const tok of tokens) {
    if (typeof tok !== 'string') continue;
    if (tok === '--dry-run' || tok === '--dryRun') {
      dryRun = true;
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq === -1) continue;
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1);
    if (key === '--max-sessions') rawSessions = parseNumeric(val);
    else if (key === '--max-hours') rawHours = parseNumeric(val);
    else if (key === '--confidence-threshold') rawConfidence = parseNumeric(val);
  }

  return {
    maxSessions: Math.floor(clampNumber(rawSessions, {
      min: FLAG_BOUNDS.maxSessions.min,
      max: FLAG_BOUNDS.maxSessions.max,
      fallback: FLAG_BOUNDS.maxSessions.default,
    })),
    maxHours: clampNumber(rawHours, {
      min: FLAG_BOUNDS.maxHours.min,
      max: FLAG_BOUNDS.maxHours.max,
      fallback: FLAG_BOUNDS.maxHours.default,
    }),
    confidenceThreshold: clampNumber(rawConfidence, {
      min: FLAG_BOUNDS.confidenceThreshold.min,
      max: FLAG_BOUNDS.confidenceThreshold.max,
      fallback: FLAG_BOUNDS.confidenceThreshold.default,
    }),
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// JSONL writer (atomic tmp + rename)
// ---------------------------------------------------------------------------

/**
 * Append-once writer for `autopilot.jsonl`. Writes ONE record per /autopilot
 * invocation atomically: stage to a tmpfile in the same directory, then
 * rename. Existing file contents are preserved (read → append → atomic
 * rewrite). Crash-safe: a partial tmpfile is never visible at the destination.
 *
 * @param {object} state — fully-formed autopilot state record
 * @param {string} jsonlPath — destination JSONL path
 */
export function writeAutopilotJsonl(state, jsonlPath) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('writeAutopilotJsonl: state must be an object');
  }
  if (typeof jsonlPath !== 'string' || jsonlPath.length === 0) {
    throw new TypeError('writeAutopilotJsonl: jsonlPath must be a non-empty string');
  }

  const dir = path.dirname(jsonlPath);
  mkdirSync(dir, { recursive: true });

  let existing = '';
  try {
    existing = readFileSync(jsonlPath, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.length > 0 && !existing.endsWith('\n')) existing += '\n';

  const line = JSON.stringify(state) + '\n';
  const tmp = `${jsonlPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, existing + line, 'utf8');
  renameSync(tmp, jsonlPath);
}

// ---------------------------------------------------------------------------
// Run-id + host class helpers
// ---------------------------------------------------------------------------

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function defaultRunId(branch, nowMs) {
  const d = new Date(nowMs);
  const ymd = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const hhmm = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  const safeBranch = (branch ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${safeBranch}-${ymd}-${hhmm}-autopilot`;
}

function readHostClass(hostJsonPath) {
  try {
    const obj = JSON.parse(readFileSync(hostJsonPath, 'utf8'));
    return typeof obj?.host_class === 'string' ? obj.host_class : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kill-switch evaluation (pure functions)
// ---------------------------------------------------------------------------

/**
 * Pre-iteration kill-switch checks. Pure: all inputs are state values, no I/O.
 * Returns `{kill, detail}` or `null` when the loop may proceed.
 *
 * @param {object} args
 * @param {number} args.iterationsCompleted
 * @param {number} args.maxSessions
 * @param {number} args.elapsedMs
 * @param {number} args.maxHoursMs
 * @param {string|null} args.resourceVerdict — 'green' | 'warn' | 'critical' | null
 * @param {number|null} args.peerCount
 * @param {number} args.peerAbortThreshold
 * @param {boolean} args.aborted
 */
function preIterationKillSwitch(args) {
  if (args.aborted) {
    return { kill: KILL_SWITCHES.USER_ABORT, detail: 'AbortSignal triggered before iteration' };
  }
  if (args.iterationsCompleted >= args.maxSessions) {
    return {
      kill: KILL_SWITCHES.MAX_SESSIONS_REACHED,
      detail: `iterations_completed=${args.iterationsCompleted} >= max-sessions=${args.maxSessions}`,
    };
  }
  if (args.elapsedMs >= args.maxHoursMs) {
    const elapsedH = Math.round((args.elapsedMs / 3_600_000) * 100) / 100;
    const maxH = Math.round((args.maxHoursMs / 3_600_000) * 100) / 100;
    return {
      kill: KILL_SWITCHES.MAX_HOURS_EXCEEDED,
      detail: `elapsed=${elapsedH}h >= max-hours=${maxH}h`,
    };
  }
  if (
    args.resourceVerdict === 'critical' &&
    typeof args.peerCount === 'number' &&
    args.peerCount > args.peerAbortThreshold
  ) {
    return {
      kill: KILL_SWITCHES.RESOURCE_OVERLOAD,
      detail: `verdict=critical peers=${args.peerCount} > threshold=${args.peerAbortThreshold}`,
    };
  }
  return null;
}

/**
 * Post-session kill-switch stubs for Phase C-1.b. Currently a no-op — returns
 * `null` always. Wired here so the loop structure is in place; signal
 * extraction (spiral_detected / failed_waves / carryover_ratio) ships in the
 * follow-up sub-issue once wave-executor exposes those fields on its return
 * shape.
 *
 * @param {object} _sessionResult
 * @returns {{kill: string, detail: string} | null}
 */
function postSessionKillSwitch(_sessionResult) {
  return null;
}

// ---------------------------------------------------------------------------
// runLoop — main controller
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AutopilotState
 * @property {number} schema_version
 * @property {string} autopilot_run_id
 * @property {string} started_at
 * @property {string} completed_at
 * @property {number} duration_seconds
 * @property {number} max_sessions
 * @property {number} max_hours
 * @property {number} confidence_threshold
 * @property {number} iterations_completed
 * @property {string|null} kill_switch
 * @property {string|null} kill_switch_detail
 * @property {string[]} sessions
 * @property {string|null} host_class
 * @property {string|null} resource_verdict_at_start
 * @property {boolean} fallback_to_manual
 * @property {boolean} dry_run
 */

/**
 * Run the autopilot loop. All I/O is injected — pass real implementations from
 * `commands/autopilot.md` invocation, mocks from tests.
 *
 * @param {object} opts
 * @param {number} [opts.maxSessions]
 * @param {number} [opts.maxHours]
 * @param {number} [opts.confidenceThreshold]
 * @param {boolean} [opts.dryRun]
 * @param {() => Promise<{mode: string, confidence: number, rationale?: string}>} [opts.modeSelector]
 *   — invoked before each iteration to obtain a mode + confidence.
 * @param {(args: {mode: string, autopilotRunId: string}) => Promise<{session_id: string}>} [opts.sessionRunner]
 *   — invoked when confidence clears the threshold; returns the completed session record.
 * @param {() => {verdict: string}} [opts.resourceEvaluator]
 *   — invoked before each iteration to obtain the resource verdict.
 * @param {() => Promise<number>} [opts.peerCounter]
 *   — invoked before each iteration to obtain peer process count.
 * @param {() => number} [opts.nowMs] — wall-clock supplier (default Date.now).
 * @param {AbortSignal} [opts.abortSignal] — user-abort hook (Ctrl+C / Esc).
 * @param {string} [opts.jsonlPath] — destination JSONL path.
 * @param {string} [opts.runId] — explicit autopilot_run_id override.
 * @param {string} [opts.branch] — branch name for default runId construction.
 * @param {string} [opts.hostJsonPath] — `.orchestrator/host.json` location.
 * @param {number} [opts.peerAbortThreshold] — overrides DEFAULT_PEER_ABORT_THRESHOLD.
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
  };

  // Dry-run short-circuits: emit a state record without invoking the lifecycle.
  if (dryRun) {
    state.kill_switch_detail = 'dry-run preview — no sessions executed';
    finalizeState(state, nowMs);
    writeAutopilotJsonl(state, jsonlPath);
    return state;
  }

  // Main loop ----------------------------------------------------------------
  // We re-run pre-iteration checks at the top of every iteration; the order
  // is deliberate: user-abort first (cheapest), then sessions/hours, then
  // resource-overload (requires peerCount probe).
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

    // Post-session kill-switch (Phase C-1.b stub — currently always null).
    const postCheck = postSessionKillSwitch(sessionResult);
    if (postCheck !== null) {
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

function finalizeState(state, nowMs) {
  const completedMs = nowMs();
  const startedMs = Date.parse(state.started_at);
  state.completed_at = new Date(completedMs).toISOString();
  state.duration_seconds = Number.isFinite(startedMs)
    ? Math.max(0, Math.round((completedMs - startedMs) / 1000))
    : 0;
}
