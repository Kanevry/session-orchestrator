/**
 * wave-resource-gate.mjs — Pre-dispatch resource gate for parallel agent waves.
 *
 * Evaluates RAM / CPU / concurrent-session pressure before dispatching agents
 * and returns a decision: "proceed", "reduce", or "coordinator-direct".
 *
 * Part of v3.1.0 Epic #157, Sub-Epic resource-gate. Issue #193.
 */

import { probe, evaluate } from './resource-probe.mjs';
import { isNeverForeignRole } from './wave-executor/foreign-dispatch.mjs';

/**
 * Wave roles that may run on a declared remote host, mapped to the
 * `agent-mapping` role a host must list in its `roles-allowed` (#1160).
 *
 * Two enums meet here: the WAVE role ("Quality", "Impl-Core") on the left, the
 * agent-mapping role ("test", "ui", "perf") on the right. Anything absent from
 * this map is local-only — the default is "do not offload", so a wave role added
 * later never becomes offloadable by accident.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const OFFLOADABLE_WAVE_ROLES = Object.freeze({
  quality: 'test',
  test: 'test',
  ui: 'ui',
  perf: 'perf',
});

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
 * @returns {Promise<{ramFreeGb: number, ramAvailableGb: number|null, cpuLoadPct: number, cpuLoad5mPct: number|null, concurrentSessions: number} | {probeFailed: true}>}
 */
