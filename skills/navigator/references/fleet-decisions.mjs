/**
 * skills/navigator/references/fleet-decisions.mjs
 *
 * Pure decision functions for the navigator's headless fleet: whether a new
 * headless run may start on this host (slot gate), whether a target repo is
 * already occupied by another session (busy gate), and which account the host
 * should run on (account watch).
 *
 * Measurement lives elsewhere — `slot-check.sh` and `account-check.sh` in this
 * directory collect the raw numbers and pipe them in here. This module reads
 * no environment variables, no files and no clock except the `now` argument,
 * so every rule below is testable with plain values.
 *
 * Shared principle: a value that could not be measured is never read as
 * "free". Every gate fails closed on missing, NaN or non-number input; only
 * an explicit `override: true` (an owner decision) bypasses a gate.
 *
 * Slot gate thresholds (free memory % from the OS pressure verdict):
 *   free >= 50  → cap 4
 *   free >= 35  → cap 3
 *   otherwise   → cap 0
 *   load1 > 40  → cap 0 regardless of memory
 *   allowed     = runs < cap
 *
 * Busy gate: busy when any Codex rollout for the repo is younger than 30 min
 * or any `session.lock` is younger than 6 h (counts measured by the caller).
 *
 * Account watch: usable = 5-hour and 7-day usage both below 97 %. Among usable
 * rows the earliest 7-day reset within 3 days wins (tie-break lower 7-day
 * usage); if none is that near, the lowest 7-day usage wins. The active row is
 * kept when its reset lies within 1800 s of the target's, either side (same
 * reset, no flapping). A reset date in the past is stale data and the row is
 * skipped. Rows are identified by `slot` only — the alias never reaches the
 * output (SEC-008).
 *
 * CLI: `node fleet-decisions.mjs slot|busy|account` reads one JSON document
 * from stdin and prints the decision as one JSON line.
 *   exit 0 — allowed / not busy / stay or switch
 *   exit 1 — refused / busy / no usable account
 *   exit 2 — unparseable input or unknown subcommand
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FREE_PCT_CAP4 = 50;
const FREE_PCT_CAP3 = 35;
const LOAD1_MAX = 40;
const USAGE_LIMIT_PCT = 97;
const NEAR_RESET_MS = 3 * 24 * 60 * 60 * 1000;
const RESET_TIE_MS = 1800 * 1000;

/** @param {unknown} v @returns {v is number} */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Slot gate
// ---------------------------------------------------------------------------

/**
 * Decide whether one more headless run may start on this host.
 *
 * @param {{ freePct?: unknown, load1?: unknown, runs?: unknown, override?: unknown }} input
 * @returns {{ allowed: boolean, cap: number, reason: string }}
 */
export function slotDecision({ freePct, load1, runs, override } = {}) {
  const memOk = isNum(freePct);
  const loadOk = isNum(load1);
  let cap = 0;
  if (memOk && loadOk) {
    if (freePct >= FREE_PCT_CAP4) cap = 4;
    else if (freePct >= FREE_PCT_CAP3) cap = 3;
    if (load1 > LOAD1_MAX) cap = 0;
  }
  if (override === true) return { allowed: true, cap, reason: 'override' };

  const ctx = `(free ${memOk ? `${freePct}%` : '?'}, load1 ${loadOk ? load1 : '?'})`;
  if (!memOk) return { allowed: false, cap: 0, reason: `no slot: free memory not measurable ${ctx}` };
  if (!loadOk) return { allowed: false, cap: 0, reason: `no slot: load1 not measurable ${ctx}` };
  if (!isNum(runs) || !Number.isInteger(runs) || runs < 0) {
    return { allowed: false, cap, reason: `no slot: run count not measurable ${ctx}` };
  }
  const allowed = runs < cap;
  return { allowed, cap, reason: `${allowed ? 'slot free' : 'no slot'}: ${runs} runs, cap ${cap} ${ctx}` };
}

// ---------------------------------------------------------------------------
// Busy gate
// ---------------------------------------------------------------------------

/**
 * Decide whether a repo is occupied by another session.
 *
 * @param {{ codexRolloutsFresh?: unknown, lockFresh?: unknown, override?: unknown }} input
 * @returns {{ busy: boolean, reason: string }}
 */
export function busyDecision({ codexRolloutsFresh, lockFresh, override } = {}) {
  if (override === true) return { busy: false, reason: 'override' };
  const valid = (v) => isNum(v) && v >= 0;
  if (!valid(codexRolloutsFresh) || !valid(lockFresh)) {
    return { busy: true, reason: 'busy: occupancy not measurable (codex rollouts or session.lock count missing)' };
  }
  const counts = `${codexRolloutsFresh} codex rollouts (30 min), ${lockFresh} session.lock (6 h)`;
  if (codexRolloutsFresh > 0 || lockFresh > 0) return { busy: true, reason: `busy: ${counts}` };
  return { busy: false, reason: `free: ${counts}` };
}

