#!/usr/bin/env node
// scripts/session-ledger-census.mjs
//
// Read-only census of `.orchestrator/metrics/sessions.jsonl` (GitLab #1835).
//
// WHY THIS EXISTS:
//   The ledger mixes `completed` records, `closed-without-plan` placeholders and
//   backfilled `abandoned` stubs. Every stub carries placeholder zeros
//   (`total_waves/total_agents/total_files_changed: 0`, listed in
//   `_backfill_incomplete_fields`), so a hand count of `status: 'abandoned'`
//   lumps empty restarts (a start nobody typed into) together with sessions
//   that ran dozens of agents and then died. That hand count reached the owner
//   as "34 abandoned per repo". The only documented rate, the close rate
//   (clean closes / starts), carries every empty restart in its denominator.
//   No plugin reader computed an abort rate; retro/eval/evolve drop all
//   `abandoned` records via `isRealSession`.
//
// WHAT IT DOES:
//   1. Parses sessions.jsonl tolerantly (malformed lines are COUNTED) and
//      canonicalizes it (`canonicalizeSessions`), so a stub superseded by a
//      later record is not counted twice.
//   2. Classifies every canonical `abandoned` stub as empty / conversation /
//      dispatched / unmeasured via `classifyStubWork` — from its own
//      `work_evidence` field when present (source `field`), otherwise by
//      joining the events ledger (source `join`) and running the SAME
//      `workEvidenceFor` gate the backfill writer uses. One classification
//      rule, no second copy of the thresholds.
//   3. Prints the close rate with and without the measured-empty stubs, each
//      with numerator and denominator.
//
// READ-ONLY: writes nothing, emits no event.
//
// USAGE:
//   node scripts/session-ledger-census.mjs [--repo-root <path>] [--json]
//
// EXIT CODES:
//   0  census computed
//   1  input error — unknown/incomplete flag, or no sessions.jsonl at the
//      resolved ledger root (reported as missing, never as 0 records)
//   2  system error — repo root not a directory, sessions.jsonl unreadable

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEventsWithRotations } from './lib/events.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getProjectDir, resolveEventsLedgerRoot } from './lib/platform.mjs';
import { countSkillInvocationsAcrossFiles, isUuid } from './lib/session-close-backfill.mjs';
import { DEFAULT_TTL_HOURS } from './lib/session-lock.mjs';
import { STUB_WORK_CLASSES, classifyStubWork } from './lib/session-schema/filters.mjs';
import { addSkillCalls, countWorkEvent, emptyWorkCounts, FRESH_START_SOURCES, workEvidenceFor } from './lib/session-schema/work-evidence.mjs';
import { DEFAULT_SKILL_INVOCATIONS_PATH, defaultSkillInvocationsPath } from './lib/skill-invocations-schema.mjs';
import { canonicalizeSessions, isMeasuredSession } from './lib/sessions-canonical.mjs';

/**
 * Events-ledger window for the #1401 census (`events-retention-banner.mjs`):
 * `null` — the join reads the whole rotated history back to each stub's own
 * `session.started`; a cut history makes a stub `unmeasured`, never `empty`.
 */
export const REQUIRED_EVENTS_WINDOW_DAYS = null;

const SKILLS_REL = DEFAULT_SKILL_INVOCATIONS_PATH;
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const SESSIONS_REL = join('.orchestrator', 'metrics', 'sessions.jsonl');
const SESSION_STARTED = 'orchestrator.session.started';

/**
 * How far past a session's last surviving event a dated history gap still
 * counts as inside its window. A gap that ate the session's TAIL lies after its
 * last surviving event, so the window cannot end there.
 *
 * CEILING (BV-004): the session-lock TTL — the same age after which the
 * backfill treats a silent session as dead. A session that went silent for
 * longer than that and then resumed, with the resumed part inside a pruned
 * archive, still reads as complete. Revisit if a census `join` class is later
 * contradicted by a recovered archive.
 */
const TAIL_PAD_MS = DEFAULT_TTL_HOURS * 60 * 60 * 1000;

