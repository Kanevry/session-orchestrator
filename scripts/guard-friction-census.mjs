#!/usr/bin/env node
// scripts/guard-friction-census.mjs
//
// Read-only census of the destructive-guard events (GitLab #2090, Fertig-wenn 2).
//
// WHY THIS EXISTS:
//   #2090 sets the default hook profile "from measurement, not from feeling":
//   rules whose denials mostly hit temp targets move to warn by default. Since
//   !427 every `orchestrator.destructive_guard.blocked|warned` event carries
//   `case`, `target_class` and `rule_class`. Events written before that carry
//   none of the three. A hand count over events.jsonl puts both kinds into one
//   denominator, so every share is diluted by records that never measured the
//   thing (the class "a missing measurement looks like zero"). This census keeps
//   them apart and prints every share with numerator and denominator.
//
// WHAT IT DOES:
//   1. Reads the rotated events ledger of each `--repo-root` (archives + active,
//      `readEventsWithRotations`); malformed lines and ledger gaps are COUNTED.
//   2. Keeps guard events inside the window (`--days`, default 14). Undatable
//      and future-dated records are counted, never silently dropped.
//   3. Splits them three ways: `measured` (all three fields valid), `invalid`
//      (some field present but outside its closed set), `unmeasured` (none —
//      written before the fields existed). Only `measured` enters the shares.
//   4. Per rule: denials, of those the ones measured `recoverable` (the cases
//      profile `relaxed` softens to a warning), warnings, and the target-class
//      split with the temp share as numerator/denominator over the targets
//      the guard could classify (`unknown` is reported beside it).
//
// READ-ONLY: writes nothing, emits no event.
//
// EXIT CODES:
//   0  census computed (also when the window holds no guard event)
//   1  input error — unknown/incomplete flag, bad --days, or no events ledger
//      at any resolved root (reported as missing, never as 0 events)
//   2  system error — a repo root is not a directory

import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEventsWithRotations } from './lib/events.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getProjectDir, resolveEventsLedgerRoot } from './lib/platform.mjs';

/**
 * Events-ledger window for `events-retention-banner.mjs` (#1401): `null`. The
 * window is the caller's `--days`, and the census judges its own coverage per
 * ledger (`covers_window`, oldest retained event vs. window start) plus the
 * rotation gaps — so a ledger that keeps less than the window shows up in the
 * census output itself.
 *
 * CEILING (BV-004): declaring 14 here would raise the fleet-wide session-start
 * retention banner from 7 to 14 days for every repo, unmeasured (HR-101).
 * Revisit when the #2090 default decision is due and the census reports
 * `covers_window: false` for a ledger it needs.
 */
export const REQUIRED_EVENTS_WINDOW_DAYS = null;

/** Default census window: the two weeks #2090 measures before choosing the default. */
export const DEFAULT_WINDOW_DAYS = 14;

export const GUARD_EVENTS = Object.freeze({
  blocked: 'orchestrator.destructive_guard.blocked',
  warned: 'orchestrator.destructive_guard.warned',
});

/** Closed sets, identical to the guard's (`hooks/pre-bash-destructive-guard.mjs` TARGET_CLASSES / RULE_CLASS_VALUES). */
export const TARGET_CLASSES = Object.freeze(['temp', 'own-worktree', 'protected-file', 'outside-repo', 'unknown']);
export const RULE_CLASSES = Object.freeze(['irreversible', 'recoverable']);

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

const HELP_TEXT = `guard-friction-census — how often the destructive guard denied or warned, and at what (#2090)

USAGE:
  node scripts/guard-friction-census.mjs [--repo-root <path>]... [--days <n>] [--json]

OPTIONS:
  --repo-root <path>   Repo whose events ledger is read; repeat for several repos.
                       A linked worktree resolves to its main checkout's ledger.
                       Default: the current project.
  --days <n>           Window in days back from now (integer 1..3650, default 14).
                       Per ledger, covers_window says whether its oldest retained
                       event reaches back to the window start.
  --json               Emit one JSON object on stdout.
  --help               This text.
  --version            Plugin version.

Only events carrying case, target_class and rule_class (written since !427)
enter the shares; older ones are counted as "unmeasured".

EXIT CODES:
  0 census computed · 1 input error or no events ledger at any root · 2 repo root not a directory

EXAMPLE:
  node scripts/guard-friction-census.mjs --repo-root ~/Projects/a --repo-root ~/Projects/b --json | jq '.rules'
`;

