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
 */

import os from 'node:os';
import { spawn } from 'node:child_process';
import { SO_IS_WINDOWS } from './platform.mjs';

// ---------------------------------------------------------------------------
// RAM / CPU primitives (synchronous, via Node os module)
// ---------------------------------------------------------------------------

function _ramSnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = Math.round(((total - free) / total) * 100);
  const freeGb = Math.round((free / (1024 * 1024 * 1024)) * 10) / 10;
  return { ram_free_gb: freeGb, ram_used_pct: usedPct };
}

function _cpuSnapshot() {
  const load1m = os.loadavg()[0];
  const cores = (os.cpus() || []).length || 1;
  // load-average is a Unix concept and reports 0 on Windows. When zero, we
  // fall back to per-core user+sys % derived from cpus() times (still rough,
  // but non-zero on Windows so the threshold logic has a signal).
  let loadPct;
  if (SO_IS_WINDOWS || load1m === 0) {
    loadPct = _cpuPctFromTimes();
  } else {
    loadPct = Math.min(100, Math.round((load1m / cores) * 100));
  }
  return { cpu_load_1m: Math.round(load1m * 10) / 10, cpu_load_pct: loadPct };
}

function _cpuPctFromTimes() {
  const cpus = os.cpus() || [];
  if (cpus.length === 0) return 0;
  let totalBusy = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    const busy = t.user + t.nice + t.sys + t.irq;
    totalBusy += busy;
    total += busy + t.idle;
  }
  if (total === 0) return 0;
  return Math.min(100, Math.round((totalBusy / total) * 100));
}

// ---------------------------------------------------------------------------
// Process counting (async, shell-based)
// ---------------------------------------------------------------------------

function _runPs(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const cmd = SO_IS_WINDOWS
        ? 'tasklist'
        : 'ps';
      const args = SO_IS_WINDOWS
        ? ['/FO', 'CSV', '/NH']
        : ['-A', '-o', 'comm'];
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (code !== 0) return finish(null);
        finish(Buffer.concat(chunks).toString('utf8'));
      });
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(null);
      }, timeoutMs);
    } catch {
      finish(null);
    }
  });
}

/**
 * Parse a `ps` etime field (`[[DD-]HH:]MM:SS`) into whole minutes.
 * Returns null when the format is unrecognised.
 * Pure function for unit testability.
 * @param {string} etime
 * @returns {number|null}
 */
export function parseEtimeToMinutes(etime) {
  if (typeof etime !== 'string') return null;
  const s = etime.trim();
  // Regex: optional "DD-", optional "HH:", then "MM:SS"
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  const days = parseInt(m[1] ?? '0', 10);
  const hours = parseInt(m[2] ?? '0', 10);
  const mins = parseInt(m[3], 10);
  // seconds intentionally dropped (we only need minutes resolution)
  if ([days, hours, mins].some(Number.isNaN)) return null;
  return days * 24 * 60 + hours * 60 + mins;
}

/**
 * Run `ps` collecting PID, command name, elapsed time, and CPU% — used for zombie detection.
 * Returns raw stdout string or null on failure.
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function _runPsDetailed(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (SO_IS_WINDOWS) { resolve(null); return; }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      // -A: all processes; output: pid, comm (basename), etime, %cpu
      const child = spawn('ps', ['-A', '-o', 'pid,comm,etime,%cpu'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (code !== 0) return finish(null);
        finish(Buffer.concat(chunks).toString('utf8'));
      });
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(null);
      }, timeoutMs);
    } catch {
      finish(null);
    }
  });
}

/**
 * Parse the detailed ps output and count Claude/Node zombie candidates.
 * A zombie candidate is a process matching "claude" or "node" that:
 *   - has been running longer than `thresholdMin` minutes, AND
 *   - has CPU% at or below `maxCpuPct` (default 1.0 → idle).
 * Pure function for unit testability.
 * @param {string|null} psOutput — stdout from `ps -A -o pid,comm,etime,%cpu`
 * @param {number} thresholdMin — age threshold in minutes
 * @param {number} [maxCpuPct] — CPU% at-or-below which process is considered idle (default 1.0)
 * @returns {number|null} count, or null when psOutput is null
 */