const HELP_TEXT = `session-ledger-census.mjs — what the sessions ledger actually holds (#1835)

USAGE
  node scripts/session-ledger-census.mjs [options]

DESCRIPTION
  Read-only. Counts the canonical records of .orchestrator/metrics/sessions.jsonl
  per status, splits the 'abandoned' stubs by what they measurably did, and
  prints the close rate with and without the empty restarts.

  Stub classes (classifyStubWork):
    empty         measured: no turn stop, no agent stop, no wave completion,
                  no non-lifecycle activity
    conversation  turn stops (incl. legacy session.stopped) or other activity,
                  incl. Skill calls in skill-invocations.jsonl
    dispatched    at least one agent stop or wave completion
    unmeasured    not measurable (history cut, ambiguous id join, platform
                  without turn stops, no session.started, earliest surviving
                  start not a fresh startup/clear, start without native_source,
                  unreadable skill ledger) — NOT zero work

  A stub is classified from its own work_evidence field when present, else by
  joining events.jsonl, its rotated archives and skill-invocations.jsonl. Placeholder total_* zeros are
  never read.

  Rates:
    close_rate_all            measured / all canonical records
    close_rate_without_empty  measured / (all canonical records - empty)
    abort_rate_all            abandoned / all canonical records
    abort_rate_without_empty  (abandoned - empty) / (all canonical records - empty)
  "measured" = isMeasuredSession(): not a backfill stub, not _synthetic, and a
  known session_type or recorded work — status-less legacy closes included.

OPTIONS
  --repo-root <path>   Repo root (default: the resolved project dir). In a
                       linked worktree the ledgers resolve to the main checkout.
  --json               Emit one JSON object on stdout.
  --stubs              Also list every canonical abandoned stub, in ledger
                       order: session_id, raw_session_id (or null), class,
                       source (field|join), reason (or null). JSON: the key
                       abandoned.stubs; human: one line per stub after the
                       totals. Without it the output carries no such key.
  --help, -h           Show this help and exit.
  --version            Print the package version and exit.

EXIT CODES
  0  census computed
  1  input error — unknown/incomplete flag, or no sessions.jsonl at the ledger
     root (reported as missing, never as 0 records)
  2  system error — repo root not a directory, or sessions.jsonl unreadable

EXAMPLES
  node scripts/session-ledger-census.mjs
  node scripts/session-ledger-census.mjs --repo-root ../other-repo --json | jq '.abandoned'
`;

/**
 * Parse argv. Returns `error` instead of throwing, so the caller owns the exit
 * code.
 *
 * @param {string[]} argv
 * @returns {{opts: {repoRoot: string|null, json: boolean, stubs: boolean, help: boolean, version: boolean}, error: string|null}}
 */
export function parseArgs(argv) {
  const opts = { repoRoot: null, json: false, stubs: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--repo-root': {
        const value = argv[i + 1];
        if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
          return { opts, error: `${arg} requires a value` };
        }
        opts.repoRoot = value;
        i += 1;
        break;
      }
      case '--stubs':
        opts.stubs = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
        opts.version = true;
        break;
      default:
        return { opts, error: `unknown flag: ${arg}` };
    }
  }
  return { opts, error: null };
}

/**
 * Tolerant JSONL parse: unreadable lines and non-object values are counted,
 * never silently dropped.
 *
 * @param {string} raw
 * @returns {{records: object[], malformed: number}}
 */
function parseJsonl(raw) {
  const records = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    let value;
    try {
      value = JSON.parse(t);
    } catch {
      malformed += 1;
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      malformed += 1;
      continue;
    }
    records.push(value);
  }
  return { records, malformed };
}

function tsMs(value) {
  if (typeof value !== 'string') return NaN;
  return Date.parse(value);
}