// ---------------------------------------------------------------------------
// Account watch
// ---------------------------------------------------------------------------

/**
 * Reduce one raw account row to the fields the decision needs, or null when it
 * is not measurable. Copies nothing else — in particular not the alias. Never
 * throws: a hostile row (throwing getter, proxy) counts as not measurable.
 *
 * @param {unknown} r
 * @param {number} nowMs
 * @returns {{ id: string|number, active: boolean, p7: number, p5: number, resetMs: number } | null}
 */
function parseAccountRow(r, nowMs) {
  try {
    if (!r || typeof r !== 'object') return null;
    const { slot, active, p7, p5, resetAt } = /** @type {Record<string, unknown>} */ (r);
    const slotOk = (typeof slot === 'string' && slot !== '') || isNum(slot);
    const resetMs = typeof resetAt === 'string' ? Date.parse(resetAt) : NaN;
    if (!slotOk || !isNum(p7) || !isNum(p5) || !Number.isFinite(resetMs) || resetMs < nowMs) return null;
    return { id: /** @type {string|number} */ (slot), active: active === true, p7, p5, resetMs };
  } catch {
    return null;
  }
}

/**
 * Pick the account the host should run on. Never throws; malformed rows
 * (non-string/non-number slot, missing usage, unparseable or past reset) are
 * skipped and counted in the reason. The output carries the slot only, never
 * the alias (SEC-008).
 *
 * @param {Array<{ slot: unknown, alias?: string, active: boolean, p7: number|null, p5: number|null, resetAt: string|null }>} rows
 * @param {Date|number} now
 * @returns {{ action: 'stay'|'switch'|'none', target: string|number|null, reason: string }}
 */
export function chooseAccount(rows, now) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return { action: 'none', target: null, reason: 'no decision: now is not a valid time' };
  const list = Array.isArray(rows) ? rows : [];

  let skipped = 0;
  const parsed = [];
  for (const r of list) {
    const row = parseAccountRow(r, nowMs);
    if (row === null) skipped += 1;
    else parsed.push(row);
  }
  const skipNote = skipped > 0 ? `; ${skipped} row(s) skipped without data` : '';

  const usable = parsed.filter((r) => r.p5 < USAGE_LIMIT_PCT && r.p7 < USAGE_LIMIT_PCT);
  const active = parsed.find((r) => r.active === true) ?? null;
  const activeUsable = active !== null && usable.includes(active);

  if (usable.length === 0) {
    return { action: 'none', target: null, reason: `no usable account (all >= ${USAGE_LIMIT_PCT}% or without data)${skipNote}` };
  }

  const near = usable.filter((r) => r.resetMs - nowMs <= NEAR_RESET_MS);
  let target;
  if (near.length > 0) {
    target = near.reduce((a, b) => (b.resetMs < a.resetMs || (b.resetMs === a.resetMs && b.p7 < a.p7) ? b : a));
  } else {
    target = usable.reduce((a, b) => (b.p7 < a.p7 ? b : a));
  }

  if (activeUsable && active !== target && Math.abs(active.resetMs - target.resetMs) <= RESET_TIE_MS) {
    target = active;
  }

  const desc = (r) => `${r.id} (7d ${r.p7}%, reset in ${((r.resetMs - nowMs) / 86400000).toFixed(1)} d)`;
  if (active === target) return { action: 'stay', target: target.id, reason: `stay on ${desc(target)}${skipNote}` };
  return {
    action: 'switch',
    target: target.id,
    reason: `switch ${active ? active.id : '-'} -> ${desc(target)}${skipNote}`,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runCli(argv) {
  const mode = argv[2];
  if (mode !== 'slot' && mode !== 'busy' && mode !== 'account') {
    process.stderr.write('usage: node fleet-decisions.mjs slot|busy|account < input.json\n');
    return 2;
  }
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('fleet-decisions: stdin is not valid JSON\n');
    return 2;
  }
  if (mode === 'slot' || mode === 'busy') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      process.stderr.write(`fleet-decisions: ${mode} expects one JSON object\n`);
      return 2;
    }
    const d = mode === 'slot' ? slotDecision(input) : busyDecision(input);
    process.stdout.write(`${JSON.stringify(d)}\n`);
    return mode === 'slot' ? (d.allowed ? 0 : 1) : d.busy ? 1 : 0;
  }
  const rows = Array.isArray(input) ? input : input && Array.isArray(input.accounts) ? input.accounts : null;
  if (!rows) {
    process.stderr.write('fleet-decisions: account expects a JSON array or {"accounts": [...]}\n');
    return 2;
  }
  const d = chooseAccount(rows, Date.now());
  process.stdout.write(`${JSON.stringify(d)}\n`);
  return d.action === 'none' ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv);
}
