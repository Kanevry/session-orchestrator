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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendJsonl } from './lib/common.mjs';
import {
  MEMORY_CLEANUP_EVENT,
  deriveMemoryCleanupSignal,
  stampMemoryCleanup,
} from './lib/memory-cleanup-stamp.mjs';
import { parseStateMd, readSessionProfile, resolveStateMdPath } from './lib/state-md.mjs';
import { readProcessLocalSessionIds } from './lib/session-identity/own-session.mjs';
import { rollupSessionTokens } from './lib/session-token-rollup.mjs';
import { serializeSessionLineChecked } from './lib/session-schema/serializer.mjs';
import {
  validateSession,
  ValidationError,
  CURRENT_SESSION_SCHEMA_VERSION,
  clampTimestampsMonotonic,
  aliasLegacyEndedAt,
  normalizeWaveKeys,
} from './lib/session-schema.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

export { serializeSessionLineChecked };

// A FULL object name only (SHA-1 or SHA-256 repo). A short sha or a symbolic
// ref (`HEAD`, a branch) would resolve to a DIFFERENT commit when read later.
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
 * (.claude/rules/identity-and-locks.md). A foreign marker is WARNed and yields
 * null; an absent marker yields null silently.
 *
 * CEILING: a resumed session that received a NEW raw id keeps its semantic id,
 * so only the latest raw id resolves and subagents dispatched under the earlier
 * one are not rolled up. Revisit if current-session.json gains a raw-id history.
 *
 * Never throws.
 *
 * @param {{ override: string|null, recordSessionId: unknown }} opts
 * @returns {string|null}
 */
function resolveOwnSessionUuid({ override, recordSessionId }) {
  const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
  const explicit = trimmed(override);
  if (explicit) return explicit;
  const markerPath = join(process.cwd(), '.orchestrator', 'current-session.json');
  let marker;
  try {
    if (!existsSync(markerPath)) return null;
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `emit-session: WARN could not read ${markerPath} (${err?.message ?? err}); ` +
        `omitting raw_session_id and the token rollup\n`
    );
    return null;
  }
  const uuid = trimmed(marker?.session_id);
  if (!uuid) return null;
  const semantic = trimmed(marker?.semantic_session_id);
  const namesRecord = (semantic !== '' && semantic === recordSessionId) || uuid === recordSessionId;
  const processIds = readProcessLocalSessionIds();
  const processAgrees = processIds.length === 0 || processIds.includes(uuid);
  if (namesRecord && processAgrees) return uuid;
  // The record's session_id is the semantic label (STATE.md `session`); name
  // both sides of whichever comparison failed, so the operator sees which drifted.
  const why = namesRecord
    ? `session label ${recordSessionId} matches, but this process runs as ` +
      `${processIds.join('/')}, not the marker's uuid ${uuid}`
    : `session label mismatch: marker semantic_session_id=${semantic || '<absent>'} ` +
      `vs record session_id=${recordSessionId ?? '<unknown>'}`;
  process.stderr.write(
    `emit-session: WARN current-session.json ${why}; omitting raw_session_id and the token rollup\n`
  );
  return null;
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
 * Never throws.
 *
 * @param {string} eventsFile
 * @param {string} uuid
 * @returns {string|null}
 */
function readOwnStartHeadSha(eventsFile, uuid) {
  let raw;
  try {
    raw = readFileSync(eventsFile, 'utf8');
  } catch {
    return null;
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
    if (ev.native_source === 'compact' || ev.native_source === 'resume') return null;
    return typeof ev.head_sha === 'string' && FULL_SHA_RE.test(ev.head_sha) ? ev.head_sha : null;
  }
  return null;
}

function parseArgs(argv) {
  const args = { file: '.orchestrator/metrics/sessions.jsonl', entry: null, sessionUuid: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--entry') args.entry = argv[++i];
    else if (a === '--session-uuid') args.sessionUuid = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node scripts/emit-session.mjs [--file PATH] [--entry JSON]\n' +
          '  --file   target JSONL file (default: .orchestrator/metrics/sessions.jsonl)\n' +
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
  });

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
    const eventsFile = join(dirname(args.file), 'events.jsonl');
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
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(repaired, key);
  const needsProfile = !hasOwn('session_profile');
  const needsStartRef = !hasOwn('session_start_ref');
  // What STATE.md contributed to session_start_ref, for the WARN below when no
  // source supplies one (#1457 point 2): none, or a ref that was discarded.
  let stateMdStartRefNote = 'STATE.md carried none';
  if (needsProfile || needsStartRef) {
    let stateMdContents = '';
    try {
      const stateMdPath = resolveStateMdPath(process.cwd());
      if (existsSync(stateMdPath)) stateMdContents = readFileSync(stateMdPath, 'utf8');
    } catch (err) {
      process.stderr.write(
        `emit-session: WARN could not read STATE.md for session_profile/session_start_ref ` +
          `derivation (${err?.message ?? err}); omitting both\n`
      );
      stateMdContents = '';
      stateMdStartRefNote = 'STATE.md unreadable';
    }
    // No initialiser: both the try and the catch below assign `profile`.
    let profile;
    let startRef = null;
    let owner = null;
    try {
      profile = readSessionProfile(stateMdContents);
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
      startRef = null;
      stateMdStartRefNote = 'STATE.md unparseable';
    }
    const derived = {};
    if (needsProfile && profile !== null) derived.session_profile = profile;
    if (needsStartRef && startRef !== null) derived.session_start_ref = startRef;
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
          `emit-session: WARN STATE.md ${derivedKeys.map((k) => `${k}=${derived[k]}`).join(' ')} ` +
            `belongs to session=${owner ?? '<absent>'}, not session_id=${repaired.session_id ?? '<unknown>'}; ` +
            `omitting ${derivedKeys.join(', ')}\n`
        );
      }
    }
  }

  // session_start_ref fallback (#1443): STATE.md supplied none (absent key,
  // foreign owner, unparseable) — take the head_sha the SessionStart hook
  // recorded on this session's own start event. Absent there too → omitted,
  // with a WARN whether or not an own UUID was available (#1457 point 2) —
  // without one the fallback cannot run, which is exactly when silence hid it.
  if (!hasOwn('session_start_ref')) {
    const headSha = ownUuid !== null
      ? readOwnStartHeadSha(join(dirname(args.file), 'events.jsonl'), ownUuid)
      : null;
    if (headSha !== null) {
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

  // Token rollup (#1436) — mechanical, replacing the session-metrics-write.md
  // prose step that had no production caller. Joins the sibling subagents.jsonl
  // on the own raw UUID and fills ONLY keys the entry does not carry; an
  // explicit `total_tokens` means the caller already rolled up, so nothing is
  // merged. No matching records or a failed read OMITS the fields with a WARN —
  // never a fabricated 0; a null total is omitted rather than written — for
  // `total_cost_usd` that is any session with an unpriced subagent record
  // (#1475: unknown model, no model, or no tokens), which the persisted
  // `cost_records_priced < cost_records_total` then explains.
  // match_status explains the omission; diagnostic fields stay out of the record.
  if (ownUuid !== null && !hasOwn('total_tokens')) {
    let rollup = null;
    try {
      rollup = rollupSessionTokens({
        parentSessionId: ownUuid,
        subagentsPath: join(dirname(args.file), 'subagents.jsonl'),
      });
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