/**
 * ONE pass over the events: per raw uuid the work counts (`countWorkEvent` —
 * the contract decides what counts, incl. the pre-2026-09-06 legacy
 * `session.stopped` and non-lifecycle activity), the platform, timestamp and
 * `native_source` of its EARLIEST `session.started` (ties: first seen), and
 * its last event time; plus the semantic id → uuids bridge from every event
 * carrying `semantic_session_id`.
 *
 * Why the earliest start's `native_source`: when the original start was
 * pruned, a later `compact`/`resume` start survives and would pass as the
 * session's beginning while its first part is gone — and the history reader
 * reports no gap for history it never knew about. `workEvidenceFor` owns the
 * rule (fresh first start only); this function only reports the source.
 *
 * @param {object[]} events
 */
function indexEvents(events) {
  /** @type {Map<string, {counts: ReturnType<typeof emptyWorkCounts>, platform: string|null, startedMs: number|null, firstStartSource: string|null, lastMs: number|null}>} */
  const byUuid = new Map();
  /** @type {Map<string, Set<string>>} */
  const uuidsBySemantic = new Map();
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') continue;
    const uuid = ev.session_id;
    if (typeof uuid !== 'string' || uuid === '') continue;
    if (typeof ev.semantic_session_id === 'string' && ev.semantic_session_id !== '' && isUuid(uuid)) {
      let set = uuidsBySemantic.get(ev.semantic_session_id);
      if (!set) uuidsBySemantic.set(ev.semantic_session_id, (set = new Set()));
      set.add(uuid);
    }
    let entry = byUuid.get(uuid);
    if (!entry) {
      entry = { counts: emptyWorkCounts(), platform: null, startedMs: null, firstStartSource: null, lastMs: null };
      byUuid.set(uuid, entry);
    }
    countWorkEvent(entry.counts, ev.event);
    const ms = tsMs(ev.timestamp);
    if (!Number.isNaN(ms)) entry.lastMs = entry.lastMs === null ? ms : Math.max(entry.lastMs, ms);
    if (ev.event === SESSION_STARTED) {
      if (entry.platform === null && typeof ev.platform === 'string' && ev.platform !== '') entry.platform = ev.platform;
      if (!Number.isNaN(ms) && (entry.startedMs === null || ms < entry.startedMs)) {
        entry.startedMs = ms;
        entry.firstStartSource = typeof ev.native_source === 'string' ? ev.native_source : null;
      }
    }
  }
  return { byUuid, uuidsBySemantic };
}

/**
 * Split the history gaps into those placeable in time and those that are not.
 * A gap is placeable only with BOTH bounds parseable; `ring-hole` and
 * `unreadable-source` carry none.
 *
 * @param {object[]} gaps
 * @returns {{dated: Array<{first: number, last: number}>, undatable: number}}
 */
function splitGaps(gaps) {
  const dated = [];
  let undatable = 0;
  for (const g of Array.isArray(gaps) ? gaps : []) {
    const first = tsMs(g?.first_ts);
    const last = tsMs(g?.last_ts);
    if (Number.isNaN(first) || Number.isNaN(last)) undatable += 1;
    else dated.push({ first, last });
  }
  return { dated, undatable };
}

/**
 * The one uuid a stub joins to, or the reason it cannot.
 *
 * `raw_session_id` when it is a UUID; else `session_id` itself when it is one;
 * else the semantic bridge — which must name EXACTLY ONE uuid (ambiguity
 * ceiling: a semantic id reused across two harness sessions cannot say which
 * one the stub was).
 *
 * @returns {{uuid: string|null, reason: string|null}}
 */
function joinUuid(record, uuidsBySemantic) {
  if (isUuid(record.raw_session_id)) return { uuid: record.raw_session_id, reason: null };
  if (isUuid(record.session_id)) return { uuid: record.session_id, reason: null };
  const set = uuidsBySemantic.get(record.session_id);
  if (!set || set.size === 0) return { uuid: null, reason: 'no-uuid' };
  if (set.size > 1) return { uuid: null, reason: 'ambiguous-uuid' };
  return { uuid: [...set][0], reason: null };
}

/**
 * Classify one canonical `abandoned` stub.
 *
 * @returns {{cls: string, source: 'field'|'join', reason: string|null}}
 */
