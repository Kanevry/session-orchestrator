// scripts/lib/autopilot/multi-killswitch.mjs
//
// 11th kill-switch (STALE_SUBAGENT_MIN) + cohort policy + concurrency cap for
// autopilot --multi-story. Pure decision logic; no I/O, no shell.
//
// References:
//   - docs/prd/2026-05-07-autopilot-phase-d.md (OPEN-2, OPEN-3, OPEN-5 decisions)
//   - scripts/lib/autopilot/kill-switches.mjs (existing 10 switches; STALL_TIMEOUT precedent)
//   - scripts/lib/resource-probe.mjs (snapshot shape)

import { KILL_SWITCHES } from './kill-switches.mjs';

// 11th kill-switch constant — additive to the existing 10 in KILL_SWITCHES
/** @type {string} */
export const STALE_SUBAGENT_MIN = 'stale-subagent-min';

/**
 * Calculate concurrency cap per OPEN-2 decision from PRD §4.
 * Formula: min(staticFloor, max(1, floor(ram_free_gb / ramPerLoopGb) - reserveSlots))
 *
 * Defensive: null/undefined ram_free_gb → 1; memory_pressure_pct_free < 15 → cap 1.
 *
 * @param {{ ram_free_gb: number, memory_pressure_pct_free?: number, claude_processes_count?: number }} snapshot
 * @param {object} [opts]
 * @param {number} [opts.staticFloor=3]    - hard cap regardless of resources
 * @param {number} [opts.ramPerLoopGb=4]   - per-looper RAM budget
 * @param {number} [opts.reserveSlots=1]   - sessions to reserve for system + coordinator
 * @returns {number} integer in [1, staticFloor]
 */
export function calculateConcurrencyCap(snapshot, opts = {}) {
  const staticFloor = opts.staticFloor ?? 3;
  const ramPerLoopGb = opts.ramPerLoopGb ?? 4;
  const reserveSlots = opts.reserveSlots ?? 1;

  // macOS memory pressure degraded guard
  if (
    typeof snapshot?.memory_pressure_pct_free === 'number' &&
    snapshot.memory_pressure_pct_free < 15
  ) {
    return 1;
  }

  const ramFreeGb = snapshot?.ram_free_gb;
  if (ramFreeGb === null || ramFreeGb === undefined || typeof ramFreeGb !== 'number' || !Number.isFinite(ramFreeGb)) {
    return 1;
  }

  const computed = Math.floor(ramFreeGb / ramPerLoopGb) - reserveSlots;
  return Math.min(staticFloor, Math.max(1, computed));
}

/**
 * @typedef {object} LoopRegistration
 * @property {string} loopId
 * @property {number} pid
 * @property {string} parentRunId
 * @property {number} issueIid
 * @property {'queued'|'running'|'complete'|'failed'} status
 * @property {string|null} killSwitch
 * @property {number} spiralRecoveryCount
 * @property {number} startedAt       - epoch ms
 * @property {number} lastActivityAt  - epoch ms
 */

/**
 * Evaluate cross-loop kill-switches (STALE_SUBAGENT_MIN only — per-loop
 * switches like SPIRAL are handled by postSessionKillSwitch upstream).
 * Returns the FIRST kill condition that fires, or null.
 *
 * @param {LoopRegistration[]} loops
 * @param {object} [opts]
 * @param {number} [opts.staleSubagentMinSeconds=600]
 * @param {() => number} [opts.nowMs=Date.now]
 * @returns {{ kill: string, detail: string, loopId?: string }|null}
 */