export function countZombieProcesses(psOutput, thresholdMin, maxCpuPct = 1.0) {
  if (psOutput === null || psOutput === undefined) return null;
  const lines = String(psOutput).split(/\r?\n/);
  let count = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || /^\s*PID/i.test(trimmed)) continue; // skip header
    // Fields: PID COMM ELAPSED %CPU  (ELAPSED may contain '-' and ':')
    // Split on whitespace but preserve etime which has no spaces.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    // parts[0]=PID, parts[1]=COMM, parts[2]=ETIME, parts[3]=%CPU
    const comm = (parts[1] ?? '').toLowerCase();
    const etimeStr = parts[2] ?? '';
    const cpuStr = parts[3] ?? '';
    const isClaudeOrNode =
      /(^|[\s/])claude([\s]|$)/.test(comm) ||
      comm === 'claude' ||
      /(^|[\s/])node([\s]|$)/.test(comm) ||
      comm === 'node';
    if (!isClaudeOrNode) continue;
    const ageMin = parseEtimeToMinutes(etimeStr);
    if (ageMin === null || ageMin < thresholdMin) continue;
    const cpu = parseFloat(cpuStr);
    if (Number.isNaN(cpu) || cpu > maxCpuPct) continue;
    count++;
  }
  return count;
}

/**
 * Parse a raw process listing (ps or tasklist output) and count matches.
 * Pure function for unit testability.
 */
export function countProcessMatches(psOutput, patterns) {
  if (psOutput === null || psOutput === undefined) return null;
  const lines = String(psOutput).split(/\r?\n/);
  const counts = Object.fromEntries(patterns.map((p) => [p.key, 0]));
  for (const raw of lines) {
    const line = raw.toLowerCase();
    for (const p of patterns) {
      if (p.match(line)) counts[p.key] += 1;
    }
  }
  return counts;
}

const DEFAULT_PATTERNS = [
  {
    key: 'claude',
    // Matches the `claude` CLI process plus `Claude Code` macOS app names.
    match: (l) => /(^|[\s/,"])claude([\s",]|$)/.test(l) || l.includes('claude code') || l.includes('claude.app'),
  },
  {
    key: 'codex',
    match: (l) => /(^|[\s/,"])codex([\s",]|$)/.test(l) || l.includes('codex cli'),
  },
  {
    key: 'other_node',
    // All node processes; caller subtracts claude/codex-related node procs.
    match: (l) => /(^|[\s/,"])node([\s",]|$)/.test(l),
  },
];

async function _processCounts(zombieThresholdMin = null) {
  // Run simple ps (for counts) and detailed ps (for zombie detection) in parallel.
  const [output, detailedOutput] = await Promise.all([
    _runPs(),
    zombieThresholdMin !== null ? _runPsDetailed() : Promise.resolve(null),
  ]);
  if (output === null || output === undefined) {
    return {
      claude_processes_count: null,
      codex_processes_count: null,
      other_node_processes: null,
      zombie_processes_count: null,
    };
  }
  const raw = countProcessMatches(output, DEFAULT_PATTERNS);
  // Subtract self (the currently running probe process counts as 1 node).
  const otherNode = Math.max(0, (raw.other_node ?? 0) - 1);
  const zombie_processes_count =
    zombieThresholdMin !== null
      ? countZombieProcesses(detailedOutput, zombieThresholdMin)
      : null;
  return {
    claude_processes_count: raw.claude ?? 0,
    codex_processes_count: raw.codex ?? 0,
    other_node_processes: otherNode,
    zombie_processes_count,
  };
}

// ---------------------------------------------------------------------------
// Swap usage (async, spawn-based) — macOS + Linux only
// ---------------------------------------------------------------------------

/**
 * Parse `sysctl vm.swapusage` output (macOS) and return used MB as integer.
 * Pure function for unit testability.
 * @param {string} text
 * @returns {number|null}
 */
export function parseSwapUsageOutput(text) {
  if (text === null || text === undefined) return null;
  // Sample: "vm.swapusage: total = 4096.00M  used = 1234.50M  free = 2861.50M"
  const match = /used\s*=\s*([\d.]+)M/i.exec(String(text));
  if (!match) return null;
  const mb = parseFloat(match[1]);
  if (Number.isNaN(mb)) return null;
  return Math.round(mb);
}

/**
 * Parse `memory_pressure` output (macOS) and return the free percentage as integer.
 * Pure function for unit testability.
 * @param {string} text
 * @returns {number|null}
 */
export function parseMemoryPressureOutput(text) {
  if (text === null || text === undefined) return null;
  // Sample: "System-wide memory free percentage: 42%"
  const match = /System-wide memory free percentage:\s*(\d+)%/i.exec(String(text));
  if (!match) return null;
  const pct = parseInt(match[1], 10);
  if (Number.isNaN(pct)) return null;
  return pct;
}

