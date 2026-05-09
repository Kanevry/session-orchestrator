/**
 * autopilot/kill-switches.mjs — Kill-switch constants and evaluators.
 *
 * Extracted from autopilot.mjs (issue #358) to keep the parent module below
 * 500 LOC. Public API: KILL_SWITCHES (re-exported from autopilot.mjs for
 * backward-compat). Internal functions preIterationKillSwitch and
 * postSessionKillSwitch are consumed by runLoop in autopilot.mjs.
 *
 * No circular imports: this module does NOT import from autopilot.mjs.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KILL_SWITCHES = Object.freeze({
  // Pre-iteration kill-switches (Phase C-1, #295)
  MAX_SESSIONS_REACHED: 'max-sessions-reached',
  MAX_HOURS_EXCEEDED: 'max-hours-exceeded',
  RESOURCE_OVERLOAD: 'resource-overload',
  LOW_CONFIDENCE_FALLBACK: 'low-confidence-fallback',
  USER_ABORT: 'user-abort',
  TOKEN_BUDGET_EXCEEDED: 'token-budget-exceeded',
  // Post-session kill-switches (Phase C-1.b, #300)
  SPIRAL: 'spiral',
  FAILED_WAVE: 'failed-wave',
  CARRYOVER_TOO_HIGH: 'carryover-too-high',
});

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
 * @param {number} args.cumulativeTokensUsed
 * @param {number} args.maxTokens
 */
export function preIterationKillSwitch(args) {
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
    Number.isFinite(args.maxTokens) &&
    args.maxTokens > 0 &&
    Number.isFinite(args.cumulativeTokensUsed) &&
    args.cumulativeTokensUsed >= args.maxTokens
  ) {
    return {
      kill: KILL_SWITCHES.TOKEN_BUDGET_EXCEEDED,
      detail: `cumulative_tokens=${args.cumulativeTokensUsed} >= max-tokens=${args.maxTokens}`,
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
 * Post-session kill-switch checks. Pure: reads only fields on `sessionResult`
 * (see the `sessionRunner` return-shape contract in autopilot.mjs file header)
 * and the configured `carryoverThreshold`. Returns `{kill, detail}` to fire a
 * kill or `null` when the loop may proceed.
 *
 * Field semantics:
 *   - `spiral`             ← `agent_summary.spiral > 0`         (count of spiraled agents)
 *   - `failed-wave`        ← `agent_summary.failed > 0`         (count of failed agents)
 *   - `carryover-too-high` ← `effectiveness.planned_issues > 0`
 *                            AND `effectiveness.carryover / effectiveness.planned_issues > carryoverThreshold`
 *
 * Absent fields are treated as "no signal" — the loop continues.
 *
 * @param {object | null | undefined} sessionResult
 * @param {{carryoverThreshold: number}} args
 * @returns {{kill: string, detail: string} | null}
 */
export function postSessionKillSwitch(sessionResult, { carryoverThreshold }) {
  if (!sessionResult || typeof sessionResult !== 'object') return null;

  const agentSummary = sessionResult.agent_summary;
  if (agentSummary && typeof agentSummary === 'object') {
    const spiralCount = Number(agentSummary.spiral);
    if (Number.isFinite(spiralCount) && spiralCount > 0) {
      return {
        kill: KILL_SWITCHES.SPIRAL,
        detail: `agent_summary.spiral=${spiralCount} > 0`,
      };
    }
    const failedCount = Number(agentSummary.failed);
    if (Number.isFinite(failedCount) && failedCount > 0) {
      return {
        kill: KILL_SWITCHES.FAILED_WAVE,
        detail: `agent_summary.failed=${failedCount} > 0`,
      };
    }
  }

  const effectiveness = sessionResult.effectiveness;
  if (effectiveness && typeof effectiveness === 'object') {
    const planned = Number(effectiveness.planned_issues);
    const carryover = Number(effectiveness.carryover);
    if (Number.isFinite(planned) && planned > 0 && Number.isFinite(carryover)) {
      const ratio = carryover / planned;
      if (ratio > carryoverThreshold) {
        const ratioPct = Math.round(ratio * 100) / 100;
        return {
          kill: KILL_SWITCHES.CARRYOVER_TOO_HIGH,
          detail: `carryover/planned=${ratioPct} > threshold=${carryoverThreshold} (carryover=${carryover}, planned=${planned})`,
        };
      }
    }
  }

  return null;
}
