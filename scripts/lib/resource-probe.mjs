/**
 * resource-probe.mjs — live RAM/CPU/process snapshot for adaptive session planning.
 *
 * Probes current host load at session-start (and optionally inside wave planning)
 * so `agents-per-wave` and Docker-usage decisions can adapt to real resource
 * pressure rather than static config defaults.
 *
 * Part of v3.1.0 Epic #157, Sub-Epic #158 (A+B). Issue #163.
 * Extended in v3.2 Phase C-2 (#296): swap_used_mb + memory_pressure_pct_free signals.
 *
 * Snapshot shape:
 *   {
 *     timestamp: '2026-04-19T11:00:00Z',
 *     ram_free_gb: 3.2,
 *     ram_used_pct: 78,
 *     cpu_load_1m: 2.4,
 *     cpu_load_pct: 65,
 *     cpu_load_5m: 1.8,
 *     cpu_load_5m_pct: 45 | null,   // 5m load-average as pct-of-cores; null on Windows/zero-load (#943)
 *     claude_processes_count: 3 | null,
 *     peer_sessions_count: 2 | null,   // live peer SESSIONS from the registry, self excluded (#1089)
 *     codex_processes_count: 0 | null,
 *     other_node_processes: 12 | null,
 *     zombie_processes_count: 1 | null,
 *     swap_used_mb: 512 | null,
 *     memory_pressure_pct_free: 42 | null,
 *     ram_available_gb: 82.5 | null,   // macOS: free + reclaimable (vm_stat); null elsewhere (#667)
 *     probe_duration_ms: 45,
 *   }
 *
 * process-count fields fall back to `null` when the process-list command fails
 * (e.g. sandboxed environments). Consumers treat `null` as "unknown".
 *
 * swap_used_mb: null on Windows/unknown or on spawn/parse failure.
 * memory_pressure_pct_free: null on Linux/Windows/unknown or on failure.
 *
 * Implementation split in #287 (hotspot 2/2):
 *   - scripts/lib/resource-probe/parsers.mjs      — pure output parsers
 *   - scripts/lib/resource-probe/probe-platform.mjs — platform sampling I/O
 *   - scripts/lib/resource-probe/evaluate.mjs     — verdict + threshold logic
 */

import os from 'node:os';
import { ramSnapshot, cpuSnapshot, processCounts, swapUsedMb, memoryPressurePctFree, ramAvailableGb, peerSessionsCount } from './resource-probe/probe-platform.mjs';

// ---------------------------------------------------------------------------
// Re-exports — preserve public API for all existing callers
// ---------------------------------------------------------------------------

export { evaluate, PROCESSES_PER_SESSION, PRESSURE_HARD_PCT, PRESSURE_SOFT_PCT, PRESSURE_HEALTHY_PCT, DEFAULT_RESOURCE_THRESHOLDS } from './resource-probe/evaluate.mjs';
export { peerSessionsCount } from './resource-probe/probe-platform.mjs';
export { parseEtimeToMinutes, countZombieProcesses, countProcessMatches, parseSwapUsageOutput, parseMemoryPressureOutput, parseVmStatAvailableGb } from './resource-probe/parsers.mjs';

// ---------------------------------------------------------------------------
// Public API — probe()
// ---------------------------------------------------------------------------

/**
 * Capture a live resource snapshot of the current host.
 * @param {object} [opts]
 * @param {boolean} [opts.skipProcessCounts] — skip process listing (faster in tests)
 * @param {boolean} [opts.skipExtendedSignals] — skip swap + memory_pressure calls (faster in tests)
 * @param {number|null} [opts.zombieThresholdMin] — when non-null, detect zombie Claude/Node
 *   processes older than this many minutes with low CPU. Default null (feature disabled).
 * @param {string|null} [opts.sessionId] — own session id, excluded from `peer_sessions_count`
 *   (#1089). Omit and the count simply includes every live registry entry, which
 *   over-counts by exactly one — pass it whenever the caller knows its own id.
 * @returns {Promise<object>}
 */
export async function probe(opts = {}) {
  const start = Date.now();
  const ram = ramSnapshot();
  const cpu = cpuSnapshot();

  // #943: additionally sample the 5-minute load average. The wave-resource-gate
  // runs, by construction, right after the coordinator's own CPU-saturating
  // quality-gate run — the 1m average still carries that decaying tail
  // (observed 2026-07-30: 96% → 91% → 78% → 75% within 36s after a Full Gate at
  // 813% CPU), while the 5m average smooths it. Consumers (evaluate(),
  // wave-resource-gate) judge CPU on min(1m, 5m) when the 5m signal exists.
  // Windows reports loadavg [0,0,0] → cpu_load_5m_pct stays null there and
  // consumers fall back to cpu_load_pct alone (which cpuSnapshot() derives from
  // per-core times on Windows).
  const load5m = os.loadavg()[1];
  const cpuCores = (os.cpus() || []).length || 1;
  const cpu_load_5m = Math.round(load5m * 10) / 10;
  const cpu_load_5m_pct = load5m > 0 ? Math.min(100, Math.round((load5m / cpuCores) * 100)) : null;
  const zombieThresholdMin = opts.zombieThresholdMin ?? null;
  const procs = opts.skipProcessCounts
    ? { claude_processes_count: null, codex_processes_count: null, other_node_processes: null, zombie_processes_count: null }
    : await processCounts(zombieThresholdMin);

  // #1089: the registry-denominated concurrency signal. Gated on the same
  // skipProcessCounts flag as the `ps` pass — both answer "who else is on this
  // host", and tests that skip one always mean to skip the other.
  const peer_sessions_count = opts.skipProcessCounts
    ? null
    : await peerSessionsCount({ sessionId: opts.sessionId ?? null });

  let swap_used_mb = null;
  let memory_pressure_pct_free = null;
  let ram_available_gb = null;
  if (!opts.skipExtendedSignals) {
    [swap_used_mb, memory_pressure_pct_free, ram_available_gb] = await Promise.all([
      swapUsedMb(),
      memoryPressurePctFree(),
      ramAvailableGb(),
    ]);
  }

  const duration = Date.now() - start;
  return {
    timestamp: new Date().toISOString(),
    ...ram,
    ...cpu,
    cpu_load_5m,
    cpu_load_5m_pct,
    ...procs,
    // Live peer SESSIONS (registry, self excluded) — the unit
    // `concurrent-sessions-warn` is named for. null = registry unreadable, in
    // which case evaluate() falls back to the rescaled process count (#1089).
    peer_sessions_count,
    swap_used_mb,
    memory_pressure_pct_free,
    // macOS-only numeric available-RAM (free + reclaimable) from vm_stat; null
    // on Linux/Windows/unknown where os.freemem() is already accurate (#667).
    ram_available_gb,
    probe_duration_ms: duration,
  };
}