/**
 * Run a command and collect stdout, with a timeout. Returns null on failure.
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function _runCommand(cmd, args, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (code !== 0) return finish(null);
        finish(Buffer.concat(chunks).toString('utf8'));
      });
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(null);
      }, timeoutMs);
    } catch {
      finish(null);
    }
  });
}

/**
 * Probe swap usage. Returns used MB as integer, or null on unsupported/failure.
 * @returns {Promise<number|null>}
 */
async function _swapUsedMb() {
  if (SO_IS_WINDOWS) return null;

  if (process.platform === 'darwin') {
    const output = await _runCommand('sysctl', ['vm.swapusage']);
    return parseSwapUsageOutput(output);
  }

  if (process.platform === 'linux') {
    // Read /proc/meminfo and compute SwapTotal - SwapFree (values in kB)
    const output = await _runCommand('cat', ['/proc/meminfo']);
    if (output === null) return null;
    const totalMatch = /SwapTotal:\s*(\d+)\s*kB/i.exec(output);
    const freeMatch = /SwapFree:\s*(\d+)\s*kB/i.exec(output);
    if (!totalMatch || !freeMatch) return null;
    const totalKb = parseInt(totalMatch[1], 10);
    const freeKb = parseInt(freeMatch[1], 10);
    if (Number.isNaN(totalKb) || Number.isNaN(freeKb)) return null;
    return Math.round((totalKb - freeKb) / 1024);
  }

  return null;
}

/**
 * Probe macOS memory_pressure free percentage. Returns integer 0..100, or null.
 * @returns {Promise<number|null>}
 */
async function _memoryPressurePctFree() {
  if (process.platform !== 'darwin') return null;

  const output = await _runCommand('memory_pressure', []);
  return parseMemoryPressureOutput(output);
}

