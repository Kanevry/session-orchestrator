/**
 * autopilot.mjs — Phase C-1 runtime for /autopilot loop command.
 *
 * Issue #295 (Phase C-1) + #300 (Phase C-1.b). Ships:
 *   - parseFlags(argv): silent-clamp flag parsing
 *   - runLoop(opts):    iterate session lifecycle until a kill-switch fires
 *   - writeAutopilotJsonl(state, path): atomic tmp+rename writer
 *   - KILL_SWITCHES, FLAG_BOUNDS, SCHEMA_VERSION constants
 *
 * 9 of 9 kill-switches enforced (6 pre-iteration + 3 post-session):
 *   max-sessions-reached, max-hours-exceeded, resource-overload,
 *   low-confidence-fallback, user-abort, token-budget-exceeded,
 *   spiral, failed-wave, carryover-too-high.
 *
 * Pure orchestration: all I/O (session lifecycle, mode selection, resource
 * probing, peer count, wall clock) is injected via opts so the loop is unit-
 * testable without spawning child processes.
 *
 * `sessionRunner` return-shape contract (consumed by `postSessionKillSwitch`):
 *   {
 *     session_id: string,                       // required (already used by Phase C-1)
 *     agent_summary?: {                         // optional; absent fields → no kill
 *       spiral?: number,                        // count of spiraled agents in the session
 *       failed?: number,                        // count of failed agents in the session
 *       ...                                     // schema-canonical session-record fields
 *     },
 *     effectiveness?: {                         // optional; carryover-too-high only fires
 *       planned_issues?: number,                //   when planned_issues > 0
 *       carryover?: number,
 *       ...
 *     },
 *     usage?: {                                 // optional; absence → token accumulator stays 0
 *       output_tokens?: number,                 // #355 token-budget-exceeded kill-switch
 *       total_tokens?: number,                  // accepted as fallback when output_tokens absent
 *     }
 *   }
 *
 * Production callers MUST also persist `autopilot_run_id` (passed in via
 * `args.autopilotRunId`) into the corresponding `sessions.jsonl` record so
 * sessions launched by autopilot can be correlated back to the originating
 * loop. The field is additive (schema_version 1 compatible); manual sessions
 * write `null` or omit it. See `skills/wave-executor/SKILL.md § Return Shape
 * Contract` and `skills/session-end/SKILL.md § Phase 3.7`.
 *
 * Reference contract: docs/prd/2026-04-25-autopilot-loop.md
 *                     skills/autopilot/SKILL.md
 */

// Telemetry helpers extracted to autopilot-telemetry.mjs (issue #326).
import { writeAutopilotJsonl, defaultRunId, readHostClass, finalizeState } from './autopilot-telemetry.mjs';

// Kill-switch constants and evaluators extracted to submodule (issue #358).
import { KILL_SWITCHES, preIterationKillSwitch, postSessionKillSwitch } from './autopilot/kill-switches.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

// Re-export KILL_SWITCHES so existing callers importing from autopilot.mjs continue to resolve.
export { KILL_SWITCHES };

export const FLAG_BOUNDS = Object.freeze({
  maxSessions: { min: 1, max: 50, default: 5 },
  maxHours: { min: 0.5, max: 24.0, default: 4.0 },
  confidenceThreshold: { min: 0.0, max: 1.0, default: 0.85 },
  maxTokens: { min: 0, max: 10_000_000, default: 500_000 },
});

/** Default peer Claude-process count above which `resource-overload` fires when verdict is critical. */
export const DEFAULT_PEER_ABORT_THRESHOLD = 6;

/** Default JSONL path for autopilot loop records. */
export const DEFAULT_JSONL_PATH = '.orchestrator/metrics/autopilot.jsonl';

/** Default carryover ratio threshold above which `carryover-too-high` fires post-session. */
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
 * @property {number} total_tokens_used
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
 * @param {number} [opts.carryoverThreshold] — overrides DEFAULT_CARRYOVER_THRESHOLD; ratio above which
 *   `carryover-too-high` fires post-session.
 * @param {number} [opts.maxTokens] - cumulative output token cap; loop halts when reached
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
      // Default to 0 (off) when caller omits — kill-switch only activates on
      // explicit opt-in via `opts.maxTokens` (or future --max-tokens CLI flag).
      // FLAG_BOUNDS.maxTokens.default (500_000) documents the recommended cap
      // when the caller chooses to enable, but does NOT auto-activate the
      // switch. The check at kill-switches.mjs guards on `> 0`, so 0 is a
      // safe "off" sentinel. Q4 finding (#355).
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

    // Accumulate output tokens for TOKEN_BUDGET_EXCEEDED kill-switch (#355).
    // Forward-compat: when sessionRunner doesn't emit `usage`, accumulator stays at 0.
    if (sessionResult && typeof sessionResult.usage === 'object' && sessionResult.usage !== null) {
      const outTokens = Number(
        sessionResult.usage.output_tokens ?? sessionResult.usage.total_tokens
      );
      if (Number.isFinite(outTokens) && outTokens > 0) {
        cumulativeTokens += outTokens;
      }
    }
    state.total_tokens_used = cumulativeTokens;

    // Post-session kill-switches (Phase C-1.b — spiral / failed-wave / carryover-too-high).
    const postCheck = postSessionKillSwitch(sessionResult, { carryoverThreshold });
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

// Re-export telemetry symbols so existing callers that import from autopilot.mjs
// continue to resolve without modification (issue #326 backward-compat barrel).
export { writeAutopilotJsonl, defaultRunId, readHostClass, finalizeState };
