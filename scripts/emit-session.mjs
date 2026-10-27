#!/usr/bin/env node
/**
 * emit-session.mjs — validating writer for session JSONL entries.
 *
 * Issue #249 follow-up. The gate that session-end Phase 3.7 invokes to append
 * a single session record to `.orchestrator/metrics/sessions.jsonl` (or any
 * target path). Replaces the raw shell `>>` append with a validated path:
 *
 *   node scripts/emit-session.mjs [--file PATH] [--entry JSON] [--session-uuid ID]
 *
 * Input modes:
 *   --entry '<json>'   pass the entry JSON literally (for shell pipelines)
 *   (stdin)            read the entry JSON from stdin (default when no --entry)
 *
 *   --session-uuid ID  this session's raw harness UUID (overrides the
 *                      current-session.json lookup; the test seam)
 *
 * Defaults:
 *   --file .orchestrator/metrics/sessions.jsonl
 *
 * Exit codes:
 *   0 — validated and appended
 *   1 — validation failed (see stderr for reason); file not touched
 *   2 — I/O / parse error (non-JSON input, unwritable path)
 *
 * On success the script echoes a single JSON line to stdout:
 *   {"action":"appended","path":"<file>","session_id":"<id>","schema_version":2}
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { explainEventsLedgerRoot, resolveEventsLedgerRoot } from './lib/platform.mjs';
import { appendJsonl } from './lib/common.mjs';
import { resolveLedgerPath } from './lib/ledger-path.mjs';
import {
  MEMORY_CLEANUP_EVENT,
  deriveMemoryCleanupSignal,
  stampMemoryCleanup,
} from './lib/memory-cleanup-stamp.mjs';
import { parseStateMd, readOutcome, readSessionProfile } from './lib/state-md.mjs';
import { resolveStateMdWriteTarget, warnForeignStateMd } from './lib/state-md/frontmatter-mutators.mjs';
import { readProcessLocalSessionIds } from './lib/session-identity/own-session.mjs';
import { readSessionWorkTrees } from './lib/session-work-trees.mjs';
import { rollupSessionTokens } from './lib/session-token-rollup.mjs';
import { COST_BASIS, PRICING_TABLE_DATE } from './lib/telemetry/pricing.mjs';
import { serializeSessionLineChecked } from './lib/session-schema/serializer.mjs';
import { OUTCOME_OBSERVED_VALUES, OUTCOME_SOURCES } from './lib/session-schema/constants.mjs';
import {
  validateSession,
  ValidationError,
  CURRENT_SESSION_SCHEMA_VERSION,
  clampTimestampsMonotonic,
  aliasLegacyEndedAt,
  normalizeWaveKeys,
} from './lib/session-schema.mjs';
import { stableHostname } from './lib/host-identity.mjs';
import { activeDir } from './lib/session-registry.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

/**
 * The events ledger beside `sessionsFile` — mapped to the main checkout when the
 * metrics dir sits in a LINKED git worktree (#1514 point 1: one ledger per repo,
 * the one the hooks write). Identity everywhere else, including a tmp fixture.
 *
 * @param {string} sessionsFile
 * @returns {string}
 */
function siblingEventsFile(sessionsFile) {
  return join(resolveEventsLedgerRoot(dirname(sessionsFile)), 'events.jsonl');
}

export { serializeSessionLineChecked };