/**
 * Parse argv. Returns `error` instead of throwing, so the caller owns the exit.
 *
 * @param {string[]} argv
 * @returns {{ opts: { repoRoots: string[], days: number, json: boolean, help: boolean, version: boolean }, error: string|null }}
 */
export function parseArgs(argv) {
  const opts = { repoRoots: [], days: DEFAULT_WINDOW_DAYS, json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--repo-root': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--') || value.trim() === '') return { opts, error: '--repo-root needs a path' };
        opts.repoRoots.push(value);
        i++;
        break;
      }
      case '--days': {
        const value = argv[i + 1];
        if (value === undefined || !/^[0-9]+$/.test(value)) return { opts, error: '--days needs a whole number' };
        const n = Number(value);
        if (n < 1 || n > 3650) return { opts, error: '--days must be between 1 and 3650' };
        opts.days = n;
        i++;
        break;
      }
      case '--json': opts.json = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--version': opts.version = true; break;
      default: return { opts, error: `unknown flag: ${arg}` };
    }
  }
  return { opts, error: null };
}

/**
 * Measurement state of one guard event.
 *
 * @param {object} ev
 * @returns {'measured'|'invalid'|'unmeasured'}
 */
export function measurementState(ev) {
  const has = ['case', 'target_class', 'rule_class'].filter((k) => ev[k] !== undefined);
  if (has.length === 0) return 'unmeasured';
  const valid = typeof ev.case === 'string' && ev.case.length > 0
    && TARGET_CLASSES.includes(ev.target_class)
    && RULE_CLASSES.includes(ev.rule_class);
  return valid ? 'measured' : 'invalid';
}

function emptyRule() {
  return {
    blocked: 0,
    blocked_recoverable: 0,
    warned: 0,
    target_classes: Object.fromEntries(TARGET_CLASSES.map((c) => [c, 0])),
    cases: {},
  };
}

/**
 * Pure aggregation over already-read events. No I/O.
 *
 * @param {object[]} events
 * @param {{ sinceMs: number, untilMs: number }} window
 */
export function summarizeGuardEvents(events, { sinceMs, untilMs }) {
  const totals = { guard_events: 0, measured: 0, invalid: 0, unmeasured: 0, undated: 0, future: 0 };
  /** @type {Record<string, ReturnType<typeof emptyRule>>} */
  const rules = {};
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') continue;
    const kind = ev.event === GUARD_EVENTS.blocked ? 'blocked' : ev.event === GUARD_EVENTS.warned ? 'warned' : null;
    if (kind === null) continue;
    const ts = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
    if (!Number.isFinite(ts)) { totals.undated++; continue; }
    if (ts > untilMs) { totals.future++; continue; }
    if (ts < sinceMs) continue;
    totals.guard_events++;
    const state = measurementState(ev);
    totals[state]++;
    if (state !== 'measured') continue;
    const ruleId = typeof ev.rule === 'string' && ev.rule.length > 0 ? ev.rule : '(no rule)';
    const r = (rules[ruleId] ??= emptyRule());
    r[kind]++;
    if (kind === 'blocked' && ev.rule_class === 'recoverable') r.blocked_recoverable++;
    r.target_classes[ev.target_class]++;
    r.cases[ev.case] = (r.cases[ev.case] ?? 0) + 1;
  }
  for (const r of Object.values(rules)) {
    // `unknown` means the guard could not classify the target: it is no
    // evidence for "not temp", so it stays out of the denominator and is
    // reported beside the share instead (review MED, 2026-11-15).
    const known = r.blocked + r.warned - r.target_classes.unknown;
    r.temp_share = { numerator: r.target_classes.temp, denominator: known, unknown_target: r.target_classes.unknown };
  }
  return { totals, rules };
}

/**
 * Read every root's ledger and aggregate. Never throws.
 *
 * @param {{ repoRoots?: string[], days?: number, now?: number }} [opts]
 */