export function evaluateMultiKillSwitches(loops, opts = {}) {
  if (!Array.isArray(loops) || loops.length === 0) return null;

  const staleThresholdSeconds = opts.staleSubagentMinSeconds ?? 600;
  const now = (opts.nowMs ?? Date.now)();

  for (const loop of loops) {
    if (!loop || loop.status !== 'running') continue;

    const lastActivity = loop.lastActivityAt;
    if (typeof lastActivity !== 'number' || !Number.isFinite(lastActivity)) continue;

    const idleMs = now - lastActivity;
    const idleSeconds = Math.floor(idleMs / 1000);

    if (idleMs > staleThresholdSeconds * 1000) {
      return {
        kill: STALE_SUBAGENT_MIN,
        detail: `loop ${loop.loopId} stale > ${idleSeconds}s (threshold ${staleThresholdSeconds}s)`,
        loopId: loop.loopId,
      };
    }
  }

  return null;
}

/**
 * Decide whether a sibling loop's failure should abort the cohort.
 * Per OPEN-5 hybrid policy:
 *   - First SPIRAL AND target loop spiralRecoveryCount < 1 → retry
 *   - Second SPIRAL OR target already retried → cohort-abort
 *
 * @param {LoopRegistration[]} loops
 * @param {string} failedLoopId
 * @returns {{ action: 'retry'|'cohort-abort', reason: string }}
 */
export function decideCohortAction(loops, failedLoopId) {
  if (!Array.isArray(loops)) {
    return { action: 'cohort-abort', reason: 'no loop registry provided' };
  }

  const spiralCount = loops.filter(
    (l) => l && l.killSwitch === KILL_SWITCHES.SPIRAL,
  ).length;

  const targetLoop = loops.find((l) => l && l.loopId === failedLoopId);
  const targetSpiralRecoveries = targetLoop?.spiralRecoveryCount ?? 0;

  if (spiralCount <= 1 && targetSpiralRecoveries < 1) {
    return {
      action: 'retry',
      reason: 'first-strike spiral, recovering loop ' + failedLoopId,
    };
  }

  return {
    action: 'cohort-abort',
    reason: 'second-strike spiral or cohort threshold',
  };
}

/**
 * Check if the orchestrator stop condition is met (OPEN-3 layered policy).
 * Priority: (1) cohort-abort → (2) backlog-empty → (3) inactivity-timeout
 *
 * @param {object} state
 * @param {LoopRegistration[]} state.activeLoops
 * @param {object[]} state.readyBacklog
 * @param {number} state.lastCompletionAt
 * @param {object} [opts]
 * @param {number} [opts.inactivityTimeoutMs=300000]
 * @param {() => number} [opts.nowMs=Date.now]
 * @returns {{ stop: boolean, reason?: 'first-kill-switch'|'backlog-empty'|'inactivity-timeout' }}
 */
export function shouldStopOrchestrator(state, opts = {}) {
  const inactivityTimeoutMs = opts.inactivityTimeoutMs ?? 300_000;
  const now = (opts.nowMs ?? Date.now)();

  const activeLoops = Array.isArray(state?.activeLoops) ? state.activeLoops : [];
  const readyBacklog = Array.isArray(state?.readyBacklog) ? state.readyBacklog : [];

  // Priority 1: cohort-abort triggered by spiral on an active loop
  for (const loop of activeLoops) {
    if (!loop || loop.killSwitch !== KILL_SWITCHES.SPIRAL) continue;

    const decision = decideCohortAction(activeLoops, loop.loopId);
    if (decision.action === 'cohort-abort') {
      return { stop: true, reason: 'first-kill-switch' };
    }
  }

  // Priority 2: all work drained
  if (activeLoops.length === 0 && readyBacklog.length === 0) {
    return { stop: true, reason: 'backlog-empty' };
  }

  // Priority 3: orchestrator inactivity timeout (only meaningful while loops are running)
  if (
    activeLoops.length > 0 &&
    typeof state?.lastCompletionAt === 'number' &&
    Number.isFinite(state.lastCompletionAt) &&
    now - state.lastCompletionAt > inactivityTimeoutMs
  ) {
    return { stop: true, reason: 'inactivity-timeout' };
  }

  return { stop: false };
}
