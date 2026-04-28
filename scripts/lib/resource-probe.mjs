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
 *     claude_processes_count: 3 | null,
 *     codex_processes_count: 0 | null,
 *     other_node_processes: 12 | null,
 *     zombie_processes_count: 1 | null,
 *     swap_used_mb: 512 | null,
 *     memory_pressure_pct_free: 42 | null,
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

import { ramSnapshot, cpuSnapshot, processCounts, swapUsedMb, memoryPressurePctFree } from './resource-probe/probe-platform.mjs';

// ---------------------------------------------------------------------------
// Re-exports — preserve public API for all existing callers
// ---------------------------------------------------------------------------

export { evaluate } from './resource-probe/evaluate.mjs';
export { parseEtimeToMinutes, countZombieProcesses, countProcessMatches, parseSwapUsageOutput, parseMemoryPressureOutput } from './resource-probe/parsers.mjs';

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
 * @returns {Promise<object>}
 */
export async function probe(opts = {}) {
  const start = Date.now();
  const ram = ramSnapshot();
  const cpu = cpuSnapshot();
  const zombieThresholdMin = opts.zombieThresholdMin ?? null;
  const procs = opts.skipProcessCounts
    ? { claude_processes_count: null, codex_processes_count: null, other_node_processes: null, zombie_processes_count: null }
    : await processCounts(zombieThresholdMin);

  let swap_used_mb = null;
  let memory_pressure_pct_free = null;
  if (!opts.skipExtendedSignals) {
    [swap_used_mb, memory_pressure_pct_free] = await Promise.all([
      swapUsedMb(),
      memoryPressurePctFree(),
    ]);
  }

  const duration = Date.now() - start;
  return {
    timestamp: new Date().toISOString(),
    ...ram,
    ...cpu,
    ...procs,
    swap_used_mb,
    memory_pressure_pct_free,
    probe_duration_ms: duration,
  };
}