// ---------------------------------------------------------------------------
// Public API
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
  const ram = _ramSnapshot();
  const cpu = _cpuSnapshot();
  const zombieThresholdMin = opts.zombieThresholdMin ?? null;
  const procs = opts.skipProcessCounts
    ? { claude_processes_count: null, codex_processes_count: null, other_node_processes: null, zombie_processes_count: null }
    : await _processCounts(zombieThresholdMin);

  let swap_used_mb = null;
  let memory_pressure_pct_free = null;
  if (!opts.skipExtendedSignals) {
    [swap_used_mb, memory_pressure_pct_free] = await Promise.all([
      _swapUsedMb(),
      _memoryPressurePctFree(),
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

// ---------------------------------------------------------------------------
// Verdict precedence helper
// ---------------------------------------------------------------------------

const VERDICT_RANK = { green: 0, warn: 1, degraded: 2, critical: 3 };

/**
 * Return the more restrictive of two verdicts.
 * @param {string} current
 * @param {string} target
 * @returns {string}
 */
function bumpVerdict(current, target) {
  const currentRank = VERDICT_RANK[current] ?? 0;
  const targetRank = VERDICT_RANK[target] ?? 0;
  return targetRank > currentRank ? target : current;
}

/**
 * Evaluate a snapshot against `resource-thresholds` (from Session Config #166)
 * and return a verdict used by session-start Phase 4.5.
 * @param {object} snapshot — output of probe()
 * @param {object} thresholds — resource-thresholds block from parseSessionConfig
 * @returns {{verdict: 'green'|'warn'|'degraded'|'critical', reasons: string[], recommended_agents_per_wave_cap: number|null}}
 */
export function evaluate(snapshot, thresholds) {
  const reasons = [];
  let verdict = 'green';
  let cap = null;

  const { ram_free_gb, cpu_load_pct, claude_processes_count } = snapshot;
  const {
    'ram-free-min-gb': ramMin,
    'ram-free-critical-gb': ramCrit,
    'cpu-load-max-pct': cpuMax,
    'concurrent-sessions-warn': concWarn,
  } = thresholds;

  if (ram_free_gb < ramCrit) {
    verdict = 'critical';
    cap = 0;
    reasons.push(`RAM free ${ram_free_gb.toFixed(1)} GB below critical threshold ${ramCrit} GB — recommend coordinator-direct (0 agents).`);
  } else if (ram_free_gb < ramMin) {
    if (verdict === 'green') verdict = 'warn';
    cap = cap === null ? 2 : Math.min(cap, 2);
    reasons.push(`RAM free ${ram_free_gb.toFixed(1)} GB below threshold ${ramMin} GB — capping agents-per-wave at 2.`);
  }

  if (cpu_load_pct > cpuMax) {
    if (verdict === 'green') verdict = 'warn';
    cap = cap === null ? 2 : Math.min(cap, 2);
    reasons.push(`CPU load ${cpu_load_pct}% above threshold ${cpuMax}% — capping agents-per-wave at 2.`);
  }

  if (claude_processes_count !== null && claude_processes_count !== undefined && claude_processes_count >= concWarn) {
    if (verdict === 'green') verdict = 'warn';
    reasons.push(`${claude_processes_count} Claude processes already running (threshold: ${concWarn}) — consider sequencing this session after others finish.`);
  }

  // ---------------------------------------------------------------------------
  // Zombie signal (#178): null = feature disabled (zombieThresholdMin absent) → no rule fires
  // Escalates to warn only when BOTH zombie_processes_count >= 1 AND
  // claude_processes_count is elevated (>= concWarn or > 0 with zombies).
  // ---------------------------------------------------------------------------
  const { zombie_processes_count } = snapshot;
  if (zombie_processes_count !== null && zombie_processes_count !== undefined && zombie_processes_count >= 1) {
    const claudeElevated =
      claude_processes_count !== null &&
      claude_processes_count !== undefined &&
      claude_processes_count > 0;
    if (claudeElevated) {
      verdict = bumpVerdict(verdict, 'warn');
      reasons.push(`${zombie_processes_count} zombie Claude/Node process(es) detected (age > ${thresholds['zombie-threshold-min'] ?? 30} min, idle CPU) with ${claude_processes_count} Claude process(es) running — consider sweeping stale sessions.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Swap signal (macOS / Linux only; null = signal unavailable → no rule fires)
  // ---------------------------------------------------------------------------
  const { swap_used_mb } = snapshot;
  if (swap_used_mb !== null && swap_used_mb !== undefined) {
    if (swap_used_mb > 3072) {
      verdict = bumpVerdict(verdict, 'critical');
      cap = 0;
      reasons.push(`Swap usage ${swap_used_mb} MB above critical threshold 3072 MB — recommend coordinator-direct (0 agents).`);
    } else if (swap_used_mb > 2048) {
      const newVerdict = bumpVerdict(verdict, 'degraded');
      if (newVerdict !== verdict) {
        verdict = newVerdict;
        cap = cap === null ? 2 : Math.min(cap, 2);
      }
      reasons.push(`Swap usage ${swap_used_mb} MB in degraded range (2048..3072 MB) — capping agents-per-wave at 2.`);
    } else if (swap_used_mb > 1024) {
      const newVerdict = bumpVerdict(verdict, 'warn');
      if (newVerdict !== verdict) {
        verdict = newVerdict;
        cap = cap === null ? 2 : Math.min(cap, 2);
      }
      reasons.push(`Swap usage ${swap_used_mb} MB in warn range (1024..2048 MB) — capping agents-per-wave at 2.`);
    }
  }

  // ---------------------------------------------------------------------------
  // macOS memory_pressure signal (null = signal unavailable → no rule fires)
  // ---------------------------------------------------------------------------
  const { memory_pressure_pct_free } = snapshot;
  if (memory_pressure_pct_free !== null && memory_pressure_pct_free !== undefined) {
    if (memory_pressure_pct_free < 5) {
      verdict = bumpVerdict(verdict, 'critical');
      cap = 0;
      reasons.push(`macOS memory_pressure free ${memory_pressure_pct_free}% below critical threshold 5% — recommend coordinator-direct (0 agents).`);
    } else if (memory_pressure_pct_free < 15) {
      const newVerdict = bumpVerdict(verdict, 'degraded');
      if (newVerdict !== verdict) {
        verdict = newVerdict;
        cap = cap === null ? 2 : Math.min(cap, 2);
      }
      reasons.push(`macOS memory_pressure free ${memory_pressure_pct_free}% in degraded range (5..15%) — capping agents-per-wave at 2.`);
    } else if (memory_pressure_pct_free < 30) {
      const newVerdict = bumpVerdict(verdict, 'warn');
      if (newVerdict !== verdict) {
        verdict = newVerdict;
        cap = cap === null ? 2 : Math.min(cap, 2);
      }
      reasons.push(`macOS memory_pressure free ${memory_pressure_pct_free}% in warn range (15..30%) — capping agents-per-wave at 2.`);
    }
  }

  // Ensure cap aligns with final verdict when critical was triggered by swap/memory_pressure
  // (the bumpVerdict path sets cap=0 inline for critical, but re-affirm for safety)
  if (verdict === 'critical') {
    cap = 0;
  }

  return { verdict, reasons, recommended_agents_per_wave_cap: cap };
}
