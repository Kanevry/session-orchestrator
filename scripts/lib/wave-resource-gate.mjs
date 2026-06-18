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
 * Extract resource measurements either from a test override or by calling
 * the live resource probe. Returns either a measurements object or a sentinel
 * `{ probeFailed: true }` indicating the caller should short-circuit with a
 * "proceed" decision.
 *
 * @param {object} opts - Same opts shape as evaluateWaveResourceGate
 * @returns {Promise<{ramFreeGb: number, ramAvailableGb: number|null, cpuLoadPct: number, concurrentSessions: number} | {probeFailed: true}>}
 */
async function extractMeasurements(opts) {
  const { probeOverride } = opts;

  if (probeOverride !== undefined && probeOverride !== null) {
    return {
      ramFreeGb: probeOverride.ramFreeGb,
      // Tests may supply ramAvailableGb to exercise the macOS path; absent → null.
      ramAvailableGb: probeOverride.ramAvailableGb ?? null,
      cpuLoadPct: probeOverride.cpuLoadPct,
      concurrentSessions: probeOverride.concurrentSessions,
    };
  }

  let snapshot;
  try {
    snapshot = await probe({ skipProcessCounts: false });
  } catch {
    return { probeFailed: true };
  }
  return {
    ramFreeGb: snapshot.ram_free_gb,
    // macOS: free + reclaimable (vm_stat). null on Linux/Windows where
    // os.freemem() is already accurate. (#667)
    ramAvailableGb: snapshot.ram_available_gb ?? null,
    cpuLoadPct: snapshot.cpu_load_pct,
    // concurrent sessions: number of claude processes found by the probe.
    concurrentSessions: snapshot.claude_processes_count ?? 0,
  };
}

/**
 * Apply the gate decision rule sequence (rules 3-8) given measurements and
 * config. Returns the full gate result.
 *
 * @param {{ramFreeGb: number, cpuLoadPct: number, concurrentSessions: number}} measurements
 * @param {object} opts - Same opts shape as evaluateWaveResourceGate
 * @returns {{decision: string, agents: number, reasons: string[], measurements: object}}
 */
function applyDecisionRules(measurements, opts) {
  const { config, plannedAgents } = opts;
  const { ramFreeGb, ramAvailableGb, cpuLoadPct, concurrentSessions } = measurements;
  const T = config['resource-thresholds'];

  // macOS fix (#667): os.freemem() reports only `Pages free`, which reads
  // sub-1 GB even on a 128 GB host with 80+ GB reclaimable cache — a false
  // RAM-critical that forced spurious coordinator-direct fallbacks. When the
  // probe supplied a numeric `ramAvailableGb` (free + reclaimable, via vm_stat),
  // judge RAM thresholds on AVAILABLE; otherwise fall back to FREE (Linux/Win,
  // where os.freemem() is already accurate).
  const hasAvailable = ramAvailableGb !== null && ramAvailableGb !== undefined;
  const effectiveRamGb = hasAvailable ? ramAvailableGb : ramFreeGb;
  const ramLabel = hasAvailable ? 'RAM available' : 'RAM free';

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
  if (effectiveRamGb < T['ram-free-critical-gb']) {
    return {
      decision: 'coordinator-direct',
      agents: 0,
      reasons: [
        `${ramLabel} ${effectiveRamGb}GB < critical ${T['ram-free-critical-gb']}GB — escalating to coordinator-direct`,
      ],
      measurements,
    };
  }

  // Rule 5: RAM below min (but above critical) → reduce.
  if (effectiveRamGb < T['ram-free-min-gb']) {
    return {
      decision: 'reduce',
      agents: Math.max(1, Math.floor(plannedAgents / 2)),
      reasons: [
        `${ramLabel} ${effectiveRamGb}GB < min ${T['ram-free-min-gb']}GB — reducing agent count`,
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
  const { config, plannedAgents } = opts;

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
  const measured = await extractMeasurements(opts);
  if ('probeFailed' in measured) {
    return {
      decision: 'proceed',
      agents: plannedAgents,
      reasons: ['probe failed (ignored)'],
      measurements: {},
    };
  }

  // Rules 3-8: apply decision rule sequence.
  return applyDecisionRules(measured, opts);
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
  // Prefer the macOS available-RAM figure in the banner when present (#667):
  // "RAM free" alone is misleading on Darwin (Pages-free underreports).
  const hasAvailable = m.ramAvailableGb !== null && m.ramAvailableGb !== undefined;
  const ramStr = hasAvailable
    ? `RAM ${m.ramAvailableGb}GB avail`
    : `RAM ${m.ramFreeGb ?? '?'}GB free`;
  const measStr =
    Object.keys(m).length > 0
      ? ` (${ramStr}, CPU ${m.cpuLoadPct ?? '?'}%, sessions ${m.concurrentSessions ?? '?'})`
      : '';
  lines.push(`Decision: ${decision} — agents: ${agents}${measStr}`);
  return lines.join('\n');
}