// A FULL object name only (SHA-1 or SHA-256 repo). A short sha or a symbolic
// ref (`HEAD`, a branch) would resolve to a DIFFERENT commit when read later.
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** @param {unknown} v @returns {boolean} true for a non-null, non-array object. */
function isPlainRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * True when `v` carries the full STATEMENT half of an outcome (#1824): non-empty
 * `statement` and `observable` and a `source` from OUTCOME_SOURCES. `observed`
 * is not part of the test — it is defaulted or validated separately.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function hasOutcomeStatement(v) {
  return (
    isPlainRecord(v) &&
    typeof v.statement === 'string' && v.statement.length > 0 &&
    typeof v.observable === 'string' && v.observable.length > 0 &&
    OUTCOME_SOURCES.includes(v.source)
  );
}

// Rollup fields merged into the record (#1436) — the totals plus the #1244
// cache buckets and contract marker the former prose recipe merged, and the
// #1475 cost-coverage counters, which say why `total_cost_usd` is absent when
// priced < total. `legacy_v1_records` stays in the rollup's own return value.
const ROLLUP_KEYS = Object.freeze([
  'total_tokens',
  'total_token_input',
  'total_token_output',
  'total_token_input_uncached',
  'total_token_cache_read',
  'total_token_cache_creation',
  'total_cost_usd',
  'subagents_with_tokens',
  'matched_records',
  'cost_records_priced',
  'cost_records_total',
  '_token_schema',
]);

// Rollup keys validateSession() requires to be non-negative integers.
const INTEGER_ROLLUP_KEYS = new Set([
  'total_tokens',
  'matched_records',
  'cost_records_priced',
  'cost_records_total',
]);

/**
 * Resolve THIS session's raw harness UUID — the join key `subagents.jsonl`
 * (`parent_session_id`) and `events.jsonl` (`session_id`) carry, which the
 * record itself does not (its `session_id` is the semantic slug).
 *
 * `--session-uuid` wins (an explicit assertion, and the test seam). Otherwise
 * `.orchestrator/current-session.json` is read. That file is SHARED by the
 * working copy — the last SessionStart hook wrote it — so its UUID is adopted
 * ONLY when its `semantic_session_id` (or, for a legacy raw-id record, its
 * `session_id`) equals this record's `session_id`: the same "named owner
 * equals the record" gate as the STATE.md derivation in main(). When this
 * process carries its own session id (`readProcessLocalSessionIds()` — the
 * harness env, which a dispatched subagent inherits from the coordinator), that
 * witness OUTRANKS the shared marker: a marker UUID the process does not carry
 * was written by a peer and is refused even when the labels agree (two sessions
 * can mint the same semantic label, #1066). Ranked, never unioned
 * (.claude/rules/identity-and-locks.md). When the marker proves nothing
 * (absent, or foreign), the process-local id is adopted alone if the events
 * ledger shows it carrying this record's label (#1773, processIdCarryingLabel).
 * Otherwise a foreign marker is WARNed and yields null; an absent marker yields
 * null silently.
 *
 * CEILING: a resumed session that received a NEW raw id keeps its semantic id,
 * so only the latest raw id resolves and subagents dispatched under the earlier
 * one are not rolled up. Revisit if current-session.json gains a raw-id history.
 *
 * Never throws.
 *
 * @param {{ override: string|null, recordSessionId: unknown, eventsFile?: string }} opts
 *   `eventsFile` — the events ledger beside the target sessions.jsonl, read by
 *   {@link processIdCarryingLabel} when the marker proves nothing
 * @returns {string|null}
 */
function resolveOwnSessionUuid({ override, recordSessionId, eventsFile }) {
  const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
  const explicit = trimmed(override);
  if (explicit) return explicit;
  const processIds = readProcessLocalSessionIds();
  const markerPath = join(process.cwd(), '.orchestrator', 'current-session.json');
  let refusal = null;
  try {
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      const uuid = trimmed(marker?.session_id);
      if (uuid) {
        const semantic = trimmed(marker?.semantic_session_id);
        const namesRecord = (semantic !== '' && semantic === recordSessionId) || uuid === recordSessionId;
        const processAgrees = processIds.length === 0 || processIds.includes(uuid);
        if (namesRecord && processAgrees) return uuid;
        // The record's session_id is the semantic label (STATE.md `session`); name
        // both sides of whichever comparison failed, so the operator sees which drifted.
        refusal = namesRecord
          ? `current-session.json session label ${recordSessionId} matches, but this process runs as ` +
            `${processIds.join('/')}, not the marker's uuid ${uuid}`
          : `current-session.json session label mismatch: marker semantic_session_id=${semantic || '<absent>'} ` +
            `vs record session_id=${recordSessionId ?? '<unknown>'}`;
      }
    }
  } catch (err) {
    refusal = `could not read ${markerPath} (${err?.message ?? err})`;
  }
  // #1773: the cwd marker is the wrong witness whenever the session's work tree
  // is not the checkout its SessionStart wrote (a linked worktree has no marker,
  // or another session's), or a peer's later SessionStart overwrote it. The
  // process-local id is proof on its own once the events ledger shows that id
  // carrying THIS record's label: hooks stamp `semantic_session_id` only from a
  // lock whose raw id equals the process-local one (events.mjs #1123). A label
  // this process never carried (a replay of a foreign record) stays unproven.
  const proven = processIdCarryingLabel(eventsFile, processIds, recordSessionId);
  if (proven) return proven;
  if (refusal) {
    process.stderr.write(`emit-session: WARN ${refusal}; omitting raw_session_id and the token rollup\n`);
  }
  return null;
}

/**
 * The process-local id under which `eventsFile` holds an event labelled
 * `label` (`semantic_session_id`), or null. Exactly one process id may match:
 * two would leave the record's owner ambiguous.
 *
 * CEILING: a session whose every labelled event rotated out of events.jsonl
 * (`events-rotation.max-size-mb`) is not found — turn.stopped events keep the
 * label fresh for a live session, so revisit only if such a miss is measured.
 *
 * Never throws.
 *
 * @param {string|undefined} eventsFile
 * @param {string[]} processIds
 * @param {unknown} label
 * @returns {string|null}
 */
