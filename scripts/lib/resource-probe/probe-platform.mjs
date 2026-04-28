/**
 * probe-platform.mjs — platform-specific resource sampling (RAM, CPU, processes, swap).
 *
 * Handles all async I/O: spawning `ps`/`tasklist`, reading `/proc/meminfo`,
 * calling `sysctl`, `memory_pressure`. Pure parsing is delegated to parsers.mjs.
 *
 * Part of v3.1.0 Epic #157 / Issue #163.
 * Extended in v3.2 Phase C-2 (#296): swap_used_mb + memory_pressure_pct_free signals.
 * Split from resource-probe.mjs in #287 (hotspot 2/2).
 */

import os from 'node:os';
import { spawn } from 'node:child_process';
import { SO_IS_WINDOWS } from '../platform.mjs';
import {
  countProcessMatches,
  countZombieProcesses,
  parseSwapUsageOutput,
  parseMemoryPressureOutput,
} from './parsers.mjs';

// ---------------------------------------------------------------------------
// RAM / CPU primitives (synchronous, via Node os module)
// ---------------------------------------------------------------------------

/**
 * @returns {{ ram_free_gb: number, ram_used_pct: number }}
 */
export function ramSnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = Math.round(((total - free) / total) * 100);
  const freeGb = Math.round((free / (1024 * 1024 * 1024)) * 10) / 10;
  return { ram_free_gb: freeGb, ram_used_pct: usedPct };
}

/**
 * Derive CPU usage percentage from per-core times (used on Windows and when
 * load-average is 0).
 * @returns {number} 0-100
 */
function cpuPctFromTimes() {
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

/**
 * @returns {{ cpu_load_1m: number, cpu_load_pct: number }}
 */
export function cpuSnapshot() {
  const load1m = os.loadavg()[0];
  const cores = (os.cpus() || []).length || 1;
  // load-average is a Unix concept and reports 0 on Windows. When zero, we
  // fall back to per-core user+sys % derived from cpus() times (still rough,
  // but non-zero on Windows so the threshold logic has a signal).
  let loadPct;
  if (SO_IS_WINDOWS || load1m === 0) {
    loadPct = cpuPctFromTimes();
  } else {
    loadPct = Math.min(100, Math.round((load1m / cores) * 100));
  }
  return { cpu_load_1m: Math.round(load1m * 10) / 10, cpu_load_pct: loadPct };
}

// ---------------------------------------------------------------------------
// Process listing helpers (async, shell-based)
// ---------------------------------------------------------------------------

/**
 * Run a command and collect stdout, with a timeout. Returns null on failure.
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
export function runCommand(cmd, args, timeoutMs = 1500) {
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
 * Run `ps -A -o comm` (or `tasklist` on Windows) and return stdout, or null on failure.
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
function runPs(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const cmd = SO_IS_WINDOWS ? 'tasklist' : 'ps';
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
 * Run `ps` collecting PID, command name, elapsed time, and CPU% — used for zombie detection.
 * Returns raw stdout string or null on failure.
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
function runPsDetailed(timeoutMs = 2000) {
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

// ---------------------------------------------------------------------------
// Process pattern matching defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PATTERNS = [
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

/**
 * Collect process counts (claude, codex, node) and optionally zombie count.
 * @param {number|null} [zombieThresholdMin]
 * @returns {Promise<{ claude_processes_count: number|null, codex_processes_count: number|null, other_node_processes: number|null, zombie_processes_count: number|null }>}
 */
export async function processCounts(zombieThresholdMin = null) {
  // Run simple ps (for counts) and detailed ps (for zombie detection) in parallel.
  const [output, detailedOutput] = await Promise.all([
    runPs(),
    zombieThresholdMin !== null ? runPsDetailed() : Promise.resolve(null),
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
 * Probe swap usage. Returns used MB as integer, or null on unsupported/failure.
 * @returns {Promise<number|null>}
 */
export async function swapUsedMb() {
  if (SO_IS_WINDOWS) return null;

  if (process.platform === 'darwin') {
    const output = await runCommand('sysctl', ['vm.swapusage']);
    return parseSwapUsageOutput(output);
  }

  if (process.platform === 'linux') {
    // Read /proc/meminfo and compute SwapTotal - SwapFree (values in kB)
    const output = await runCommand('cat', ['/proc/meminfo']);
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
export async function memoryPressurePctFree() {
  if (process.platform !== 'darwin') return null;

  const output = await runCommand('memory_pressure', []);
  return parseMemoryPressureOutput(output);
}