async function extractMeasurements(opts) {
  const { probeOverride } = opts;

  if (probeOverride !== undefined && probeOverride !== null) {
    return {
      ramFreeGb: probeOverride.ramFreeGb,
      // Tests may supply ramAvailableGb to exercise the macOS path; absent → null.
      ramAvailableGb: probeOverride.ramAvailableGb ?? null,
      // macOS memory_pressure — the highest-precedence memory signal (#1089).
      memoryPressurePctFree: probeOverride.memoryPressurePctFree ?? null,
      cpuLoadPct: probeOverride.cpuLoadPct,
      // 5m-average CPU pct (#943); absent → null (legacy overrides → 1m-only judging).
      cpuLoad5mPct: probeOverride.cpuLoad5mPct ?? null,
      // #1089: live peer SESSIONS from the registry — the unit
      // `concurrent-sessions-warn` is named for. Absent → null, and the
      // rescaled process-count fallback applies.
      peerSessions: probeOverride.peerSessions ?? null,
      // Raw Claude PROCESS count. Historically (and misleadingly) named
      // `concurrentSessions` on this override object; kept as an accepted alias
      // so existing callers keep working, but it is compared against a
      // process-denominated threshold now, never a session-denominated one.
      claudeProcesses: probeOverride.claudeProcesses ?? probeOverride.concurrentSessions ?? null,
      concurrentSessions: probeOverride.concurrentSessions,
      swapUsedMb: probeOverride.swapUsedMb ?? null,
      zombieProcesses: probeOverride.zombieProcesses ?? null,
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
    // macOS memory_pressure — outranks both of the above (#1089).
    memoryPressurePctFree: snapshot.memory_pressure_pct_free ?? null,
    cpuLoadPct: snapshot.cpu_load_pct,
    // 5m load-average as pct-of-cores (#943). null on Windows/zero-load, where
    // the gate falls back to judging the 1m-derived cpu_load_pct alone.
    cpuLoad5mPct: snapshot.cpu_load_5m_pct ?? null,
    // #1089: live peer SESSIONS (registry, self excluded) — what
    // `concurrent-sessions-warn` was always named for. This line used to read
    // `concurrentSessions: snapshot.claude_processes_count`, a measured 6x unit
    // error that made the gate reduce waves on essentially every dispatch.
    peerSessions: snapshot.peer_sessions_count ?? null,
    claudeProcesses: snapshot.claude_processes_count ?? null,
    // Retained for the returned `measurements` object, which callers log.
    concurrentSessions: snapshot.claude_processes_count ?? 0,
    swapUsedMb: snapshot.swap_used_mb ?? null,
    zombieProcesses: snapshot.zombie_processes_count ?? null,
  };
}

/**
 * Apply the gate decision rule sequence (rules 3-8) given measurements and
 * config, then apply the HR-004 heavy-repo preflight ceiling on top. Returns
 * the full gate result.
 *
 * @param {{ramFreeGb: number, ramAvailableGb?: number|null, cpuLoadPct: number, cpuLoad5mPct?: number|null, concurrentSessions: number}} measurements
 * @param {object} opts - Same opts shape as evaluateWaveResourceGate
 * @returns {Promise<{decision: string, agents: number, reasons: string[], measurements: object, host?: string}>}
 */
async function applyDecisionRules(measurements, opts) {
  const result = computeResourceDecision(measurements, opts);
  // Order is load-bearing: the heavy-repo cap is a STATIC property of the repo
  // and only ever lowers; offload is a PLACEMENT answer to live pressure. Running
  // offload last means a capped wave that gets offloaded still respects HR-004,
  // and never the reverse.
  return applyOffloadDecision(applyHeavyRepoCap(result, opts), opts);
}

/**
 * #1160 offload placement. When the resource rules want to SHRINK the wave
 * (`reduce`) or take it away entirely (`coordinator-direct`), and the repo
 * declares a remote host that accepts this wave role, route the wave to that
 * host at its full planned agent count instead of shrinking it.
 *
 * The gate does NOT probe the network — a placement decision must stay a pure
 * function of its inputs. The caller supplies a readiness WITNESS:
 *   - `opts.remoteReady` — `{ [alias]: boolean }`, e.g. built from the
 *     SessionStart `Offload m5: ready=yes` banner or `remoteDoctor()`.
 *   - `opts.probeFn` — `async (alias) => boolean`, consulted only for hosts the
 *     `remoteReady` map does not already answer for. Default `null`. A probeFn
 *     that REJECTS is read as not-ready and its message is appended to
 *     `reasons` — the gate never loses the local decision to a failed witness.
 * With neither supplied NO host is ready and the decision stays `reduce` /
 * `coordinator-direct` — the gate fails toward local, never toward a host it
 * cannot vouch for.
 *
 * @param {{decision: string, agents: number, reasons: string[], measurements: object}} result
 * @param {object} opts - Same opts shape as evaluateWaveResourceGate
 * @returns {Promise<{decision: string, agents: number, reasons: string[], measurements: object, host?: string}>}
 */
async function applyOffloadDecision(result, opts) {
  if (result.decision !== 'reduce' && result.decision !== 'coordinator-direct') return result;

  const { config, plannedAgents, waveRole, remoteReady, probeFn = null } = opts;
  const hosts = config?.['remote-hosts'];
  if (!Array.isArray(hosts) || hosts.length === 0) return result;

  const role = String(waveRole ?? '').trim().toLowerCase();
  if (isNeverForeignRole(role)) return result;
  const mappedRole = OFFLOADABLE_WAVE_ROLES[role];
  if (mappedRole === undefined) return result;

  const ready = remoteReady && typeof remoteReady === 'object' ? remoteReady : {};
  // A witness that THROWS is a host that did not answer — never a reason to lose
  // the local decision the resource rules already computed. Before this catch, a
  // rejecting probeFn (ssh down, `offload` missing) propagated all the way out of
  // evaluateWaveResourceGate and rejected the whole gate call.
  /** @type {string[]} */
  const probeFailures = [];
  // First fit in DECLARATION order — the operator's order is the preference order.
  let host;
  for (const h of hosts) {
    if (!Array.isArray(h?.['roles-allowed']) || !h['roles-allowed'].includes(mappedRole)) continue;
    let isReady = ready[h.alias] === true;
    if (!isReady && ready[h.alias] === undefined && typeof probeFn === 'function') {
      try {
        isReady = (await probeFn(h.alias)) === true;
      } catch (err) {
        isReady = false;
        probeFailures.push(
          `offload probe for '${h.alias}' failed (${(err && err.message) || String(err)}) — staying local`,
        );
      }
    }
    if (isReady) {
      host = h;
      break;
    }
  }
  if (host === undefined) {
    return probeFailures.length === 0
      ? result
      : { ...result, reasons: [...result.reasons, ...probeFailures] };
  }

  // The wave runs at its planned size again — but never above the HR-004 static
  // ceiling, which is a property of the REPO and holds wherever the wave runs.
  // Restoring plannedAgents unconditionally here would let a heavy repo exceed
  // its own cap by way of a remote host.
  const cap = config?.['heavy-repo'] === true ? resolveApwCap(config['agents-per-wave']) : null;
  const agents = cap === null ? plannedAgents : Math.min(plannedAgents, cap);

  return {
    decision: 'offload',
    agents,
    host: host.alias,
    reasons: [
      ...result.reasons,
      `offload: ${role} routed to host '${host.alias}' instead of reducing to ${result.agents}`,
    ],
    measurements: result.measurements,
  };
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
 * Resource-driven decision, delegated to `evaluate()` (#1089).
 *
 * This function used to carry its OWN copy of the RAM/CPU/concurrency rules,
 * running in sequence with first-match-wins. That duplication is exactly why
 * the #667 available-RAM correction only ever landed halfway: it was applied
 * here and in `evaluate()` separately, and the memory_pressure precedence that
 * followed reached only one of the two. There is now one rule engine and this
 * is a translation layer over it.
 *
 * Verdict → decision mapping:
 *   critical (hard signal)      → coordinator-direct, 0 agents
 *   warn     (2+ soft signals)  → reduce, plannedAgents / 2 (floor 1)
 *   green    (0-1 soft signals) → proceed at plannedAgents, reasons retained
 *
 * The halving on `warn` is this gate's own policy and deliberately differs
 * from `evaluate()`'s flat cap of 2: the gate knows `plannedAgents` (a wave of
 * 3 should not be "capped" UP to nothing), `evaluate()` does not.
 *
 * @param {object} measurements — from extractMeasurements
 * @param {object} opts - Same opts shape as evaluateWaveResourceGate
 * @returns {{decision: string, agents: number, reasons: string[], measurements: object}}
 */
function computeResourceDecision(measurements, opts) {
  const { config, plannedAgents } = opts;
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

  // Translate the gate's measurement shape into a probe-shaped snapshot so the
  // single rule engine can judge it. Field names differ because the override
  // object is a documented public test seam that predates the snapshot shape.
  const snapshot = {
    ram_free_gb: measurements.ramFreeGb,
    ram_available_gb: measurements.ramAvailableGb ?? null,
    memory_pressure_pct_free: measurements.memoryPressurePctFree ?? null,
    cpu_load_pct: measurements.cpuLoadPct,
    cpu_load_5m_pct: measurements.cpuLoad5mPct ?? null,
    peer_sessions_count: measurements.peerSessions ?? null,
    claude_processes_count: measurements.claudeProcesses ?? null,
    swap_used_mb: measurements.swapUsedMb ?? null,
    zombie_processes_count: measurements.zombieProcesses ?? null,
  };

  // heavyRepo is applied by applyHeavyRepoCap() on the way out, so it is
  // deliberately NOT passed here — passing it would apply the ceiling twice.
  const verdict = evaluate(snapshot, T);

  if (verdict.verdict === 'critical') {
    return {
      decision: 'coordinator-direct',
      agents: 0,
      reasons: verdict.reasons,
      measurements,
    };
  }
  if (verdict.verdict === 'warn') {
    return {
      decision: 'reduce',
      agents: Math.max(1, Math.floor(plannedAgents / 2)),
      reasons: verdict.reasons,
      measurements,
    };
  }
  return {
    decision: 'proceed',
    agents: plannedAgents,
    reasons: verdict.reasons.length > 0 ? verdict.reasons : ['all thresholds within bounds'],
    measurements,
  };
}

/**
 * Evaluate whether the wave can be dispatched at the planned agent count.
 * @param {object} opts
 * @param {object} opts.config - Parsed Session Config (from parse-config.sh output)
 * @param {number} opts.plannedAgents - Number of agents the session-plan wants to dispatch
 * @param {string} opts.waveRole - e.g. "Impl-Core", "Quality"
 * @param {object} [opts.probeOverride] - {ramFreeGb, cpuLoadPct, cpuLoad5mPct?, concurrentSessions}
 *   for testing; when omitted, calls resource-probe
 * @param {Record<string, boolean>} [opts.remoteReady] - #1160 readiness witness per
 *   declared host alias. The gate never probes the network itself; without a witness
 *   no host counts as ready and the decision stays local.
 * @param {(alias: string) => Promise<boolean>} [opts.probeFn] - optional async witness,
 *   consulted only for aliases absent from `remoteReady`. Default null. Use
 *   `remoteReadyProbe` from scripts/lib/wave-executor/remote-dispatch.mjs; a
 *   rejection counts as not-ready and is reported in `reasons`, never thrown.
 * @returns {Promise<{decision: "proceed"|"reduce"|"coordinator-direct"|"offload", agents: number, reasons: string[], measurements: object, host?: string}>}
 *   `host` is present only on an `offload` decision — the declared alias the wave runs on.
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
 * @param {{decision: string, agents: number, reasons: string[], measurements: object, host?: string}} result
 * @returns {string}
 */
export function formatGateReport(result) {
  const { decision, agents, reasons, measurements, host } = result;
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
  // An `offload` decision without its host in the banner is unreadable: the agent
  // count did not shrink, so the line would look identical to `proceed` (HR-106).
  const agentsStr = decision === 'offload' && host ? `${agents} @ ${host}` : `${agents}`;
  lines.push(`Decision: ${decision} — agents: ${agentsStr}${measStr}`);
  return lines.join('\n');
}
