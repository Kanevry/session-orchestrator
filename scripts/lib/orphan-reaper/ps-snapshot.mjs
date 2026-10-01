/**
 * orphan-reaper/ps-snapshot.mjs — the binding `ps` format: how the reaper
 * measures the process table, and how it reads what it measured.
 */

import { spawn } from 'node:child_process';

import { parseEtimeToSeconds } from '../resource-probe/parsers.mjs';

/**
 * The binding `ps` invocation (Discovery d-2, 2026-09-21, Darwin 25.6.0).
 *
 * Headerless (`=` per field) and six NUMERIC fields before `args`, because on
 * macOS `comm` is a 16-character-truncated PATH that may contain spaces (68 of
 * 784 processes carried a space, 13 of them survived the truncation) — appending
 * `args` after `comm` breaks whitespace splitting outright. `-ww` disables column
 * truncation; `ps` escapes control characters, so one process is one line.
 * `rss` is in KiB. Roundtrip measured at ~47 ms for 287 KB / 784 processes.
 *
 * `pgid=` is the sixth column and is what lets a row join the ledger as a GROUP
 * MEMBER rather than only as the recorded leader (see `reaper-decide.mjs`).
 * Availability measured 2026-09-22 on Darwin 25.6.0 — `ps -Aww -o
 * pid=,ppid=,pgid=,rss=,etime=,%cpu=,args=` exits 0 and prints the column; it is
 * POSIX (`pgid` is a standard `-o` keyword) and present on Linux `procps` too.
 *
 * A targeted call, NOT the full `probe()` — that one spawns up to five
 * subprocesses and has no caching (PRD § B4).
 */
export const PS_ARGS = Object.freeze(['-Aww', '-o', 'pid=,ppid=,pgid=,rss=,etime=,%cpu=,args=']);

/**
 * The TARGETED variant of {@link PS_ARGS}: one pid, same seven columns.
 *
 * Used immediately before every signal and once after the ladder (B3/B6). It is
 * a separate call rather than a re-run of the full `-A` scan because the whole
 * point is freshness at the moment of signalling — a 784-row snapshot taken for
 * the population is already stale by the time the ladder's 10 s grace elapses,
 * and re-taking it per signal would cost 287 KB to learn one row.
 *
 * @param {number} pid
 * @returns {string[]}
 */
export function psPidArgs(pid) {
  return ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,pgid=,rss=,etime=,%cpu=,args='];
}

/** Wall-clock ceiling for one `ps` call. Same 2 s as `runPsDetailed()` in
 *  `resource-probe/probe-platform.mjs`, whose spawn/timeout shape this mirrors. */
const PS_TIMEOUT_MS = 2000;

/**
 * One parsed `ps` row.
 * @typedef {object} PsRow
 * @property {number} pid
 * @property {number} ppid
 * @property {number} pgid            Process-group id — the ledger's group join key.
 * @property {number} rssKb           Resident set size in KiB.
 * @property {number} etimeSeconds    Elapsed seconds since exec.
 * @property {number} cpuPct
 * @property {string} args            Full command line.
 */

/**
 * Parse `ps` output in the {@link PS_ARGS} format, tolerantly — and COUNT what
 * it drops.
 *
 * A silently skipping parser turns a partial read into a clean verdict, which is
 * the exact failure mode a reaper must not have; hence the `malformed` count
 * ({@link parsePsSnapshotDetailed}). A row whose `etime` does not parse is
 * treated as malformed rather than returned with a null age: every returned row
 * must carry a usable age, because age is a load-bearing gate here.
 *
 * @param {string|null|undefined} text
 * @returns {{rows: PsRow[], malformed: number}}
 */
export function parsePsSnapshotDetailed(text) {
  if (text === null || text === undefined) return { rows: [], malformed: 0 };
  /** @type {PsRow[]} */
  const rows = [];
  let malformed = 0;
  // Six whitespace-free fields, then `args` as the ENTIRE rest of the line —
  // args legitimately contains spaces, so it must never be split.
  const rowRe = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/;
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const m = rowRe.exec(raw);
    if (!m) { malformed += 1; continue; }
    const etimeSeconds = parseEtimeToSeconds(m[5]);
    const cpuPct = parseFloat(m[6]);
    if (etimeSeconds === null || Number.isNaN(cpuPct)) { malformed += 1; continue; }
    rows.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      pgid: parseInt(m[3], 10),
      rssKb: parseInt(m[4], 10),
      etimeSeconds,
      cpuPct,
      args: m[7] ?? '',
    });
  }
  return { rows, malformed };
}

/**
 * {@link parsePsSnapshotDetailed} without the drop count.
 * @param {string|null|undefined} text
 * @returns {PsRow[]}
 */
export function parsePsSnapshot(text) {
  return parsePsSnapshotDetailed(text).rows;
}

/**
 * Default `ps` runner: the {@link PS_ARGS} call with a hard 2 s deadline,
 * SIGKILL on overrun, and `null` on any failure. Never throws.
 *
 * Mirrors `runPsDetailed()` in `resource-probe/probe-platform.mjs` — the same
 * spawn/settle/timeout shape, a different column set.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
export function runPs(timeoutMs = PS_TIMEOUT_MS) {
  return runPsArgs([...PS_ARGS], timeoutMs);
}

/**
 * Default TARGETED `ps` runner (B3/B6): {@link psPidArgs} with the same hard
 * deadline and the same `null`-on-any-failure contract as {@link runPs}.
 *
 * `ps -p <gone-pid>` exits NON-ZERO with empty stdout on macOS, which
 * {@link runPsArgs} maps to `null` — so "gone" and "could not measure" arrive
 * here as the same value. That is why the caller treats a `null` as UNMEASURED
 * and refuses the signal, rather than reading it as proof of death: refusing on
 * an absent measurement costs one skipped reap, believing it costs a bystander.
 *
 * @param {number} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
export function runPsPid(pid, timeoutMs = PS_TIMEOUT_MS) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return runPsArgs(psPidArgs(pid), timeoutMs);
}

/**
 * Spawn `ps` with `args`, capped at `timeoutMs`, `null` on any failure.
 * Never throws. Mirrors `runPsDetailed()` in `resource-probe/probe-platform.mjs`.
 *
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function runPsArgs(args, timeoutMs) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') { resolve(null); return; }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn('ps', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (code !== 0) return finish(null);
        finish(Buffer.concat(chunks).toString('utf8'));
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(null);
      }, timeoutMs);
      timer.unref?.();
    } catch {
      finish(null);
    }
  });
}
