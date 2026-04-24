/**
 * wave-resource-gate.mjs — Pre-dispatch resource gate for parallel agent waves.
 *
 * Evaluates RAM / CPU / concurrent-session pressure before dispatching agents
 * and returns a decision: "proceed", "reduce", or "coordinator-direct".
 *
 * Part of v3.1.0 Epic #157, Sub-Epic resource-gate. Issue #193.
 */

import { probe } from './resource-probe.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the wave can be dispatched at the planned agent count.
 * @param {object} opts
 * @param {object} opts.config - Parsed Session Config (from parse-config.sh output)
 * @param {number} opts.plannedAgents - Number of agents the session-plan wants to dispatch
 * @param {string} opts.waveRole - e.g. "Impl-Core", "Quality"
 * @param {object} [opts.probeOverride] - {ramFreeGb, cpuLoadPct, concurrentSessions} for
 *   testing; when omitted, calls resource-probe
 * @returns {Promise<{decision: "proceed"|"reduce"|"coordinator-direct", agents: number, reasons: string[], measurements: object}>}
 */
export async function evaluateWaveResourceGate(opts) {
  const { config, plannedAgents, probeOverride } = opts;

  // Rule 1: resource-awareness disabled — skip all probing.
  if (config['resource-awareness'] === false) {
    return {
      decision: 'proceed',
      agents: plannedAgents,
      reasons: ['resource-awareness disabled in Session Config'],
      measurements: {},
    };
  }

  // Rule 2: probe the system (or use override for tests).
  let ramFreeGb;
  let cpuLoadPct;
  let concurrentSessions;

  if (probeOverride !== undefined && probeOverride !== null) {
    ramFreeGb = probeOverride.ramFreeGb;
    cpuLoadPct = probeOverride.cpuLoadPct;
    concurrentSessions = probeOverride.concurrentSessions;
  } else {
    let snapshot;
    try {
      snapshot = await probe({ skipProcessCounts: false });
    } catch {
      return {
        decision: 'proceed',
        agents: plannedAgents,
        reasons: ['probe failed (ignored)'],
        measurements: {},
      };
    }
    ramFreeGb = snapshot.ram_free_gb;
    cpuLoadPct = snapshot.cpu_load_pct;
    // concurrent sessions: number of claude processes found by the probe.
    concurrentSessions = snapshot.claude_processes_count ?? 0;
  }

  const measurements = { ramFreeGb, cpuLoadPct, concurrentSessions };
  const T = config['resource-thresholds'];

  // Rule 3: resource-thresholds missing → degrade to proceed (defensive).
  // Handles legacy pre-#166 configs and test fixtures that omit the key.
  // The gate is considered "ran" — caller receives measurements but no enforcement.
  if (!T || typeof T !== 'object') {
    return {
      decision: 'proceed',
      agents: plannedAgents,
      reasons: ['resource-thresholds missing from config — gate skipped'],
      measurements,
    };
  }

  // Rule 4: RAM below critical → coordinator-direct.
  if (ramFreeGb < T['ram-free-critical-gb']) {
    return {
      decision: 'coordinator-direct',
      agents: 0,
      reasons: [
        `RAM free ${ramFreeGb}GB < critical ${T['ram-free-critical-gb']}GB — escalating to coordinator-direct`,
      ],
      measurements,
    };
  }

  // Rule 5: RAM below min (but above critical) → reduce.
  if (ramFreeGb < T['ram-free-min-gb']) {
    return {
      decision: 'reduce',
      agents: Math.max(1, Math.floor(plannedAgents / 2)),
      reasons: [
        `RAM free ${ramFreeGb}GB < min ${T['ram-free-min-gb']}GB — reducing agent count`,
      ],
      measurements,
    };
  }

  // Rule 6: CPU overloaded → reduce.
  if (cpuLoadPct > T['cpu-load-max-pct']) {
    return {
      decision: 'reduce',
      agents: Math.max(1, Math.floor(plannedAgents / 2)),
      reasons: [
        `CPU load ${cpuLoadPct}% > max ${T['cpu-load-max-pct']}% — reducing agent count`,
      ],
      measurements,
    };
  }

  // Rule 7: concurrent sessions above warn → proceed with warning.
  if (concurrentSessions > T['concurrent-sessions-warn']) {
    return {
      decision: 'proceed',
      agents: plannedAgents,
      reasons: [`warn: ${concurrentSessions} concurrent sessions`],
      measurements,
    };
  }

  // Rule 8: all within bounds.
  return {
    decision: 'proceed',
    agents: plannedAgents,
    reasons: ['all thresholds within bounds'],
    measurements,
  };
}

/**
 * Format a gate result into a short multi-line coordinator progress string.
 * @param {{decision: string, agents: number, reasons: string[], measurements: object}} result
 * @returns {string}
 */
export function formatGateReport(result) {
  const { decision, agents, reasons, measurements } = result;
  const lines = reasons.map((r) => `  - ${r}`);
  const m = measurements;
  const measStr =
    Object.keys(m).length > 0
      ? ` (RAM ${m.ramFreeGb ?? '?'}GB free, CPU ${m.cpuLoadPct ?? '?'}%, sessions ${m.concurrentSessions ?? '?'})`
      : '';
  lines.push(`Decision: ${decision} — agents: ${agents}${measStr}`);
  return lines.join('\n');
}