export function runCensus({ repoRoots = [], days = DEFAULT_WINDOW_DAYS, now = Date.now() } = {}) {
  const untilMs = now;
  const sinceMs = now - days * DAY_MS;
  const window = { days, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() };
  const roots = repoRoots.length > 0 ? repoRoots : [getProjectDir()];

  const ledgerRoots = [];
  for (const root of roots) {
    try {
      if (!statSync(root).isDirectory()) return { exitCode: 2, error: `repo root is not a directory: ${root}`, window };
    } catch {
      return { exitCode: 2, error: `repo root is not a directory: ${root}`, window };
    }
    const ledgerRoot = resolveEventsLedgerRoot(root);
    if (!ledgerRoots.includes(ledgerRoot)) ledgerRoots.push(ledgerRoot);
  }

  const sources = [];
  const all = [];
  for (const ledgerRoot of ledgerRoots) {
    const ev = readEventsWithRotations(ledgerRoot);
    const found = ev.sources.length > 0;
    const firsts = ev.sources.map((s) => (s.first_ts ? Date.parse(s.first_ts) : NaN)).filter(Number.isFinite);
    const oldest = firsts.length > 0 ? Math.min(...firsts) : null;
    sources.push({
      ledger_root: ledgerRoot,
      found,
      complete: found ? ev.complete : null,
      gaps: ev.gaps.length,
      malformed_lines: ev.malformed_lines,
      oldest_event_at: oldest === null ? null : new Date(oldest).toISOString(),
      // null = no dated record at all: coverage not measured, never "covered".
      covers_window: oldest === null ? null : oldest <= sinceMs,
    });
    if (found) all.push(...ev.events);
  }
  const missing = sources.filter((s) => !s.found).map((s) => s.ledger_root);
  if (missing.length === sources.length) {
    return { exitCode: 1, error: `no events ledger at: ${missing.join(', ')}`, window, sources };
  }

  const { totals, rules } = summarizeGuardEvents(all, { sinceMs, untilMs });
  totals.malformed_lines = sources.reduce((n, s) => n + s.malformed_lines, 0);
  // complete: true only when every found ledger proved itself complete; a
  // missing ledger among several makes the fleet figure partial too.
  const complete = missing.length > 0 || sources.some((s) => s.found && s.complete === false)
    ? false
    : sources.every((s) => s.complete === true) ? true : null;
  return { exitCode: 0, error: null, window, sources, missing, complete, totals, rules };
}

function pct(numerator, denominator) {
  return denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(1)} %`;
}

export function renderHuman(result) {
  const t = result.totals;
  const lines = [
    `guard-friction-census — ${result.window.since} .. ${result.window.until} (${result.window.days} d)`,
    `ledgers: ${result.sources.filter((s) => s.found).length} read, ${result.missing.length} missing, ${result.sources.filter((s) => s.covers_window === false).length} not reaching back to the window start; complete: ${result.complete === null ? 'not measured' : result.complete}; malformed lines: ${t.malformed_lines}`,
    `guard events in window: ${t.guard_events} — measured ${t.measured} (${pct(t.measured, t.guard_events)}), unmeasured ${t.unmeasured} (written before !427), invalid fields ${t.invalid}; undated ${t.undated}, future-dated ${t.future} (outside every window)`,
  ];
  const ids = Object.keys(result.rules).sort((a, b) => {
    const ra = result.rules[a]; const rb = result.rules[b];
    return (rb.blocked + rb.warned) - (ra.blocked + ra.warned) || (a < b ? -1 : 1);
  });
  if (ids.length === 0) {
    lines.push('no measured guard event in this window — no share can be computed yet.');
  } else {
    lines.push('', 'rule | denied | denied recoverable (relaxed would warn) | warned | temp share of classified targets | unclassified targets');
    for (const id of ids) {
      const r = result.rules[id];
      lines.push(`${id} | ${r.blocked} | ${r.blocked_recoverable}/${r.blocked} (${pct(r.blocked_recoverable, r.blocked)}) | ${r.warned} | ${r.temp_share.numerator}/${r.temp_share.denominator} (${pct(r.temp_share.numerator, r.temp_share.denominator)}) | ${r.temp_share.unknown_target}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(SELF_DIR, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

if (isMainModule(import.meta.url)) {
  const { opts, error } = parseArgs(process.argv.slice(2));
  if (error !== null) {
    process.stderr.write(`[guard-friction-census] ${error}\nRun with --help for usage.\n`);
    process.exit(1);
  }
  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  if (opts.version) {
    process.stdout.write(`${readVersion()}\n`);
    process.exit(0);
  }
  const repoRoots = opts.repoRoots.map((p) => (isAbsolute(p) ? p : resolve(process.cwd(), p)));
  const result = runCensus({ repoRoots, days: opts.days });
  if (opts.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.exitCode === 0) process.stdout.write(renderHuman(result));
  if (result.error) process.stderr.write(`[guard-friction-census] ${result.error}\n`);
  if (result.exitCode === 0 && result.sources.some((s) => !s.found)) {
    process.stderr.write(`[guard-friction-census] no events ledger at: ${result.missing.join(', ')} — figures cover the other ledgers only\n`);
  }
  process.exit(result.exitCode);
}