function processIdCarryingLabel(eventsFile, processIds, label) {
  if (!eventsFile || processIds.length === 0 || typeof label !== 'string' || label === '') return null;
  let raw;
  try {
    raw = readFileSync(eventsFile, 'utf8');
  } catch {
    return null;
  }
  // The prefilter matches the label as it is SERIALIZED: a git branch may carry
  // a `"`, which JSONL holds escaped, so the raw label would skip its own event.
  const serializedLabel = JSON.stringify(label).slice(1, -1);
  const found = new Set();
  for (const line of raw.split('\n')) {
    if (!line.includes(serializedLabel)) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.semantic_session_id === label && processIds.includes(ev.session_id)) found.add(ev.session_id);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * The `head_sha` of THIS session's own `orchestrator.session.started` event —
 * matched on the raw UUID, so a parallel session's start event never supplies
 * it. The FIRST own event decides: a resume or compact that re-emits the event
 * under the same raw id is not the session's start, so its sha is never taken —
 * not even when the first own event carries none. Returns null when there is no
 * own event, or the first one's head_sha is absent or not a full sha.
 *
 * LIMIT — rotation (#1457 point 3): events.jsonl rotates at SessionStart once
 * it exceeds `events-rotation.max-size-mb` (default 10), and when that start is
 * a compact/resume of THIS session the first SURVIVING own event can be a
 * compact/resume re-emit whose head_sha is later than the real start. When the
 * first own event carries `native_source` 'compact' or 'resume' it is provably
 * not the start, so this returns null (unknown) rather than a wrong ref. An
 * event without `native_source` (Codex/Cursor, or a pre-#1091 writer) is still
 * taken — so a rotation that leaves an unlabelled re-emit first stays wrong.
 *
 * Whole-file read, like deriveMemoryCleanupSignal() on the same file — fine at
 * today's events.jsonl size; revisit if the file outgrows a single read.
 *
 * `behind` (#1668) is that same event's count of upstream commits the checkout
 * lacked at start: a non-negative integer when measured, null when the event
 * carries none (no upstream, or a pre-#1668 writer) — never read as 0.
 *
 * Never throws.
 *
 * @param {string} eventsFile
 * @param {string} uuid
 * @returns {{ headSha: string|null, behind: number|null }}
 */
function readOwnStartHeadSha(eventsFile, uuid) {
  const none = { headSha: null, behind: null };
  let raw;
  try {
    raw = readFileSync(eventsFile, 'utf8');
  } catch {
    return none;
  }
  for (const line of raw.split('\n')) {
    if (!line.includes(uuid)) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.event !== 'orchestrator.session.started' || ev.session_id !== uuid) continue;
    if (ev.native_source === 'compact' || ev.native_source === 'resume') return none;
    return {
      headSha: typeof ev.head_sha === 'string' && FULL_SHA_RE.test(ev.head_sha) ? ev.head_sha : null,
      behind: Number.isInteger(ev.behind) && ev.behind >= 0 ? ev.behind : null,
    };
  }
  return none;
}

/**
 * True when THIS session's registry entry proves it works in a different tree
 * than the one it started in (#1652): `work_root` (refreshed at every turn end,
 * #1605) differs from `session_root` (the SessionStart project root, the tree
 * `head_sha` was measured in). Then the start event's `head_sha` names the
 * wrong tree — a `<head_sha>..HEAD` range would attribute that tree's history,
 * not the session's commits — so the fallback must not adopt it.
 *
 * Absent entry, absent roots or an unreadable file → false (no proof of a
 * divergence; the pre-#1652 behaviour). Ceiling: `work_root` follows the
 * harness cwd, so a coordinator that commits in a worktree through absolute
 * paths without changing its cwd is not detected — the primary source is the
 * STATE.md `session-start-ref` (HEAD of the session's own checkout — repoRoot,
 * the tree STATE.md lives in; commits in additional worktrees: #1659).
 *
 * Never throws.
 *
 * @param {string} uuid
 * @returns {boolean}
 */
function startTreeDiverged(uuid) {
  if (!/^[A-Za-z0-9._-]+$/.test(uuid) || uuid.startsWith('.')) return false;
  try {
    const entry = JSON.parse(readFileSync(join(activeDir(), `${uuid}.json`), 'utf8'));
    const { session_root: sessionRoot, work_root: workRoot } = entry ?? {};
    return typeof sessionRoot === 'string' && typeof workRoot === 'string' && sessionRoot !== workRoot;
  } catch {
    return false;
  }
}

/**
 * Realpath, or the resolved path when it does not exist (any more).
 *
 * @param {string} p
 * @returns {string}
 */
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Keep only well-formed `session_work_trees` entries (#1659): an absolute
 * `tree` and a FULL hex `start_ref` — the shape the work_tree reader accepts.
 * Invalid entries are dropped, never the record.
 *
 * @param {unknown} value
 * @returns {{ entries: Array<{ tree: string, start_ref: string }>, dropped: number } | null}
 *   null when `value` is not an array at all.
 */
function sanitizeWorkTrees(value) {
  if (!Array.isArray(value)) return null;
  const entries = [];
  for (const item of value) {
    if (item && typeof item.tree === 'string' && isAbsolute(item.tree)
      && typeof item.start_ref === 'string' && FULL_SHA_RE.test(item.start_ref)) {
      entries.push({ tree: item.tree, start_ref: item.start_ref });
    }
  }
  return { entries, dropped: value.length - entries.length };
}

/**
 * The own checkout's top level — the tree emit-session runs in (process.cwd(),
 * where it also reads STATE.md and current-session.json). null outside a git
 * repo. Never throws.
 *
 * @returns {string|null}
 */
function ownCheckoutTop() {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return top ? realOrResolved(top) : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  // The default shares the events ledger's main-checkout root (#1584).
  // Explicit --file paths below remain verbatim, including relative paths.
  // #1659: a linked worktree whose common dir is not named `.git`
  // (`--separate-git-dir`, bare repo) has no main checkout to map to, and the
  // resolver falls back to the WORKTREE — a second, per-worktree ledger. The
  // default is therefore resolved after parsing and refused when unmapped.
  const args = {
    file: null,
    // true when --file was not given and the default sessions ledger is used
    fileDefaulted: false,
    entry: null,
    sessionUuid: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--entry') args.entry = argv[++i];
    else if (a === '--session-uuid') args.sessionUuid = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node scripts/emit-session.mjs [--file PATH] [--entry JSON]\n' +
          '  --file   explicit target JSONL file (default: main-checkout/.orchestrator/metrics/sessions.jsonl)\n' +
          '  --entry  entry JSON (if omitted, read from stdin)\n' +
          '  --session-uuid  raw harness UUID (default: owned .orchestrator/current-session.json)\n' +
          'Exit codes: 0 append ok, 1 validation error, 2 I/O error\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`emit-session: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  if (args.file === null) {
    // The cwd is the EXPLICIT root (like the former resolveEventsLedgerRoot
    // call and every other sessions.jsonl reader), so a launch-dir env var
    // never redirects the default --file; an unmapped worktree is still
    // detected (#1659).
    const ledger = explainEventsLedgerRoot(process.cwd());
    if (!ledger.resolved) {
      process.stderr.write(
        `emit-session: refusing the default --file: ${ledger.reason}; pass an explicit --file\n`
      );
      process.exit(2);
    }
    // ledger-root: ledger.root comes from explainEventsLedgerRoot (sessions rule)
    args.file = join(ledger.root, '.orchestrator', 'metrics', 'sessions.jsonl');
    args.fileDefaulted = true;
  }
  return args;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(`emit-session: failed to read stdin: ${err.message}\n`);
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = args.entry ?? readStdin();
  if (!raw || raw.trim().length === 0) {
    process.stderr.write('emit-session: no entry provided (stdin empty and --entry not set)\n');
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`emit-session: input is not valid JSON: ${err.message}\n`);
    process.exit(2);
  }

  // Pre-validation repairs (issue #321):
  //   1. Alias legacy `ended_at` -> `completed_at` for pre-canonical writers.
  //   2. Clamp completed_at < started_at inversions (clock-skew or manual
  //      STATE.md frontmatter edits) before validate would reject them.
  let repaired = aliasLegacyEndedAt(parsed);
  if (repaired !== parsed && repaired._completed_at_conflict === true) {
    process.stderr.write(
      `emit-session: WARN session_id=${repaired.session_id ?? '<unknown>'}: ` +
        `both completed_at and ended_at present and differ; preferring completed_at\n`
    );
  }
  const beforeClamp = repaired;
  repaired = clampTimestampsMonotonic(repaired);
  if (repaired !== beforeClamp && repaired._clamped === true) {
    const startedMs = Date.parse(repaired.started_at);
    const origMs = Date.parse(repaired._original_completed_at);
    const deltaSec = Number.isFinite(startedMs - origMs)
      ? Math.round((startedMs - origMs) / 1000)
      : null;
    process.stderr.write(
      `emit-session: WARN session_id=${repaired.session_id ?? '<unknown>'}: ` +
        `completed_at < started_at (delta=${deltaSec}s); clamped completed_at to started_at ` +
        `(original preserved as _original_completed_at=${repaired._original_completed_at})\n`
    );
  }

  //   3. Alias legacy per-wave agent-count keys (`agents_completed`, …) onto
  //      their canonical `agent_count_*` spelling (#1390 P1), non-clobbering.
  //      ONLY this pass of normalizeSession runs on the write path: the rest
  //      would tag a missing `schema_version` as 0 (validateSession stamps the
  //      current version) and apply top-level aliases that validateSession's
  //      contract deliberately does not.
  repaired = normalizeWaveKeys(repaired);

  // Own raw UUID (#1436), resolved once for the three derivations further down:
  // raw_session_id, the session_start_ref events fallback, the token rollup.
  const ownUuid = resolveOwnSessionUuid({
    override: args.sessionUuid,
    recordSessionId: repaired.session_id,
    eventsFile: siblingEventsFile(args.file),
  });

  // #1054: origin belongs to the session, not the later mirror writer.
  // Only the owned new-record path may derive this machine's identity:
  // resolveOwnSessionUuid gates shared markers, while --session-uuid is the
  // caller's explicit assertion that this is its own session (not proof of a
  // historical import's origin). Incoming raw_session_id signals replayed
  // provenance: leave its host unknown rather than guess. Explicit host keys,
  // including null/empty values, always win. Never backfill existing records.
  const carriesOrigin = ['raw_session_id', 'host_id', 'host', 'host_class']
    .some((key) => Object.prototype.hasOwnProperty.call(repaired, key));
  if (ownUuid && !carriesOrigin) {
    const hostId = stableHostname();
    if (hostId) repaired = { ...repaired, host_id: hostId };
  }

  // An explicit session_start_ref that is not a full sha (#1443) names a
  // DIFFERENT commit once the short form becomes ambiguous. Dropped with a WARN
  // rather than rejected: the record is the load-bearing artefact, and the
  // derivations below may still supply the full sha. Explicit `null` stays.
  // Enforced HERE, not in validateSession(): the ledger already holds records
  // with 7-char refs, and the session-start integrity banner runs every one of
  // them through validateSession().
  if (typeof repaired.session_start_ref === 'string' && !FULL_SHA_RE.test(repaired.session_start_ref)) {
    process.stderr.write(
      `emit-session: WARN session_start_ref=${repaired.session_start_ref} is not a full hex sha; ` +
        `dropping it\n`
    );
    const { session_start_ref: _dropped, ...rest } = repaired;
    repaired = rest;
  }

  // `memory_cleanup_at` derivation (#699 follow-up — Disziplin statt Mechanik).
  // The flag used to be a boolean the coordinator-LLM remembered to pass at
  // session-end; it was forgotten on 2026-08-14 and the cadence marker stalled
  // 29 days behind the operator's own notes. It is now READ from the session's
  // own `orchestrator.memory.cleanup_completed` events, sitting in the sibling
  // events.jsonl of the target sessions.jsonl (same `.orchestrator/metrics/`
  // directory in production, same tmp dir under test — no env plumbing).
  //
  // Precedence: an EXPLICIT `memory_cleanup_at` on the incoming record WINS and
  // is never overwritten — an explicit stamp is a caller's positive assertion,
  // while derivation only fills the gap left by silence.
  const alreadyStamped =
    typeof repaired.memory_cleanup_at === 'string' && repaired.memory_cleanup_at.length > 0;
  if (!alreadyStamped) {
    const eventsFile = siblingEventsFile(args.file);
    const signal = deriveMemoryCleanupSignal({
      eventsFile,
      sessionId: repaired.session_id,
      startedAt: repaired.started_at,
      completedAt: repaired.completed_at,
    });
    if (signal.ranCleanup) {
      const before = repaired;
      repaired = stampMemoryCleanup(repaired, {
        ranCleanup: true,
        completedAt: repaired.completed_at,
      });
      if (repaired !== before) {
        process.stderr.write(
          `emit-session: derived memory_cleanup_at=${repaired.memory_cleanup_at} from ` +
            `${signal.matches} ${MEMORY_CLEANUP_EVENT} event(s) (latest ${signal.at})\n`
        );
      }
    }
  }

  // STATE.md-derived enrichment — ONE read, ONE parse, ONE ownership check for
  // both fields below.
  //
  // `session_profile` (#1247 — GitLab issue "key the effective-sizing row on
  // waves x profile"). The mandatory write path is the coordinator composing
  // `$METRICS_ENTRY` in prose (session-metrics-write.md), which never reliably
  // set this field — so it is read here instead, from this repo's own STATE.md
  // frontmatter via `readSessionProfile()` (scripts/lib/state-md.mjs).
  //
  // `session_start_ref` (#1339 P8) — frontmatter `session-start-ref`, the HEAD
  // sha the wave-executor pinned at session start. `/evolve analyze` needs it
  // for an attributable `<start>..<end>` commit range; without it, it falls
  // back to a time window that also attributes a PARALLEL session's commits to
  // this one (skills/evolve/references/evolve-analyze-mode.md). Only a full
  // hex sha (FULL_SHA_RE) is adopted; anything else is omitted with a WARN.
  // Ceiling: the frontmatter parser coerces an all-decimal-digit value to a
  // number, so such a sha (p ~ 7e-9) is omitted, never adopted as a number.
  // NO END REF, deliberately: this runs at session-end Phase 3.7, BEFORE the
  // Phase 4 close commit exists, so HEAD here would cut the session's own
  // commit out of its range. Consumers use HEAD + `--until=<completed_at>`.
  // Revisit when a post-commit writer exists that can stamp `session_end_ref`.
  //
  // Precedence: an EXPLICIT key on the incoming record (even `null`) wins and
  // is never overwritten — same "explicit assertion beats derivation"
  // convention as `memory_cleanup_at` above. Absence in STATE.md leaves the
  // field OMITTED — never coerced to `''`/`'none'`/a literal `"null"` string.
  //
  // OWNERSHIP: STATE.md belongs to the session named in its OWN frontmatter
  // (`session:`), which in a shared working copy need not be the session this
  // record describes — two parallel sessions, or a `/close` run after a
  // foreign `/plan` session left its STATE.md behind (see
  // `.claude/rules/parallel-sessions.md`). Filing session B's waves under
  // session A's profile — or A's start ref — is exactly the cross-contamination
  // both fields exist to remove. So they are adopted ONLY when the frontmatter
  // `session` equals this record's `session_id`; on any mismatch (or an
  // unprovable ownership, i.e. no `session` key) they are OMITTED — never guessed.
  //
  // FAIL-SAFE: the read is enrichment; the session record is the load-bearing
  // artefact. Any failure reading or parsing STATE.md (EISDIR when the path is
  // a directory, EACCES/EPERM, a truncated file) omits the fields and lets the
  // record through — it must never be the reason `sessions.jsonl` gains no
  // line at all.
  //
  // `outcome` (#1824) — STATE.md `outcome-statement` / `outcome-observable` /
  // `outcome-source` via `readOutcome()`, same ownership gate. The coordinator
  // knows only whether it CHECKED the observable, so it may pass a partial
  // `outcome: { observed }`; the statement half is filled from STATE.md here.
  // An incoming object WITHOUT a complete statement half (`hasOutcomeStatement`)
  // counts as partial: only its `observed` is kept. `observed` defaults to
  // `not-measured` — never to `observed`; a value outside OUTCOME_OBSERVED_VALUES
  // is replaced with a WARN. A record whose STATE.md names no outcome carries NO
  // `outcome` key; a partial object that cannot be completed is dropped with a
  // WARN rather than failing the record.
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(repaired, key);
  const needsProfile = !hasOwn('session_profile');
  const needsStartRef = !hasOwn('session_start_ref');
  const incomingOutcome = repaired.outcome;
  let incomingObserved = isPlainRecord(incomingOutcome) ? incomingOutcome.observed : undefined;
  if (incomingObserved !== undefined && !OUTCOME_OBSERVED_VALUES.includes(incomingObserved)) {
    process.stderr.write(
      `emit-session: WARN outcome.observed=${JSON.stringify(incomingObserved)} is not one of ` +
        `${OUTCOME_OBSERVED_VALUES.join('|')}; recording not-measured\n`
    );
    incomingObserved = undefined;
  }
  const outcomeIsPartial =
    incomingOutcome !== undefined && incomingOutcome !== null && !hasOutcomeStatement(incomingOutcome);
  const needsOutcome = !hasOwn('outcome') || outcomeIsPartial;
  if (hasOutcomeStatement(incomingOutcome)) {
    const { statement, observable, source } = incomingOutcome;
    repaired = {
      ...repaired,
      outcome: { statement, observable, source, observed: incomingObserved ?? 'not-measured' },
    };
  }
  // What STATE.md contributed to session_start_ref, for the WARN below when no
  // source supplies one (#1457 point 2): none, or a ref that was discarded.
  let stateMdStartRefNote = 'STATE.md carried none';
  if (needsProfile || needsStartRef || needsOutcome) {
    let stateMdContents = '';
    try {
      // #1622: the write side's ownership rule — another platform's STATE.md
      // not proven to be this process's counts as no STATE.md.
      const { path: stateMdPath, rejected } = resolveStateMdWriteTarget(process.cwd());
      if (rejected) {
        warnForeignStateMd('emit-session', rejected, stateMdPath);
        stateMdStartRefNote = "STATE.md foreign (another platform's, not this process's session-id)";
      } else if (existsSync(stateMdPath)) {
        stateMdContents = readFileSync(stateMdPath, 'utf8');
      }
    } catch (err) {
      process.stderr.write(
        `emit-session: WARN could not read STATE.md for session_profile/session_start_ref ` +
          `derivation (${err?.message ?? err}); omitting both\n`
      );
      stateMdContents = '';
      stateMdStartRefNote = 'STATE.md unreadable';
    }
    // No initialiser: both the try and the catch below assign `profile` and `outcome`.
    let profile;
    let outcome;
    let startRef = null;
    let owner = null;
    try {
      profile = readSessionProfile(stateMdContents);
      outcome = readOutcome(stateMdContents);
      const fm = parseStateMd(stateMdContents)?.frontmatter;
      const rawOwner = fm?.session;
      owner = typeof rawOwner === 'string' && rawOwner.trim().length > 0 ? rawOwner.trim() : null;
      const rawRef = fm?.['session-start-ref'];
      if (typeof rawRef === 'string' && FULL_SHA_RE.test(rawRef.trim())) {
        startRef = rawRef.trim();
      } else if (needsStartRef && rawRef !== undefined && rawRef !== null && rawRef !== '') {
        process.stderr.write(
          `emit-session: WARN STATE.md session-start-ref=${rawRef} is not a full hex sha; ` +
            `omitting session_start_ref\n`
        );
        stateMdStartRefNote = 'STATE.md ref discarded (not a full hex sha)';
      }
    } catch (err) {
      process.stderr.write(
        `emit-session: WARN could not parse STATE.md for session_profile/session_start_ref ` +
          `derivation (${err?.message ?? err}); omitting both\n`
      );
      profile = null;
      outcome = null;
      startRef = null;
      stateMdStartRefNote = 'STATE.md unparseable';
    }
    const derived = {};
    if (needsProfile && profile !== null) derived.session_profile = profile;
    if (needsStartRef && startRef !== null) derived.session_start_ref = startRef;
    if (needsOutcome && outcome !== null) {
      derived.outcome = { ...outcome, observed: incomingObserved ?? 'not-measured' };
    }
    const derivedKeys = Object.keys(derived);
    if (derivedKeys.length > 0) {
      if (owner !== null && owner === repaired.session_id) {
        repaired = { ...repaired, ...derived };
      } else {
        if (derived.session_start_ref !== undefined) {
          stateMdStartRefNote = `STATE.md ref discarded (belongs to session=${owner ?? '<absent>'})`;
        }
        // A visible omission: silence here is indistinguishable from "STATE.md
        // carries no such field", and a foreign STATE.md in this working copy
        // is precisely what the operator wants to know about.
        process.stderr.write(
          `emit-session: WARN STATE.md ${derivedKeys.map((k) => `${k}=${typeof derived[k] === 'object' ? JSON.stringify(derived[k]) : derived[k]}`).join(' ')} ` +
            `belongs to session=${owner ?? '<absent>'}, not session_id=${repaired.session_id ?? '<unknown>'}; ` +
            `omitting ${derivedKeys.join(', ')}\n`
        );
      }
    }
  }

  if (repaired.outcome !== undefined && repaired.outcome !== null && !hasOutcomeStatement(repaired.outcome)) {
    process.stderr.write(
      `emit-session: WARN outcome=${JSON.stringify(repaired.outcome)} names no complete statement ` +
        `(statement, observable, source) and STATE.md supplied none for this session; omitting outcome\n`
    );
    const { outcome: _dropped, ...rest } = repaired;
    repaired = rest;
  }

  // session_start_ref fallback (#1443): STATE.md supplied none (absent key,
  // foreign owner, unparseable) — take the head_sha the SessionStart hook
  // recorded on this session's own start event. Absent there too → omitted,
  // with a WARN whether or not an own UUID was available (#1457 point 2) —
  // without one the fallback cannot run, which is exactly when silence hid it.
  if (!hasOwn('session_start_ref')) {
    const { headSha, behind } = ownUuid !== null
      ? readOwnStartHeadSha(siblingEventsFile(args.file), ownUuid)
      : { headSha: null, behind: null };
    if (headSha !== null && behind !== null && behind > 0) {
      // #1668 — the checkout was provably behind its upstream at start. A pull
      // during the session makes `<head_sha>..HEAD` span the upstream commits it
      // pulled in; no sha known at start fixes that (merge-base(head_sha,
      // upstream) IS head_sha when merely behind, and upstream_sha is wrong when
      // nothing was pulled), so the ref is dropped rather than overstated.
      // behind 0 or not measured (absent) keep the pre-#1668 adoption below.
      process.stderr.write(
        `emit-session: WARN no session_start_ref — ${stateMdStartRefNote}, and the own ` +
          `session.started head_sha=${headSha} was ${behind} commit(s) behind its upstream; ` +
          'a range from it can include pulled-in upstream commits (#1668)\n'
      );
    } else if (headSha !== null && startTreeDiverged(ownUuid)) {
      process.stderr.write(
        `emit-session: WARN no session_start_ref — ${stateMdStartRefNote}, and the own ` +
          `session.started head_sha=${headSha} was measured in session_root, not the work_root ` +
          'this session works in (#1652)\n'
      );
    } else if (headSha !== null) {
      repaired = { ...repaired, session_start_ref: headSha };
      process.stderr.write(
        `emit-session: derived session_start_ref=${headSha} from the own orchestrator.session.started event\n`
      );
    } else {
      process.stderr.write(
        `emit-session: WARN no session_start_ref — ${stateMdStartRefNote}, ` +
          'no own session.started head_sha available\n'
      );
    }
  }

  if (ownUuid !== null && !hasOwn('raw_session_id')) {
    repaired = { ...repaired, raw_session_id: ownUuid };
  }

  // `session_work_trees` (#1659) — the (tree, start_ref) pairs the staging
  // fence recorded before each of THIS session's commits
  // (`orchestrator.session.work_tree`, joined on the own raw id — never on a
  // repo-global file). `session_start_ref` names one sha in the own checkout,
  // so the field is written ONLY when it adds something: ≥2 trees, or one tree
  // that is not the own checkout. An explicit key on the record wins, but its
  // malformed entries are dropped with a WARN (like session_start_ref above —
  // enforced here, not in validateSession()). Best-effort: any failure omits
  // the field with a WARN; it never fails the emit.
  if (hasOwn('session_work_trees')) {
    const clean = sanitizeWorkTrees(repaired.session_work_trees);
    if (clean === null) {
      process.stderr.write('emit-session: WARN session_work_trees is not an array; dropping it\n');
      const { session_work_trees: _dropped, ...rest } = repaired;
      repaired = rest;
    } else if (clean.dropped > 0) {
      process.stderr.write(
        `emit-session: WARN session_work_trees: dropping ${clean.dropped} malformed entry/entries\n`
      );
      repaired = { ...repaired, session_work_trees: clean.entries };
    }
  } else if (ownUuid !== null) {
    try {
      const read = readSessionWorkTrees({ sessionId: ownUuid, eventsFile: siblingEventsFile(args.file) });
      if (read.error) {
        process.stderr.write(
          `emit-session: WARN could not read work_tree events (${read.error}); omitting session_work_trees\n`
        );
      } else if (read.malformed > 0) {
        // Unreadable lines may hide own work_tree events — warn even when no
        // tree was read, since then the omission itself may be the gap (#1659).
        process.stderr.write(
          `emit-session: WARN ${read.malformed} unreadable events ledger line(s); session_work_trees may be incomplete\n`
        );
      }
      if (!read.error && read.trees.length > 0) {
        if (read.invalid > 0) {
          process.stderr.write(
            `emit-session: WARN ignored ${read.invalid} own work_tree event(s) without a valid tree/start_ref\n`
          );
        }
        // A single tree is only worth recording when it provably differs from
        // the own checkout; outside a git repo that is unprovable → omitted.
        const ownTop = read.trees.length >= 2 ? null : ownCheckoutTop();
        const addsInfo = read.trees.length >= 2
          || (ownTop !== null && realOrResolved(read.trees[0].tree) !== ownTop);
        if (addsInfo) repaired = { ...repaired, session_work_trees: read.trees };
      }
    } catch (err) {
      process.stderr.write(
        `emit-session: WARN session_work_trees derivation failed (${err?.message ?? err}); omitting it\n`
      );
    }
  }

  // Token rollup (#1436) — mechanical, replacing the session-metrics-write.md
  // prose step that had no production caller. Joins the sibling subagents.jsonl
  // on the own raw UUID and fills ONLY keys the entry does not carry; an
  // explicit `total_tokens` means the caller already rolled up, so nothing is
  // merged. No matching records or a failed read OMITS the fields with a WARN —
  // never a fabricated 0; a null total is omitted rather than written — for
  // `total_cost_usd` that is any session with an unpriced cost candidate
  // (unknown model, no model, no tokens, a started agent without a transcript,
  // or a v1 agent — the complete list is the `session-token-rollup.mjs` module
  // doc, #1498), which the persisted `cost_records_priced < cost_records_total`
  // then explains.
  // match_status explains the omission; diagnostic fields stay out of the record.
  if (ownUuid !== null && !hasOwn('total_tokens')) {
    let rollup = null;
    try {
      // A defaulted --file reads the subagents ledger where the hook writer
      // (hooks/subagent-telemetry.mjs) puts it: resolved from the cwd first, then
      // from the ledger root — the hook resolves from the LAUNCH dir, which is
      // the main checkout when the session entered this worktree later and the
      // repo versions the ledger. First copy with a record of this session wins,
      // so nothing is counted twice. An explicit --file keeps its sibling.
      const candidates = args.fileDefaulted
        ? [...new Set([
          resolveLedgerPath('.orchestrator/metrics/subagents.jsonl', process.cwd()),
          resolveLedgerPath('.orchestrator/metrics/subagents.jsonl', resolveEventsLedgerRoot(process.cwd())),
        ])]
        : [join(dirname(args.file), 'subagents.jsonl')];
      for (const subagentsPath of candidates) {
        rollup = rollupSessionTokens({ parentSessionId: ownUuid, subagentsPath });
        if (rollup.matched_records > 0) break;
      }
    } catch (err) {
      process.stderr.write(
        `emit-session: WARN token rollup failed (${err?.message ?? err}); omitting token fields\n`
      );
    }
    if (rollup !== null && rollup.matched_records > 0) {
      const merged = {};
      for (const key of ROLLUP_KEYS) {
        if (hasOwn(key) || !Number.isFinite(rollup[key])) continue;
        // Mirrors validateSession(): these two are non-negative INTEGERS, while
        // total_token_input/output may be fractional — one fractional token
        // value upstream must cost the field, not the record.
        if (INTEGER_ROLLUP_KEYS.has(key) && !Number.isInteger(rollup[key])) {
          process.stderr.write(
            `emit-session: WARN token rollup produced an invalid field (${key} must be a ` +
              `non-negative integer, got: ${rollup[key]}); omitting ${key}\n`
          );
          continue;
        }
        merged[key] = rollup[key];
      }
      // #1470 Pkt 4/6 — label the merged cost fields. A dollar figure is the
      // API list-price equivalent, never a payment (`cost_basis`, only beside
      // a written `total_cost_usd`). The coverage counters, too, depend on
      // which models the table knows, so `pricing_table_date` names the table
      // that produced them — read from pricing.mjs, the same module the rollup
      // priced with, never a second copy of the date.
      if ('total_cost_usd' in merged && !hasOwn('cost_basis')) {
        merged.cost_basis = COST_BASIS;
      }
      if ('cost_records_total' in merged && !hasOwn('pricing_table_date')) {
        merged.pricing_table_date = PRICING_TABLE_DATE;
      }
      // Enrichment must never be the reason the ledger gains no line: validate
      // the enriched record first and fall back to the un-enriched one. Blamed
      // on the rollup only when the un-enriched record validates on its own —
      // otherwise the validation below reports the record's own defect.
      try {
        validateSession({ ...repaired, ...merged });
        repaired = { ...repaired, ...merged };
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        let baseValid = true;
        try {
          validateSession(repaired);
        } catch {
          baseValid = false;
        }
        if (baseValid) {
          process.stderr.write(
            `emit-session: WARN token rollup produced an invalid field (${err.message}); ` +
              `omitting token fields\n`
          );
        }
      }
      if (rollup.total_tokens === null) {
        process.stderr.write(
          `emit-session: WARN token rollup matched ${rollup.matched_records} subagents.jsonl record(s) ` +
            `for ${ownUuid}, none token-bearing; total_tokens omitted\n`
        );
      }
    } else if (rollup !== null) {
      let warning = `token rollup found no subagents.jsonl records for ${ownUuid}`;
      switch (rollup.match_status) {
        case 'ledger-absent':
          warning += ' (ledger absent)';
          break;
        case 'ledger-empty':
          warning += ' (ledger holds no readable records)';
          break;
        case 'unmatched':
          warning = `token rollup found ${rollup.ledger_records} subagents.jsonl record(s) present, ` +
            `none with parent_session_id=${ownUuid} — not attributable via this UUID, not zero cost`;
          break;
        case 'invalid-key':
          warning = `token rollup rejected invalid parent_session_id=${ownUuid}`;
          break;
        default:
          // Unknown or missing diagnostics retain the generic omission warning.
          break;
      }
      process.stderr.write(`emit-session: WARN ${warning}; omitting token fields\n`);
    }
  }

  let validated;
  try {
    validated = validateSession(repaired);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(`emit-session: validation failed: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Pre-write round-trip self-validation (#662): prove the line this writer is
  // about to append parses back AND re-validates BEFORE it reaches disk. The
  // append path (appendJsonl) does the same JSON.stringify, so a record that
  // stringifies "fine" but round-trips to a schema-invalid shape (NaN/undefined
  // required field silently dropped by JSON.stringify) would otherwise corrupt
  // sessions.jsonl and only surface on the NEXT session's read. Treated as a
  // validation failure (exit 1); file is left untouched.
  try {
    serializeSessionLineChecked(repaired);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stderr.write(
        `emit-session: pre-write round-trip validation failed: ${err.message}\n`
      );
      process.exit(1);
    }
    throw err;
  }

  // validateSession returns `{ ...entry, schema_version }` — the spread preserves
  // ALL additive fields, including `memory_cleanup_at` (#699) and `autopilot_run_id`
  // (#300). No field stripping occurs here; additive v1-compatible fields pass through.
  try {
    await appendJsonl(args.file, validated);
  } catch (err) {
    process.stderr.write(`emit-session: write failed (${args.file}): ${err.message}\n`);
    process.exit(2);
  }

  const summary = {
    action: 'appended',
    path: args.file,
    session_id: validated.session_id,
    schema_version: validated.schema_version ?? CURRENT_SESSION_SCHEMA_VERSION,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
}

// Only run the CLI when invoked directly (`node scripts/emit-session.mjs ...`),
// not when imported as a module (e.g. by tests that exercise the exported
// serializeSessionLineChecked seam — #662). Without this guard, importing the
// module would block on stdin / exit the test process.
const _isDirectRun =isMainModule(import.meta.url);

if (_isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`emit-session: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