function classifyStub(record, index, gapInfo, skills) {
  // A well-formed field is the writer's measured decision (classifyStubWork
  // answers 'unmeasured' only when the field is absent or malformed); anything
  // else falls through to the event join.
  const fromField = classifyStubWork(record);
  if (fromField !== 'unmeasured') return { cls: fromField, source: 'field', reason: null };
  const { uuid, reason } = joinUuid(record, index.uuidsBySemantic);
  const entry = uuid === null ? undefined : index.byUuid.get(uuid);
  let complete = false;
  let why = reason;
  if (uuid !== null) {
    if (!entry || entry.startedMs === null) {
      why = 'no-session-started';
    } else if (gapInfo.undatable > 0) {
      // A gap that cannot be placed in time could lie inside ANY session, so
      // every join is incomplete while one exists.
      why = 'history-gap-undatable';
    } else if (!skills.readable) {
      // Skill calls are tool calls the events ledger does not carry; an
      // unreadable skill ledger leaves every session's activity unmeasured.
      why = 'skill-ledger-unreadable';
    } else {
      const end = Math.max(entry.lastMs ?? entry.startedMs, tsMs(record.completed_at) || 0) + TAIL_PAD_MS;
      const cut = gapInfo.dated.some((g) => g.first <= end && g.last >= entry.startedMs);
      if (cut) why = 'history-gap-in-window';
      else complete = true;
    }
  }
  const firstStartSource = entry?.firstStartSource ?? null;
  // Copy: two stubs may join the same uuid, and the index stays events-only.
  const counts = entry ? { ...entry.counts } : undefined;
  if (counts) addSkillCalls(counts, skills.counts.get(uuid));
  const evidence = workEvidenceFor({ platform: entry?.platform ?? null, counts, complete, firstStartSource });
  if (complete && evidence === null) {
    // Name the refusal; workEvidenceFor stays the only decision.
    if (firstStartSource === null) why = 'start-source-unknown';
    else if (!FRESH_START_SOURCES.includes(firstStartSource)) why = 'first-start-not-fresh';
    else why = 'platform-without-turn-stops';
  }
  const cls = classifyStubWork({ status: 'abandoned', ...(evidence !== null ? { work_evidence: evidence } : {}) });
  return { cls, source: 'join', reason: cls === 'unmeasured' ? why : null };
}

function rate(numerator, denominator) {
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : null };
}

/**
 * Run the census. Never throws; never exits; writes nothing.
 *
 * @param {{repoRoot?: string, stubs?: boolean}} [opts] — `stubs` adds the
 *   per-stub list `abandoned.stubs` (opt-in; absent otherwise)
 * @returns {object} result with `exitCode` 0|1|2
 */
