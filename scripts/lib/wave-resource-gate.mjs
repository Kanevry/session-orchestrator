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
 * config, then apply the HR-004 heavy-repo preflight ceiling on top. Returns
 * the full gate result.
 *
 * @param {{ramFreeGb: number, cpuLoadPct: number, concurrentSessions: number}} measurements
 * @param {object} opts - Same opts shape as evaluateWaveResourceGate
 * @returns {{decision: string, agents: number, reasons: string[], measurements: object}}
 */
function applyDecisionRules(measurements, opts) {
  const result = computeResourceDecision(measurements, opts);
  return applyHeavyRepoCap(result, opts);
}

/**
 * Resolve an `agents-per-wave` config value into a plain numeric cap, or
 * `null` when no cap should apply.
 *
 * `_coerceInteger()` (scripts/lib/config/coercers.mjs) parses the documented
 * HR-003 parenthetical-override syntax — `agents-per-wave: 4 (deep: 18)` —
 * into an OBJECT `{ default: 4, deep: 18 }`, not a plain number. Feeding that
 * object straight into a `typeof cap !== 'number'` guard makes the heavy-repo
 * cap silently no-op for every repo using the override syntax, which defeats
 * HR-004 exactly where it matters most (a heavy repo that also runs deep
 * sessions).
 *
 * `evaluateWaveResourceGate()` has no session-mode input in scope — `waveRole`
 * is a wave role (e.g. "Impl-Core"), not a session mode (e.g. "deep") — so the
 * object shape resolves to `cap.default` here. That is the conservative
 * choice: the documented HR-003 convention writes the override as
 * `<default> (mode: <higher-ceiling>)`, i.e. `default` is the MORE
 * restrictive of the pair. Falling back to it can only under-apply a looser
 * mode-specific ceiling; it never lets a heavy repo exceed its base cap.
 *
 * @param {number|{default: number, [mode: string]: number}|*} cap
 * @returns {number|null}
 */
function resolveApwCap(cap) {
  if (typeof cap === 'number') return Number.isFinite(cap) ? cap : null;
  if (cap !== null && typeof cap === 'object' && !Array.isArray(cap)) {
    const def = cap.default;
    return typeof def === 'number' && Number.isFinite(def) ? def : null;
  }
  return null;
}

/**
 * HR-003/HR-004 heavy-repo preflight ceiling (baseline #60). A STATIC cap
 * independent of the live resource-probe verdict: when `config['heavy-repo']`
 * is `true`, `agents` is clamped to at most `config['agents-per-wave']`
 * (resolved via {@link resolveApwCap} to handle the object-override shape).
 * More-restrictive-wins — this only ever LOWERS `agents`, never raises it
 * above what the resource-driven rules already decided (e.g. a
 * coordinator-direct 0 stays 0).
 *
 * @param {{decision: string, agents: number, reasons: string[], measurements: object}} result
 * @param {object} opts - Same opts shape as evaluateWaveResourceGate
 * @returns {{decision: string, agents: number, reasons: string[], measurements: object}}
 */
function applyHeavyRepoCap(result, opts) {
  const { config } = opts;
  if (!config || config['heavy-repo'] !== true) return result;
  const cap = resolveApwCap(config['agents-per-wave']);
  if (cap === null) return result;
  if (result.agents <= cap) return result; // already within the ceiling — never raise
  return {
    ...result,
    decision: result.decision === 'coordinator-direct' ? 'coordinator-direct' : 'reduce',
    agents: cap,
    reasons: [...result.reasons, `heavy-repo: true caps agents-per-wave to ${cap} (HR-004)`],
  };
}

/**
 * Rules 3-8: resource-driven decision sequence (RAM/CPU/concurrent-sessions).
 * Extracted so `applyDecisionRules` can layer the HR-004 heavy-repo cap on
 * top without duplicating this sequence.
 *
 * @param {{ramFreeGb: number, cpuLoadPct: number, concurrentSessions: number}} measurements
 * @param {object} opts - Same opts shape as evaluateWaveResourceGate
 * @returns {{decision: string, agents: number, reasons: string[], measurements: object}}
 */
function computeResourceDecision(measurements, opts) {
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
  // `resource-awareness: false` is a FULL opt-out, INCLUDING the HR-004
  // heavy-repo static cap below (applyHeavyRepoCap runs only inside
  // applyDecisionRules, which this early return bypasses entirely). The
  // static cap only applies on the resource-aware path — deliberate,
  // reviewed 2026-07-23, baseline #60.
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
