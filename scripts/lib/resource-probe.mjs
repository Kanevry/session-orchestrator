/**
 * resource-probe.mjs — live RAM/CPU/process snapshot for adaptive session planning.
 *
 * Probes current host load at session-start (and optionally inside wave planning)
 * so `agents-per-wave` and Docker-usage decisions can adapt to real resource
 * pressure rather than static config defaults.
 *
 * Part of v3.1.0 Epic #157, Sub-Epic #158 (A+B). Issue #163.
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
 *     probe_duration_ms: 45,
 *   }
 *
 * process-count fields fall back to `null` when the process-list command fails
 * (e.g. sandboxed environments). Consumers treat `null` as "unknown".
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

async function _processCounts() {
  const output = await _runPs();
  if (output === null || output === undefined) {
    return {
      claude_processes_count: null,
      codex_processes_count: null,
      other_node_processes: null,
    };
  }
  const raw = countProcessMatches(output, DEFAULT_PATTERNS);
  // Subtract self (the currently running probe process counts as 1 node).
  const otherNode = Math.max(0, (raw.other_node ?? 0) - 1);
  return {
    claude_processes_count: raw.claude ?? 0,
    codex_processes_count: raw.codex ?? 0,
    other_node_processes: otherNode,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture a live resource snapshot of the current host.
 * @param {object} [opts]
 * @param {boolean} [opts.skipProcessCounts] — skip process listing (faster in tests)
 * @returns {Promise<object>}
 */
export async function probe(opts = {}) {
  const start = Date.now();
  const ram = _ramSnapshot();
  const cpu = _cpuSnapshot();
  const procs = opts.skipProcessCounts
    ? { claude_processes_count: null, codex_processes_count: null, other_node_processes: null }
    : await _processCounts();
  const duration = Date.now() - start;
  return {
    timestamp: new Date().toISOString(),
    ...ram,
    ...cpu,
    ...procs,
    probe_duration_ms: duration,
  };
}

/**
 * Evaluate a snapshot against `resource-thresholds` (from Session Config #166)
 * and return a verdict used by session-start Phase 4.5.
 * @param {object} snapshot — output of probe()
 * @param {object} thresholds — resource-thresholds block from parseSessionConfig
 * @returns {{verdict: 'green'|'warn'|'critical', reasons: string[], recommended_agents_per_wave_cap: number|null}}
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

  return { verdict, reasons, recommended_agents_per_wave_cap: cap };
}