export function runCensus({ repoRoot, stubs: listStubs = false } = {}) {
  const root = resolve(repoRoot ?? getProjectDir());
  const base = { exitCode: 2, repo_root: root, ledger_root: null, sessions_path: null, sessions_ledger: null, error: null };
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return { ...base, error: `repo root is not a directory: ${root}` };
    }
  } catch (err) {
    return { ...base, error: `repo root unreadable: ${err?.code ?? String(err)}` };
  }

  // sessions.jsonl and events.jsonl both map unconditionally to the main
  // checkout from a linked worktree (#1514 / #1584) — the same resolver the
  // backfill and check-sessions-integrity use.
  const ledgerRoot = resolveEventsLedgerRoot(root);
  const sessionsPath = join(resolveEventsLedgerRoot(root), SESSIONS_REL);
  const located = { ...base, ledger_root: ledgerRoot, sessions_path: sessionsPath };
  if (!existsSync(sessionsPath)) {
    return { ...located, exitCode: 1, sessions_ledger: 'missing', error: `no sessions ledger at ${sessionsPath}` };
  }
  let raw;
  try {
    raw = readFileSync(sessionsPath, 'utf8');
  } catch (err) {
    return { ...located, sessions_ledger: 'unreadable', error: `cannot read ${sessionsPath}: ${err?.code ?? String(err)}` };
  }

  const { records: parsed, malformed } = parseJsonl(raw);
  const withoutId = parsed.filter((r) => typeof r.session_id !== 'string' || r.session_id === '').length;
  // canonicalizeSessions collapses to one record per physical session:
  // newest-wins per session_id (a later stub never shadows a real record),
  // the backfill double-stub pair (equal started_at+completed_at, both
  // abandoned) to its non-synthetic member, an attestable `supersedes: X`
  // removes X, and a stub sharing raw_session_id with a real record is
  // dropped. It KEEPS every surviving abandoned stub (filtering them is not
  // its job) and drops id-less records — counted above as records_without_id.
  const canonical = canonicalizeSessions(parsed);

  const statusCounts = { completed: 0, 'closed-without-plan': 0, abandoned: 0, other: {}, absent: 0 };
  const stubs = [];
  for (const rec of canonical) {
    const s = rec.status;
    if (s === undefined || s === null) statusCounts.absent += 1;
    else if (s === 'completed' || s === 'closed-without-plan' || s === 'abandoned') statusCounts[s] += 1;
    else statusCounts.other[String(s)] = (statusCounts.other[String(s)] ?? 0) + 1;
    if (s === 'abandoned') stubs.push(rec);
  }

  const ev = readEventsWithRotations(ledgerRoot);
  const index = indexEvents(ev.events);
  const gapInfo = splitGaps(ev.gaps);
  // Read ONCE per root: the ledger root of sessions/events and, from a linked
  // worktree, the given root too — the skill hook stays in a worktree whose
  // repo does not git-ignore the ledger (the writer's `skillCallsFor` reads the
  // same two). A tracked ledger can hold the same row in both, so rows are
  // merged by content, not summed (#1841, ceiling at the helper). A missing
  // file is a readable zero. Ceiling (#1726 family): skill files of OTHER
  // worktrees are not read.
  const skillPaths = [...new Set([defaultSkillInvocationsPath(ledgerRoot), join(root, SKILLS_REL)])];
  const skills = countSkillInvocationsAcrossFiles(skillPaths, readFileSync);
  const skillLedger = !skills.readable ? 'unreadable' : skillPaths.some((p) => existsSync(p)) ? 'read' : 'missing';

  const classes = Object.fromEntries(STUB_WORK_CLASSES.map((c) => [c, { total: 0, field: 0, join: 0 }]));
  const unmeasuredReasons = {};
  const stubList = [];
  for (const rec of stubs) {
    const { cls, source, reason } = classifyStub(rec, index, gapInfo, skills);
    if (listStubs) {
      stubList.push({
        session_id: rec.session_id,
        raw_session_id: typeof rec.raw_session_id === 'string' ? rec.raw_session_id : null,
        class: cls,
        source,
        reason,
      });
    }
    classes[cls].total += 1;
    classes[cls][source] += 1;
    if (cls === 'unmeasured') {
      const key = reason ?? 'unknown';
      unmeasuredReasons[key] = (unmeasuredReasons[key] ?? 0) + 1;
    }
  }

  const total = canonical.length;
  const empty = classes.empty.total;
  // The close numerator is isMeasuredSession (sessions-canonical.mjs), the one
  // predicate its JSDoc names for "close rate" — NOT status === 'completed':
  // legacy records carry no status at all (179 of 589 canonical records in this
  // repo, 2026-10-27), and most of them ran waves.
  const measured = canonical.filter(isMeasuredSession).length;
  return {
    ...located,
    exitCode: 0,
    measured_sessions: measured,
    sessions_ledger: 'read',
    records: {
      parsed: parsed.length,
      malformed_lines: malformed,
      records_without_id: withoutId,
      canonical: total,
    },
    status: statusCounts,
    abandoned: {
      total: stubs.length,
      classes,
      unmeasured_reasons: unmeasuredReasons,
      ...(listStubs ? { stubs: stubList } : {}),
    },
    skill_ledger: skillLedger,
    events: {
      complete: ev.complete,
      sources: ev.sources.length,
      malformed_lines: ev.malformed_lines,
      gaps: ev.gaps.length,
      gaps_dated: gapInfo.dated.length,
      gaps_undatable: gapInfo.undatable,
    },
    rates: {
      close_rate_all: rate(measured, total),
      close_rate_without_empty: rate(measured, total - empty),
      abort_rate_all: rate(stubs.length, total),
      abort_rate_without_empty: rate(stubs.length - empty, total - empty),
    },
  };
}

function pct(r) {
  return r.value === null ? 'n/a' : `${(r.value * 100).toFixed(1)} %`;
}

function renderHuman(r) {
  const L = [];
  L.push('Session ledger census (#1835) — read-only');
  L.push(`  ledger:            ${r.sessions_path}`);
  L.push(`  lines parsed:      ${r.records.parsed} (malformed: ${r.records.malformed_lines}, without session_id: ${r.records.records_without_id})`);
  L.push(`  canonical records: ${r.records.canonical} (measured sessions, the close numerator: ${r.measured_sessions})`);
  L.push(`    completed:           ${r.status.completed}`);
  L.push(`    closed-without-plan: ${r.status['closed-without-plan']}`);
  L.push(`    abandoned:           ${r.status.abandoned}`);
  for (const [s, n] of Object.entries(r.status.other)) L.push(`    ${s}: ${n}`);
  L.push(`    (no status):         ${r.status.absent}`);
  L.push('  abandoned stubs by what they measurably did:');
  for (const c of STUB_WORK_CLASSES) {
    const x = r.abandoned.classes[c];
    L.push(`    ${c.padEnd(13)} ${String(x.total).padStart(5)}  (field ${x.field}, join ${x.join})`);
  }
  const reasons = Object.entries(r.abandoned.unmeasured_reasons);
  if (reasons.length > 0) L.push(`    unmeasured because: ${reasons.map(([k, n]) => `${k} ${n}`).join(', ')}`);
  L.push('    note: unmeasured is NOT zero work — nobody could measure it.');
  const e = r.events;
  L.push(`  skill ledger:      ${r.skill_ledger}`);
  L.push(`  events history:    complete=${e.complete} sources=${e.sources} gaps=${e.gaps} (dated ${e.gaps_dated}, undatable ${e.gaps_undatable}) malformed=${e.malformed_lines}`);
  const a = r.rates.close_rate_all;
  const b = r.rates.close_rate_without_empty;
  L.push(`  close rate (all records):         ${a.numerator} / ${a.denominator} = ${pct(a)}`);
  L.push(`  close rate (without empty stubs): ${b.numerator} / ${b.denominator} = ${pct(b)}`);
  const c = r.rates.abort_rate_all;
  const d = r.rates.abort_rate_without_empty;
  L.push(`  abort rate (all records):         ${c.numerator} / ${c.denominator} = ${pct(c)}`);
  L.push(`  abort rate (without empty stubs): ${d.numerator} / ${d.denominator} = ${pct(d)}`);
  // Per-stub list last, so hundreds of lines never bury the rates above.
  if (Array.isArray(r.abandoned.stubs)) {
    L.push('  stubs (ledger order):');
    for (const x of r.abandoned.stubs) {
      L.push(`    ${x.session_id}  raw=${x.raw_session_id ?? '-'}  ${x.class} (${x.source}${x.reason ? `, ${x.reason}` : ''})`);
    }
  }
  return L.join('\n') + '\n';
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
    process.stderr.write(`[session-ledger-census] ${error}\nRun with --help for usage.\n`);
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
  const repoRootArg =
    opts.repoRoot === null ? undefined : isAbsolute(opts.repoRoot) ? opts.repoRoot : resolve(process.cwd(), opts.repoRoot);
  const result = runCensus({ repoRoot: repoRootArg, stubs: opts.stubs });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.exitCode === 0) {
    process.stdout.write(renderHuman(result));
  }
  if (result.error) process.stderr.write(`[session-ledger-census] ${result.error}\n`);
  process.exit(result.exitCode);
}
