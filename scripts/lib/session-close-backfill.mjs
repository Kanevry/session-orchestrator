/**
 * session-close-backfill.mjs — SessionEnd close-through backfill (Epic #724 C1).
 *
 * Fleet-wide only ~27% of started sessions ever reach a /close (this repo: 137
 * distinct `orchestrator.session.started` events vs 36 sessions.jsonl records).
 * When a session terminates without running /close, no session record is ever
 * written — the work is invisible to every downstream sessions.jsonl consumer.
 *
 * This module reconstructs a MINIMAL `status: 'abandoned'` stub from the
 * `.orchestrator/metrics/events.jsonl` breadcrumbs the lifecycle hooks already
 * emit, and appends it through the SAME validate + round-trip + append path the
 * normal writer (`scripts/emit-session.mjs`) uses. It is invoked best-effort
 * from `hooks/on-session-end.mjs` and by the one-time historical migration CLI
 * `scripts/backfill-abandoned-sessions.mjs`.
 *
 * A second, sibling export — `backfillCompletedFromStateMd` — closes a
 * different gap (#429): `commands/close.md`'s Pre-Check treats STATE.md
 * `status: completed` as proof the session-end writer already ran and refuses
 * to invoke it again. When that status was set by hand (or by any path that
 * never reached Phase 3.7), no sessions.jsonl record is EVER written — the
 * Pre-Check keeps blocking the only thing that would normally create one.
 * `backfillCompletedFromStateMd` reads STATE.md directly, and when its status
 * is `completed` with no matching sessions.jsonl record, backfills one tagged
 * `status: 'completed'` + `_backfill_source: 'state-md-completed'` (never
 * `'abandoned'` — the session itself claims to have finished normally).
 *
 * ── ID BRIDGE ────────────────────────────────────────────────────────────────
 *   Legacy sessions.jsonl records are keyed by semantic ids; native records
 *   use the harness UUID with a separate `semantic_session_id` label.
 *   events.jsonl carries the harness UUID on `session.started` / `stop` / `ended`.
 *   The bridge is the `orchestrator.session.lock.acquired` event, which is the
 *   only record carrying BOTH `session_id` (UUID) and `semantic_session_id`.
 *   Only ~1/3 of sessions ever emit a lock.acquired, so when the bridge is
 *   missing we fall back to a synthetic id + `_synthetic_session_id: true`.
 *
 * ── SAFETY POSTURE ──────────────────────────────────────────────────────────
 *   - No-throw: every path returns a structured `{ action, ... }` result; the
 *     hook must never be pushed past its teardown timeout by an exception.
 *   - Dedupe: never double-write a session already present in sessions.jsonl.
 *   - Supersede (#1068 AC3/AC4): the ONE exception to that dedupe — an
 *     authoritative `state-md-completed` record may be appended for an identity
 *     whose only entry is a backfilled `abandoned` STUB, carrying
 *     `supersedes: <stub id>`. Append-only: the stub is kept verbatim and
 *     readers take the NEWEST record for an id as the canonical one.
 *   - Liveness guard: never backfill over a FOREIGN live session.lock (PSA).
 *   - TOCTOU marker: an atomic `openSync(..., 'wx')` claim file keyed by the
 *     final id serialises concurrent backfill attempts (mirrors the
 *     on-session-start registry-slot claim, #587).
 *   - dryRun: computes + validates the stub without touching disk (used by the
 *     migration CLI's `--dry-run` default).
 *
 * Plain Node ESM. Named exports. DI-friendly via `deps` (mirrors enumerate.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { appendJsonl as defaultAppendJsonl } from './common.mjs';
import { parseSessionId } from './session-id.mjs';
import { readLock as defaultReadLock, isLockLive as defaultIsLockLive, DEFAULT_TTL_HOURS } from './session-lock.mjs';
import { validateSession as defaultValidateSession } from './session-schema/validator.mjs';
import { serializeSessionLineChecked as defaultSerialize } from './session-schema.mjs';
import { resolveStateMdPath as defaultResolveStateMdPath } from './state-md/frontmatter-mutators.mjs';
import { parseStateMd as defaultParseStateMd } from './state-md/yaml-parser.mjs';
import { canonicalizeSessions } from './sessions-canonical.mjs';
// Leaf constants module (no imports of its own) and ALREADY in the hook import
// set via session-schema/validator.mjs — importing it here adds no new file to
// the SessionStart/SessionEnd hook graph. The profile enum must not be
// re-literalled: `VALID_SESSION_PROFILES` is its SSOT (GitLab #1252).
import { VALID_SESSION_PROFILES } from './session-schema/constants.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The three real session MODES — deliberately NOT the schema's VALID_SESSION_TYPES,
 * which since GitLab #1234 also carries `unknown`. This set answers a narrower
 * question: "is `gathered.mode` a MEASUREMENT?". `unknown` must never pass it, or
 * an events record carrying `mode: 'unknown'` would be recorded as a measured type
 * (`_session_type_inferred` absent) when it is the opposite.
 */
const MEASURED_SESSION_MODES = new Set(['feature', 'deep', 'housekeeping']);

/**
 * session_type written when nothing in events.jsonl measured the mode
 * (GitLab #1234). Always paired with `_session_type_inferred` + `_synthetic`.
 */
const UNMEASURED_SESSION_TYPE = 'unknown';

const EVENT_STARTED = 'orchestrator.session.started';
const EVENT_LOCK_ACQUIRED = 'orchestrator.session.lock.acquired';
/**
 * `orchestrator.session.shape_resolved` (`scripts/lib/session-shape.mjs`) — the
 * ONLY event emitted AFTER the operator picked a mode, so it is the only
 * measurement of what this session actually was. `lock.acquired.mode` fires at
 * SessionStart, BEFORE `/session <type>` is typed, which is why nearly every
 * abandoned stub carried `_session_type_inferred: true`; and no other event
 * carries `session_profile` at all, so an abandoned ultradeep run was
 * indistinguishable from an abandoned deep one.
 */
const EVENT_SHAPE_RESOLVED = 'orchestrator.session.shape_resolved';
// Both names for one generation (GitLab #1234): `hooks/on-stop.mjs` now emits
// `orchestrator.turn.stopped` as the canonical name and keeps the legacy
// `orchestrator.session.stopped` (with `deprecated: true`) beside it until
// 2027-03-06. A terminal-event probe must accept EITHER, or every session that
// closes after the legacy name is dropped silently loses its attested end and
// falls back to the flagged `lastEventMs` estimate.
const EVENT_STOPPED = 'orchestrator.session.stopped';
const EVENT_TURN_STOPPED = 'orchestrator.turn.stopped';
const EVENT_ENDED = 'orchestrator.session.ended';

const EVENTS_REL = ['.orchestrator', 'metrics', 'events.jsonl'];
const SESSIONS_REL = ['.orchestrator', 'metrics', 'sessions.jsonl'];
const BACKFILL_LOG_REL = ['.orchestrator', 'metrics', 'session-close-backfill.log'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when `s` is an RFC 9562 UUID session id (any version 1-8, variant `10xx`).
 *
 * Delegates to `parseSessionId()` so the repo has exactly ONE UUID contract
 * (`UUID_RE` in `scripts/lib/session-id.mjs`). This module previously carried a
 * private, LOOSER copy that constrained neither the version nor the variant
 * nibble, so a 36-char lookalike such as
 * `xxxxxxxx-xxxx-0xxx-cxxx-xxxxxxxxxxxx` was classified as a harness UUID here
 * while `hooks/on-session-start.mjs` — which gates on `parseSessionId()` —
 * rejected it. The disagreement is exactly the ID-bridge this module depends
 * on: a value the writer refused to use as a raw id was still treated here as
 * one, sending the record down the UUID branch (lock-bridge + synthetic-id
 * mint) instead of the semantic branch.
 */
export function isUuid(s) {
  return parseSessionId(s)?.format === 'uuid';
}

/** Filesystem-safe marker filename for an arbitrary session id. */
function markerName(id) {
  const cleaned = String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return `.backfilled-${cleaned}.marker`;
}

/**
 * Read a JSONL file into an array of parsed objects. Missing file (ENOENT) →
 * [] silently; an unreadable one (EACCES/EISDIR/…) → [] with a stderr WARN
 * (#1210 — ENOENT and other read failures are different facts, same split as
 * `sessions-canonical.mjs` `readCanonicalSessions`). Each malformed line is
 * skipped rather than aborting the whole read. Never throws.
 */
function readJsonlSafe(readFileSync, filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      process.stderr.write(
        `⚠ readJsonlSafe: cannot read ${filePath} ` +
          `(${err?.code ?? '?'}: ${err?.message ?? String(err)}) — ` +
          'treating as EMPTY, counts below are floors\n',
      );
    }
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Normalise any parseable timestamp to canonical ISO-8601 UTC ms form. */
function canonicalIso(value, fallbackMs) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  const fb = Number.isFinite(fallbackMs) ? fallbackMs : Date.now();
  return new Date(fb).toISOString();
}

/**
 * Walk events.jsonl and gather everything known about one session, bridging
 * UUID ↔ semantic id via lock.acquired. Returns provenance used to synthesize
 * the record (never throws).
 *
 * @param {Array<object>} events
 * @param {{ sessionId: string|null, semanticSessionId: string|null }} ids
 */
function collectSessionEvents(events, { sessionId, semanticSessionId }) {
  const uuids = new Set();
  const nativeId = isUuid(sessionId) ? sessionId : null;
  if (nativeId) uuids.add(nativeId);

  let mode = null;
  let semanticFromLock = null;
  // #1167 — the SECOND semantic bridge. `orchestrator.session.ended` carries
  // `semantic_session_id` alongside the raw UUID since #1068 AC1, but nothing
  // read it: a session that LOST the lock-acquire race emits no lock.acquired,
  // so the lock bridge above resolved null and the caller fell through to the
  // synthetic-id mint — writing a SECOND `abandoned` stub for a session the
  // SessionEnd hook had already recorded under its semantic id. Measured
  // 2026-09-02 @ c3ab480: 8 such duplicate pairs in sessions.jsonl.
  let semanticFromEvents = null;
  // Plan-time shape measurement (see EVENT_SHAPE_RESOLVED). Latest wins — a
  // session may re-resolve its shape, and the last resolution is the one it ran.
  // "Latest" is only decidable for a record that CARRIES a parseable timestamp:
  // an undated one has no place in the order, so it may never displace a dated
  // reading (the earlier `Number.isNaN(ts) => ordered` inverted exactly that and
  // let an undated record win over a later, well-dated one).
  let shapeSessionType = null;
  let shapeSessionProfile = null;
  let shapeTs = null;
  // True while the readings above come from an UNDATED record — kept only for
  // lack of a dated one, and surfaced so the caller can mark it low-confidence.
  let shapeUndated = false;

  // First pass — bridge the UUID set + carry mode + semantic id. lock.acquired
  // is the original bridge; session.ended is the #1167 addition;
  // shape_resolved is the plan-time type/profile measurement.
  for (const ev of events) {
    const isLock = ev.event === EVENT_LOCK_ACQUIRED;
    const isEnded = ev.event === EVENT_ENDED && typeof ev.semantic_session_id === 'string';
    const isShape = ev.event === EVENT_SHAPE_RESOLVED;
    if (!isLock && !isEnded && !isShape) continue;
    const matchesUuid = nativeId && ev.session_id === nativeId;
    // A label can be reused. Once a native UUID is known, a same-label event
    // from another UUID must not expand the session whose work we recover.
    const matchesSemantic = !nativeId && (
      (semanticSessionId && ev.semantic_session_id === semanticSessionId) ||
      (sessionId && ev.semantic_session_id === sessionId)
    );
    if (!matchesUuid && !matchesSemantic) continue;
    if (typeof ev.session_id === 'string') uuids.add(ev.session_id);
    if (isLock) {
      if (typeof ev.mode === 'string') mode = ev.mode;
      if (typeof ev.semantic_session_id === 'string') semanticFromLock = ev.semantic_session_id;
    } else if (isEnded) {
      semanticFromEvents = ev.semantic_session_id;
    }
    if (isShape) {
      const ts = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
      if (!Number.isNaN(ts)) {
        // Dated record: ordinary latest-wins.
        if (shapeTs === null || ts >= shapeTs) {
          if (shapeUndated) {
            // A dated record outranks an undated one unconditionally. The
            // undated readings were never orderable, so they are DISCARDED
            // rather than merged — otherwise a profile read off an undated
            // record would survive into a dated win it never belonged to.
            shapeSessionType = null;
            shapeSessionProfile = null;
            shapeUndated = false;
          }
          shapeTs = shapeTs === null ? ts : Math.max(shapeTs, ts);
          if (typeof ev.session_type === 'string') shapeSessionType = ev.session_type;
          // Absent is not empty: the emitter OMITS the key when there is no
          // profile, so only a present string may overwrite a previous reading.
          if (typeof ev.session_profile === 'string') shapeSessionProfile = ev.session_profile;
        }
      } else if (shapeTs === null && !shapeUndated) {
        // Undated record: usable only while NO dated record has been seen, and
        // never as a tie-breaker between two of them.
        const hasType = typeof ev.session_type === 'string';
        const hasProfile = typeof ev.session_profile === 'string';
        if (hasType) shapeSessionType = ev.session_type;
        if (hasProfile) shapeSessionProfile = ev.session_profile;
        if (hasType || hasProfile) shapeUndated = true;
      }
    }
  }

  // Second pass — started + terminal timestamps from every matched UUID.
  let startedAt = null;
  let branch = null;
  let project = null;
  let lastTerminalMs = null;
  let earliestMs = null;
  // lastEventMs (#731): max timestamp over ALL matched events (not just the
  // terminal STOPPED/ENDED subset lastTerminalMs tracks) — the dead-by-age
  // relaxation needs "when did we last hear from this candidate at all",
  // since a session that never emitted a terminal event is exactly the
  // abandoned case this module exists to reconstruct.
  let lastEventMs = null;

  for (const ev of events) {
    if (typeof ev.session_id !== 'string' || !uuids.has(ev.session_id)) continue;
    const ts = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      earliestMs = earliestMs === null ? ts : Math.min(earliestMs, ts);
      lastEventMs = lastEventMs === null ? ts : Math.max(lastEventMs, ts);
    }

    if (ev.event === EVENT_STARTED) {
      if (typeof ev.timestamp === 'string') startedAt = ev.timestamp;
      if (typeof ev.branch === 'string' && ev.branch.length > 0) branch = ev.branch;
      if (typeof ev.project === 'string') project = ev.project;
    } else if (ev.event === EVENT_STOPPED || ev.event === EVENT_TURN_STOPPED || ev.event === EVENT_ENDED) {
      if (!Number.isNaN(ts)) {
        lastTerminalMs = lastTerminalMs === null ? ts : Math.max(lastTerminalMs, ts);
      }
      if (typeof ev.branch === 'string' && ev.branch.length > 0 && !branch) branch = ev.branch;
    }
  }

  return {
    uuids,
    mode,
    shapeSessionType,
    shapeSessionProfile,
    shapeUndated,
    semanticFromLock,
    semanticFromEvents,
    startedAt,
    branch,
    project,
    lastTerminalMs,
    earliestMs,
    lastEventMs,
  };
}

/**
 * Determine whether a candidate should be treated as dead-by-age DESPITE a
 * live FOREIGN session.lock (#731 — the historical migration CLI blocks
 * itself: every run happens FROM an active session, so the current lock is
 * always live and shadows every candidate regardless of how old it is).
 *
 * True when EITHER:
 *   - `assumeDeadBeforeMs` is set and the candidate's last known event
 *     strictly PREDATES it (operator-supplied cutoff, CLI `--assume-dead-before`).
 *   - `relaxDeadByAge` is set and the candidate's last known event is older
 *     than the lock's own default TTL window (`DEFAULT_TTL_HOURS`) — a
 *     session that stopped emitting events longer ago than a lock can even
 *     stay live cannot legitimately be "blocked" by that unrelated lock.
 *
 * Both conditions require a resolvable `lastEventMs` — an unknown last-event
 * time (gap in events.jsonl) never unlocks the relaxation, erring toward the
 * existing conservative (block) behaviour. NOT exported: internal to the
 * liveness guard below; default caller behaviour (both params absent) always
 * returns false, i.e. identical to pre-#731 behaviour.
 *
 * @param {{ relaxDeadByAge: boolean, assumeDeadBeforeMs: number|null, lastEventMs: number|null, nowMs: number }} args
 * @returns {boolean}
 */
function isCandidateDeadByAge({ relaxDeadByAge, assumeDeadBeforeMs, lastEventMs, nowMs }) {
  if (typeof lastEventMs !== 'number' || Number.isNaN(lastEventMs)) return false;
  if (
    typeof assumeDeadBeforeMs === 'number' &&
    !Number.isNaN(assumeDeadBeforeMs) &&
    lastEventMs < assumeDeadBeforeMs
  ) {
    return true;
  }
  if (relaxDeadByAge === true) {
    const ttlMs = DEFAULT_TTL_HOURS * 3600 * 1000;
    if (nowMs - lastEventMs > ttlMs) return true;
  }
  return false;
}

/**
 * Build a backfilled stub record. Required fields with no events source are
 * defaulted to empty/zero and enumerated in `_backfill_incomplete_fields`;
 * the mode → session_type coercion sets `_session_type_inferred`.
 *
 * `status` / `backfillSource` are parameterized (#429 — the STATE.md
 * `status: completed` backfill below reuses this exact synthesis, just with
 * a different terminal status and provenance tag). Defaults reproduce the
 * original `backfillAbandonedSession` behaviour exactly for existing callers.
 *
 * `supersedes` (#1068 AC3, default `null`) stamps the id of the backfill STUB
 * this record replaces. It is emitted only when non-null, so every existing
 * record shape is byte-identical to before.
 */
function synthesizeRecord({ recordId, synthetic, gathered, nowMs, status = 'abandoned', backfillSource = 'events-jsonl', supersedes = null, rawSessionId = null }) {
  const startedIso = canonicalIso(gathered.startedAt, gathered.earliestMs ?? nowMs);
  const startedMs = Date.parse(startedIso);
  // completed_at is events-attested, never the backfill-run wall-clock (#914 R1).
  // A fabricated `nowMs` produced ~64h of phantom runtime on real records
  // (e.g. main-2026-07-18-session-2: started 2026-07-18, "completed" 2026-07-21).
  // Precedence, all events-derived — the schema requires a string, so `null`
  // is not an option (session-schema/validator.mjs rejects non-string):
  //   1. lastTerminalMs — a real STOPPED/ENDED event: the true end.
  //   2. lastEventMs — last life-sign; an ESTIMATE (flagged), never the run time.
  //   3. startedIso — no post-start event at all → duration 0 (flagged).
  let completedEstimated = false;
  let completedMs;
  if (Number.isFinite(gathered.lastTerminalMs)) {
    completedMs = gathered.lastTerminalMs;
  } else if (Number.isFinite(gathered.lastEventMs)) {
    completedMs = gathered.lastEventMs;
    completedEstimated = true;
  } else {
    completedMs = startedMs;
    completedEstimated = true;
  }
  // Guard the same monotonic invariant as before: never earlier than started_at.
  const completedIso = new Date(Math.max(startedMs, completedMs)).toISOString();

  // Precedence: the plan-time shape beats the lock's SessionStart `mode`.
  // `lock.acquired` fires BEFORE the operator types `/session <type>`, so its
  // mode is at best a carry-over from the previous session; `shape_resolved` is
  // emitted the moment the confirmed mode became an execution plan, i.e. it is
  // the only MEASUREMENT of what this session was. Any session that reached
  // plan time is therefore no longer `_session_type_inferred`.
  // An unknown value in either source is IGNORED, never written — the record
  // then stays `unknown` + inferred rather than carrying an unvalidatable type.
  let sessionType = UNMEASURED_SESSION_TYPE;
  let inferred = true;
  if (gathered.shapeSessionType && MEASURED_SESSION_MODES.has(gathered.shapeSessionType)) {
    sessionType = gathered.shapeSessionType;
    // A shape record with a missing/unparseable timestamp is taken only for
    // lack of a dated one, and it cannot be proven to be the LAST resolution —
    // so the type is used but stays flagged `_session_type_inferred: true`.
    inferred = gathered.shapeUndated === true;
  } else if (gathered.mode && MEASURED_SESSION_MODES.has(gathered.mode)) {
    sessionType = gathered.mode;
    inferred = false;
  }

  // `session_profile` — WRITTEN ONLY WHEN MEASURED. Absent is not empty: a
  // `null`/`''` on the record would read as "measured, no profile", which is
  // exactly the honesty defect the enum-plus-omission contract exists to avoid
  // (VALID_SESSION_PROFILES, session-schema/constants.mjs).
  const sessionProfile =
    typeof gathered.shapeSessionProfile === 'string'
      && VALID_SESSION_PROFILES.includes(gathered.shapeSessionProfile)
      ? gathered.shapeSessionProfile
      : null;

  const startedFound = typeof gathered.startedAt === 'string';
  const branchFound = typeof gathered.branch === 'string' && gathered.branch.length > 0;

  const incomplete = ['total_waves', 'waves', 'agent_summary', 'total_agents', 'total_files_changed'];
  if (!startedFound) incomplete.push('started_at');
  if (!branchFound) incomplete.push('branch');
  // completed_at was estimated from lastEventMs (or defaulted to started_at) —
  // no terminal event was found, so mark it incomplete so downstream duration
  // consumers can tell an events-attested end apart from an estimate (#914 R1).
  if (completedEstimated) incomplete.push('completed_at');

  const record = {
    session_id: recordId,
    session_type: sessionType,
    started_at: startedIso,
    completed_at: completedIso,
    total_waves: 0,
    waves: [],
    agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
    total_agents: 0,
    total_files_changed: 0,
    status,
    // Issue #773 — a backfilled stub never ran (or cannot be proven to have
    // run) Phase 1.65, so its carryover is genuinely UNKNOWN. Emit `null` (not
    // 0) so downstream effectiveness consumers can tell "not measured" apart
    // from "measured zero" — 0 here would resurrect the very carryover=0
    // blind spot #773 exists to close.
    effectiveness: { carryover: null },
    _backfill_source: backfillSource,
    _backfill_incomplete_fields: incomplete,
  };
  if (branchFound) record.branch = gathered.branch;
  if (sessionProfile) record.session_profile = sessionProfile;
  if (inferred) {
    record._session_type_inferred = true;
    // GitLab #1234 — BACKFILLER HONESTY, half landed 2026-09-06.
    //
    // `session_type` above is now `'unknown'`, not the old `'housekeeping'`
    // DEFAULT that nothing in events.jsonl ever said. Measured 2026-09-06, all
    // 1.656 `abandoned` records in the 90-day fleet window carry
    // `_session_type_inferred: true` + `total_waves: 0`, and NO organically
    // written `abandoned` record exists anywhere — that `housekeeping` guess is
    // what produced the "27 % close rate" figure that turned out to be an
    // artefact (the real rate is 21,3 %). VALID_SESSION_TYPES was widened with
    // `unknown` in `scripts/lib/session-schema/constants.mjs` to make this
    // sayable; historical records keep their `housekeeping` label verbatim
    // (sessions.jsonl is append-only), so a reader wanting the honest
    // population still filters on `_synthetic !== true` rather than on the type.
    //
    // The OTHER half is deliberately NOT landed: `status` stays `'abandoned'`
    // even though `'unresolved'` is the honest word and the schema now accepts
    // it. Six executable phantom-stub filters key on the literal `abandoned`
    // (census + revisit trigger in `scripts/lib/session-schema/validator.mjs`
    // § SESSION_STATUS) and none of them is in this change's file scope —
    // flipping the emitter first would make every new stub invisible to all six
    // and re-open the #834 phantom-in-signal class fleet-wide. Repoint those
    // filters onto one both-accepting predicate, then flip this one line.
    //
    // `_synthetic: true` still carries the claim no enum can: this record was
    // COMPOSED. A consumer that filters on `_synthetic !== true` gets only
    // measured records without needing to know either enum.
    record._synthetic = true;
  }
  if (synthetic) record._synthetic_session_id = true;
  if (completedEstimated) record._completed_at_estimated = true;
  // #1068 AC3/AC4 — forensic supersede marker. sessions.jsonl is append-only,
  // so the stub itself cannot be stamped `superseded_by`; the FORWARD pointer
  // lives on the newer record instead, and the stub survives verbatim (AC4:
  // "historische Stub-Provenance bleibt erhalten"). Readers resolve one
  // canonical state per id by taking the NEWEST record for that id.
  if (typeof supersedes === 'string' && supersedes.length > 0) record.supersedes = supersedes;
  // #1167 — the harness UUID this record was reconstructed from, when known.
  // Additive and optional (the schema validates unknown keys pass-through, see
  // session-schema/validator.mjs `_validateOptionalFields`): it is the ONLY key
  // that lets a reader join a semantic record back to its raw uuid. Measured
  // 2026-09-02 @ c3ab480: 0 of 286 existing records carry it, which is exactly
  // why the two backfill writers could not see each other's work.
  if (typeof rawSessionId === 'string' && rawSessionId.length > 0) record.raw_session_id = rawSessionId;
  return record;
}

/**
 * Terminal statuses that mark a ledger record as a BACKFILLED STUB rather than
 * an authoritative close (#1068 AC3).
 *
 * `abandoned` is the only member today: it is what `backfillAbandonedSession`
 * writes when a session never reached `/close`, i.e. a reconstruction, never a
 * self-reported outcome. `completed` is deliberately NOT a member — including
 * the `state-md-completed` backfill, whose status IS the session's own truth
 * claim. That exclusion is also what makes supersede idempotent: the record
 * appended by a supersede is `completed`, so a second run classifies it as
 * canonical and skips instead of superseding its own predecessor forever.
 */
const BACKFILL_STUB_STATUSES = new Set(['abandoned']);

/**
 * True when a sessions.jsonl record is a backfilled STUB — reconstructed
 * provenance (`_backfill_source`) AND a stub status. Both are required: a
 * hand-written `abandoned` record with no backfill provenance is somebody's
 * deliberate statement and is never superseded on our own initiative.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
function isBackfillStub(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record._backfill_source !== 'string') return false;
  return BACKFILL_STUB_STATUSES.has(record.status);
}

/**
 * Find the newest ledger record for one physical session. Shared by the close
 * precheck and backfill dedupe; no file I/O or mutation.
 *
 * Native identity wins over the attribution label. A conflicting native UUID
 * vetoes a label match. Legacy records without a native join remain readable;
 * when both start times are known they must name the same instant.
 *
 * @param {object[]} records parsed JSONL records, in append order
 * @param {{sessionId?: string|null, semanticSessionId?: string|null, startedAt?: string|null}} ids
 * @returns {object|null} existing record, or null when no identity matches
 */
export function findRecordedSession(records, { sessionId = null, semanticSessionId = null, startedAt = null } = {}) {
  // Identity strength cannot resurrect an overwritten/superseded stub. Use
  // the canonical reader, while retaining append order across surviving keys.
  const canonical = new Set(canonicalizeSessions(records));
  const nativeId = isUuid(sessionId) ? sessionId : isUuid(semanticSessionId) ? semanticSessionId : null;
  const label = semanticSessionId || sessionId;
  const startMs = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  let legacyMatch = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!canonical.has(record)) continue;
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.session_id !== 'string' || !record.session_id) continue;
    const nativeKeys = [record.session_id, record.raw_session_id].filter(isUuid);
    if (nativeId && nativeKeys.length > 0) {
      if (nativeKeys.every((id) => id === nativeId)) return record;
      continue;
    }
    if (!label || (record.session_id !== label && record.semantic_session_id !== label)) continue;
    // A backfill's fallback timestamp is explicitly unmeasured; treating it as
    // a conflicting start would defeat idempotence on the very next close.
    const incompleteStart = Array.isArray(record._backfill_incomplete_fields)
      && record._backfill_incomplete_fields.includes('started_at');
    const recordStart = !incompleteStart && typeof record.started_at === 'string' ? Date.parse(record.started_at) : NaN;
    if (Number.isFinite(startMs) && Number.isFinite(recordStart) && startMs !== recordStart) continue;
    legacyMatch ??= record;
  }
  return legacyMatch;
}

/**
 * Classify what sessions.jsonl already holds for this identity (#1068 AC3/AC4).
 *
 * Reads the (small) sessions.jsonl exactly once and returns one of:
 *   { kind: 'absent' }                                — nothing recorded yet
 *   { kind: 'canonical', matchedId }                  — an authoritative record exists
 *   { kind: 'stub', matchedId, stubId }               — only a backfilled stub exists
 *
 * "Newest wins" is the reading rule: sessions.jsonl is APPEND-ONLY, so a
 * superseding record can never rewrite the stub in place — it is appended
 * after it, and the LAST record for an id is therefore the current one. This
 * function reads the same way (last match, not first), so a stub that has
 * already been superseded classifies as `canonical` and is never superseded
 * twice.
 *
 * @param {Function} readFileSync
 * @param {string} sessionsPath
 * @param {{recordId: string, sessionId: string|null, semanticSessionId?: string|null, startedAt?: string|null}} ids
 */
function classifyExisting(readFileSync, sessionsPath, { recordId, sessionId, semanticSessionId = recordId, startedAt = null }) {
  const sessionRecords = readJsonlSafe(readFileSync, sessionsPath);
  const newest = findRecordedSession(sessionRecords, { sessionId, semanticSessionId, startedAt });
  if (!newest) return { kind: 'absent' };
  if (isBackfillStub(newest)) {
    return { kind: 'stub', matchedId: newest.session_id, stubId: newest.session_id };
  }
  return { kind: 'canonical', matchedId: newest.session_id };
}

/**
 * Dedupe against sessions.jsonl. Returns a `skipped-already-recorded` result
 * when `recordId` (or a UUID `sessionId` written directly as a key) is already
 * present, else `null`.
 *
 * HARD dedupe by design — it is the guard for `backfillAbandonedSession`, whose
 * output is itself a stub: replacing one stub with another buys nothing and
 * would re-append on every SessionEnd. The supersede path (#1068 AC3) belongs
 * to the AUTHORITATIVE writer only; see `classifyExisting` + its use in
 * `backfillCompletedFromStateMd`.
 */
function checkAlreadyRecorded(readFileSync, sessionsPath, { recordId, sessionId }) {
  const existing = classifyExisting(readFileSync, sessionsPath, { recordId, sessionId });
  if (existing.kind === 'absent') return null;
  return { action: 'skipped-already-recorded', sessionId: existing.matchedId };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Backfill an abandoned session record into sessions.jsonl from events.jsonl.
 *
 * Never throws. Returns one of:
 *   { action: 'backfilled', sessionId, record, deadByAge? }        — written to disk
 *   { action: 'would-backfill', sessionId, record, deadByAge? }    — dryRun only, not written
 *   { action: 'skipped-no-identifier' }                — neither id known
 *   { action: 'skipped-already-recorded', sessionId }  — already in sessions.jsonl
 *   { action: 'skipped-own-live-lock', sessionId }     — candidate IS this live session (#863)
 *   { action: 'skipped-foreign-live-lock', sessionId, lockSessionId }
 *   { action: 'skipped-marker-exists', sessionId }     — lost the TOCTOU claim
 *   { action: 'error', error, sessionId? }             — any failure, swallowed
 *
 * `deadByAge: true` is present on `backfilled` / `would-backfill` ONLY when a
 * foreign live lock was present AND bypassed via `relaxDeadByAge` /
 * `assumeDeadBeforeMs` (#731) — it never appears on the default path, so
 * callers can distinguish "genuinely no conflicting lock" from "we relaxed
 * past one" without re-deriving the guard logic.
 *
 * @param {object} args
 * @param {string}  args.repoRoot                 absolute project root
 * @param {string|null} [args.sessionId]          harness UUID (SessionEnd stdin) or semantic id
 * @param {string|null} [args.semanticSessionId]  semantic id when already known (current-session.json)
 * @param {number|string} [args.now]              ms-since-epoch (test seam) or ISO string
 * @param {boolean} [args.dryRun=false]           compute + validate only, no marker/write
 * @param {boolean} [args.relaxDeadByAge=false]
 *   #731 — when true, a FOREIGN live lock no longer blocks a candidate whose
 *   last known event (`lastEventMs`) is older than `DEFAULT_TTL_HOURS`
 *   (session-lock.mjs SSOT). Purely additive: default `false` reproduces the
 *   original always-block behaviour EXACTLY. Intended for the one-time
 *   historical migration CLI only — `hooks/on-session-end.mjs` must NEVER
 *   pass this (a hook-time foreign lock is by definition a real, active
 *   session, not stale history).
 * @param {number|null} [args.assumeDeadBeforeMs=null]
 *   #731 — operator-supplied cutoff (ms-since-epoch). A candidate whose
 *   `lastEventMs` strictly predates this value bypasses a foreign live lock
 *   regardless of `relaxDeadByAge`. Corresponds to the CLI's
 *   `--assume-dead-before <ISO>` flag.
 * @param {object}  [args.deps]                   DI overrides (fs, appendJsonl, readLock, …)
 * @returns {Promise<object>}
 */
export async function backfillAbandonedSession({
  repoRoot,
  sessionId = null,
  semanticSessionId = null,
  now = Date.now(),
  dryRun = false,
  relaxDeadByAge = false,
  assumeDeadBeforeMs = null,
  deps = {},
} = {}) {
  const {
    readFileSync = fs.readFileSync,
    appendJsonl = defaultAppendJsonl,
    readLock = defaultReadLock,
    isLockLive = defaultIsLockLive,
    openSync = fs.openSync,
    closeSync = fs.closeSync,
    validateSession = defaultValidateSession,
    serializeSessionLineChecked = defaultSerialize,
    log = null,
  } = deps;

  const nowMs = resolveNowMs(now);
  const result = await run();
  logBreadcrumb(result);
  return result;

  async function run() {
    try {
      if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
        return { action: 'error', error: 'repoRoot must be a non-empty string' };
      }
      if (!sessionId && !semanticSessionId) {
        return { action: 'skipped-no-identifier' };
      }

      const eventsPath = path.join(repoRoot, ...EVENTS_REL);
      const sessionsPath = path.join(repoRoot, ...SESSIONS_REL);

      // -- Resolve the SEMANTIC record id (sessions.jsonl key) ----------------
      // Two-phase so the common SessionEnd path stays cheap: when the id is
      // already known WITHOUT scanning events (semanticSessionId given, or
      // sessionId is itself a semantic id), dedupe against the tiny
      // sessions.jsonl FIRST and short-circuit if the record already exists —
      // avoiding the two-pass walk over an events.jsonl that can be MBs. The
      // events read is deferred to the branches that genuinely need it: the
      // UUID→semantic lock bridge, the synthetic-id mint, and record synthesis.
      // (When sessionId is a non-UUID semantic id, the ORIGINAL lock-bridge
      //  branch resolved to that SAME id — collectSessionEvents only sets
      //  semanticFromLock=sessionId in that case — so resolving it early is
      //  behaviour-identical, just cheaper.)
      let recordId = null;
      let synthetic = false;
      if (semanticSessionId) {
        recordId = semanticSessionId;
      } else if (sessionId && !isUuid(sessionId)) {
        // sessionId is already a semantic id (Claude Code generated-semantic path).
        recordId = sessionId;
      }

      // -- Cheap dedupe FIRST when the id needs no events scan -----------------
      if (recordId !== null) {
        const dupe = checkAlreadyRecorded(readFileSync, sessionsPath, { recordId, sessionId });
        if (dupe) return dupe;
      }

      // -- Read events (needed to synthesize, and to bridge UUID→semantic) ----
      const events = readJsonlSafe(readFileSync, eventsPath);
      const gathered = collectSessionEvents(events, { sessionId, semanticSessionId });

      // -- Resolve a deferred id from the lock bridge or a synthetic mint ------
      if (recordId === null) {
        // Prefer the lock bridge (it also carries `mode`), then the #1167
        // session.ended bridge. Only when NEITHER attests a semantic id do we
        // mint a synthetic one — that fallback was the duplicate-stub source.
        if (gathered.semanticFromLock || gathered.semanticFromEvents) {
          recordId = gathered.semanticFromLock || gathered.semanticFromEvents;
        } else {
          // No semantic bridge — mint a synthetic id. Both components are STABLE
          // across re-runs so dedupe/marker suppress a double write (idempotency
          // is load-bearing for the one-time CLI, #724 C1):
          //   - date  ← the session's own started_at (immutable in events), not
          //             run-time now, so a migration run on any day is stable.
          //   - suffix← sha256 of the source UUID, not random.
          const branchSlug = (gathered.branch || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '-');
          const date = canonicalIso(gathered.startedAt, gathered.earliestMs ?? nowMs).slice(0, 10);
          const suffix = crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8);
          recordId = `${branchSlug}-${date}-abandoned-${suffix}`;
          synthetic = true;
        }

        // Dedupe once the events-derived id is known.
        const dupe = checkAlreadyRecorded(readFileSync, sessionsPath, { recordId, sessionId });
        if (dupe) return dupe;
      }

      // Dedupe rejected any foreign native identity above. Do not now reuse
      // that session's semantic key: canonical readers collapse by session_id.
      // Keep the existing legacy key convention unless the key is occupied.
      const semanticRecordId = recordId;
      if (isUuid(sessionId) && recordId !== sessionId
        && readJsonlSafe(readFileSync, sessionsPath).some((record) => record?.session_id === recordId)) {
        recordId = sessionId;
      }

      // -- Liveness guard — never overwrite a FOREIGN live lock, and never ----
      // record OUR OWN live lock as 'abandoned' (#863 defect 1). Before this
      // fix, the guard below only ever ran when `foreign` was true — the
      // "this candidate IS the currently-live session" branch fell straight
      // through to synthesis + append, backfilling a session as 'abandoned'
      // mere seconds after it started (observed on-disk: main-2026-07-21-
      // session-2, started 13:58:28.189Z, recorded abandoned 13:58:31.065Z).
      //
      // deadByAge (#731): set when a foreign live lock was present but the
      // candidate qualified for relaxation — surfaced on the final result so
      // callers (the migration CLI's summary) can count relaxed backfills.
      let deadByAge = false;
      let lock = null;
      try {
        lock = readLock({ repoRoot });
      } catch {
        lock = null;
      }
      if (lock) {
        const ownByUuid = Boolean(sessionId) && lock.session_id === sessionId;
        const ownBySemantic =
          (Boolean(semanticSessionId) && lock.semantic_session_id === semanticSessionId) ||
          (Boolean(recordId) && lock.semantic_session_id === recordId) ||
          // #863 (d) — lock-shape trap: some on-disk locks store the semantic
          // id directly in `session_id` with no separate `semantic_session_id`
          // field at all (the "generated-semantic" acquisition path in
          // on-session-start.mjs mints `session_id === the semantic id`, and
          // bootstrapLock's v2 enrichment step — which would otherwise add
          // `semantic_session_id` — never ran for that lock). Without this
          // fallback, ownBySemantic is dead code for that shape and a
          // genuinely-own lock is misclassified `foreign`, which can then be
          // wrongly bypassed by the dead-by-age relaxation below despite
          // being live right now.
          (Boolean(semanticSessionId) && lock.session_id === semanticSessionId) ||
          (Boolean(recordId) && lock.session_id === recordId);
        const own = ownByUuid || ownBySemantic;
        const foreign = !own;

        // #863 defect 1 — an OWN lock that is still live means this session
        // is actively running right now; it must never be recorded
        // 'abandoned'. Runs BEFORE the foreign-live-lock guard below (which
        // only ever fires when `foreign` is true). A STALE own lock
        // (isLockLive === false) falls through unchanged — this is a
        // liveness gate, not a blanket own-session off-switch.
        if (own && isLockLive(lock, nowMs)) {
          return { action: 'skipped-own-live-lock', sessionId: recordId };
        }

        if (foreign && isLockLive(lock, nowMs)) {
          const relaxed = isCandidateDeadByAge({
            relaxDeadByAge,
            assumeDeadBeforeMs,
            lastEventMs: gathered.lastEventMs,
            nowMs,
          });
          if (!relaxed) {
            return { action: 'skipped-foreign-live-lock', sessionId: recordId, lockSessionId: lock.session_id };
          }
          deadByAge = true;
        }
      }

      // -- Synthesize + validate (round-trip gate) BEFORE any disk mutation ---
      const record = synthesizeRecord({
        recordId,
        synthetic,
        gathered,
        nowMs,
        rawSessionId: isUuid(sessionId) ? sessionId : null,
      });
      if (recordId !== semanticRecordId) record.semantic_session_id = semanticRecordId;
      let validated;
      try {
        validated = validateSession(record);
        serializeSessionLineChecked(record);
      } catch (err) {
        return { action: 'error', error: `validation: ${err?.message ?? String(err)}`, sessionId: recordId };
      }

      if (dryRun) {
        return {
          action: 'would-backfill',
          sessionId: recordId,
          record: validated,
          ...(deadByAge ? { deadByAge: true } : {}),
        };
      }

      // -- TOCTOU marker — atomic create-or-fail keyed by the final id --------
      const markerPath = path.join(repoRoot, '.orchestrator', 'metrics', markerName(recordId));
      try {
        const fd = openSync(markerPath, 'wx');
        closeSync(fd);
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          return { action: 'skipped-marker-exists', sessionId: recordId };
        }
        // Any other fs error on the marker → refuse to write without the guard.
        return { action: 'error', error: `marker: ${err?.message ?? String(err)}`, sessionId: recordId };
      }

      // -- Write via the shared append path -----------------------------------
      try {
        await appendJsonl(sessionsPath, validated);
      } catch (err) {
        return { action: 'error', error: `append: ${err?.message ?? String(err)}`, sessionId: recordId };
      }
      return {
        action: 'backfilled',
        sessionId: recordId,
        record: validated,
        ...(deadByAge ? { deadByAge: true } : {}),
      };
    } catch (err) {
      // Absolute backstop — the hook must never see an exception from here.
      return { action: 'error', error: err?.message ?? String(err) };
    }
  }

  /** Best-effort JSONL breadcrumb (project-local; never cascades). */
  function logBreadcrumb(res) {
    try {
      if (typeof log === 'function') {
        log(res);
        return;
      }
      if (typeof repoRoot !== 'string' || repoRoot.length === 0) return;
      const logPath = path.join(repoRoot, ...BACKFILL_LOG_REL);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          timestamp: new Date(nowMs).toISOString(),
          action: res.action,
          session_id: res.sessionId ?? null,
          ...(res.error ? { error: res.error } : {}),
        }) + '\n',
        'utf8'
      );
    } catch {
      /* never let logging cascade into the caller */
    }
  }
}

/**
 * Backfill a `status: 'completed'` session record from STATE.md when STATE.md
 * itself already carries `status: completed` but sessions.jsonl has no
 * matching record (#429).
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
 *   `commands/close.md`'s Pre-Check treats `STATE.md status: completed` as
 *   PROOF that the session-end skill's Phase 3.7 writer already ran, and
 *   stops before invoking it — including when `status: completed` was set by
 *   hand (or by any path that never reached Phase 3.7). The session then has
 *   no record in sessions.jsonl, permanently: nothing else ever re-drives the
 *   write, because the Pre-Check keeps refusing to invoke session-end for as
 *   long as STATE.md says `completed`. This function is the mechanical
 *   self-heal — every SessionEnd hook firing checks the invariant
 *   "STATE.md completed ⇒ a record exists" and repairs it once, regardless of
 *   which session's hook happens to run next.
 *
 * ── WHY `status: 'completed'`, NOT `'abandoned'` ─────────────────────────
 *   `backfillAbandonedSession` (above) marks its stub `abandoned` because a
 *   session that never reached `/close` is, by definition, unfinished. This
 *   case is the opposite: STATE.md's own `status: completed` is a truth claim
 *   the session made about itself — only the LEDGER write failed to run. The
 *   record is tagged `_backfill_source: 'state-md-completed'` (never
 *   `'events-jsonl'`) so a later reader can tell the two backfill classes
 *   apart at a glance.
 *
 * ── DATA SOURCE ──────────────────────────────────────────────────────────
 *   Required numeric counters (`total_waves`, `total_agents`,
 *   `total_files_changed`, `agent_summary`) are derived ONLY from
 *   events.jsonl via the same `collectSessionEvents` + `synthesizeRecord`
 *   machinery `backfillAbandonedSession` uses — never from STATE.md's own
 *   body sections (Wave History, etc.), which this module deliberately never
 *   parses. Schema `REQUIRED_FIELDS` forbids `null` on these (non-negative
 *   number, `session-schema/validator.mjs`), so "otherwise null" is realized
 *   as "otherwise 0, flagged in `_backfill_incomplete_fields`" — the same
 *   contract the abandoned path already carries and the same reason it exists.
 *
 *   A native `session-id` in STATE.md seeds event correlation directly and
 *   keys the new record; `session` is retained as `semantic_session_id`.
 *   Legacy STATE.md without a native UUID keeps its semantic record key and
 *   needs a lock.acquired/session.ended bridge to recover UUID-scoped events.
 *   Without either identity route, timestamps fall back to `now` and are
 *   flagged incomplete rather than fabricated from STATE.md body prose.
 *
 * Never throws. Returns one of:
 *   { action: 'backfilled', sessionId, record }              — written to disk
 *   { action: 'superseded', sessionId, record, supersedes }   — written, replacing a stub (#1068 AC3)
 *   { action: 'would-backfill', sessionId, record }           — dryRun only
 *   { action: 'would-supersede', sessionId, record, supersedes } — dryRun only
 *   { action: 'skipped-no-state-md' }                — no STATE.md at any candidate path
 *   { action: 'skipped-unparseable-state-md' }        — frontmatter did not parse
 *   { action: 'skipped-not-completed', status }       — STATE.md status isn't 'completed'
 *   { action: 'skipped-no-session-id' }               — completed but no `session:` field
 *   { action: 'skipped-already-recorded', sessionId } — sessions.jsonl already has it
 *   { action: 'skipped-marker-exists', sessionId }    — lost the TOCTOU claim
 *   { action: 'error', error, sessionId? }             — any failure, swallowed
 *
 * @param {object} args
 * @param {string} args.repoRoot            absolute project root
 * @param {number|string} [args.now]        ms-since-epoch (test seam) or ISO string
 * @param {boolean} [args.dryRun=false]      compute + validate only, no marker/write
 * @param {object} [args.deps]               DI overrides (fs, appendJsonl, resolveStateMdPath, …)
 * @returns {Promise<object>}
 */
export async function backfillCompletedFromStateMd({
  repoRoot,
  now = Date.now(),
  dryRun = false,
  deps = {},
} = {}) {
  const {
    readFileSync = fs.readFileSync,
    appendJsonl = defaultAppendJsonl,
    openSync = fs.openSync,
    closeSync = fs.closeSync,
    validateSession = defaultValidateSession,
    serializeSessionLineChecked = defaultSerialize,
    resolveStateMdPath = defaultResolveStateMdPath,
    parseStateMd = defaultParseStateMd,
    log = null,
  } = deps;

  const nowMs = resolveNowMs(now);
  const result = await run();
  logBreadcrumb(result);
  return result;

  async function run() {
    try {
      if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
        return { action: 'error', error: 'repoRoot must be a non-empty string' };
      }

      // -- Read + parse STATE.md ------------------------------------------------
      const stateMdPath = resolveStateMdPath(repoRoot);
      let raw;
      try {
        raw = readFileSync(stateMdPath, 'utf8');
      } catch {
        return { action: 'skipped-no-state-md' };
      }
      const parsed = parseStateMd(raw);
      if (parsed === null) {
        return { action: 'skipped-unparseable-state-md' };
      }

      const stateStatus = parsed.frontmatter?.status;
      if (stateStatus !== 'completed') {
        return { action: 'skipped-not-completed', status: stateStatus ?? null };
      }

      const semanticSessionId = parsed.frontmatter?.session;
      if (typeof semanticSessionId !== 'string' || semanticSessionId.length === 0) {
        return { action: 'skipped-no-session-id' };
      }
      const stateSessionId = parsed.frontmatter?.['session-id'];
      const nativeId = isUuid(stateSessionId) ? stateSessionId : isUuid(semanticSessionId) ? semanticSessionId : null;
      let recordId = nativeId ?? semanticSessionId;

      // -- Dedupe, or SUPERSEDE a backfill stub (#1068 AC3) ---------------------
      // This is the authoritative writer of the pair: STATE.md's own
      // `status: completed` is the session's truth claim about itself, and it
      // arrives with the native UUID or legacy semantic key. When the only
      // thing on file for that identity is a reconstructed `abandoned` stub,
      // the stub is a measurement this record refutes — so we append the fuller
      // record (carrying `supersedes: <stub id>`) instead of skipping. An
      // authoritative record already on file still short-circuits exactly as
      // before.
      const sessionsPath = path.join(repoRoot, ...SESSIONS_REL);
      const existing = classifyExisting(readFileSync, sessionsPath, {
        recordId,
        sessionId: nativeId,
        semanticSessionId,
        startedAt: parsed.frontmatter?.started_at,
      });
      if (existing.kind === 'canonical') {
        return { action: 'skipped-already-recorded', sessionId: existing.matchedId };
      }
      const supersedes = existing.kind === 'stub' ? existing.stubId : null;
      // Preserve a matched stub's key for its append-only replacement. Without
      // event timestamps or a raw join on a legacy stub, a new UUID key would
      // leave two canonical sessions: its supersedes proof is unattestable.
      if (supersedes) recordId = supersedes;

      // -- Derive whatever is derivable from events.jsonl (never STATE.md body) -
      const eventsPath = path.join(repoRoot, ...EVENTS_REL);
      const events = readJsonlSafe(readFileSync, eventsPath);
      const gathered = collectSessionEvents(events, { sessionId: nativeId, semanticSessionId });

      // -- Synthesize + validate (round-trip gate) BEFORE any disk mutation ----
      const record = synthesizeRecord({
        recordId,
        synthetic: false,
        gathered,
        nowMs,
        status: 'completed',
        backfillSource: 'state-md-completed',
        supersedes,
        // #1167 — the abandoned path stamps this; so must the authoritative
        // one, or the join key exists on exactly the weaker half of the pair.
        // `gathered.uuids` is bridged from lock.acquired / session.ended, so it
        // normally holds EXACTLY the one uuid this semantic id ran under. Two
        // (or zero) means the bridge is ambiguous — omit rather than guess, the
        // same fail-quiet posture as `isUuid(sessionId) ? sessionId : null`.
        rawSessionId: gathered.uuids?.size === 1 ? [...gathered.uuids][0] : null,
      });
      if (nativeId && semanticSessionId !== nativeId) record.semantic_session_id = semanticSessionId;
      let validated;
      try {
        validated = validateSession(record);
        serializeSessionLineChecked(record);
      } catch (err) {
        return { action: 'error', error: `validation: ${err?.message ?? String(err)}`, sessionId: recordId };
      }

      if (dryRun) {
        return {
          action: supersedes ? 'would-supersede' : 'would-backfill',
          sessionId: recordId,
          record: validated,
          ...(supersedes ? { supersedes } : {}),
        };
      }

      // -- TOCTOU marker — atomic create-or-fail, own namespace so a concurrent
      // abandoned-path claim for the same id can never collide with this one. --
      const markerPath = path.join(repoRoot, '.orchestrator', 'metrics', markerName(`completed-${recordId}`));
      try {
        const fd = openSync(markerPath, 'wx');
        closeSync(fd);
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          return { action: 'skipped-marker-exists', sessionId: recordId };
        }
        return { action: 'error', error: `marker: ${err?.message ?? String(err)}`, sessionId: recordId };
      }

      // -- Write via the shared append path -------------------------------------
      try {
        await appendJsonl(sessionsPath, validated);
      } catch (err) {
        return { action: 'error', error: `append: ${err?.message ?? String(err)}`, sessionId: recordId };
      }
      return {
        action: supersedes ? 'superseded' : 'backfilled',
        sessionId: recordId,
        record: validated,
        ...(supersedes ? { supersedes } : {}),
      };
    } catch (err) {
      // Absolute backstop — the hook must never see an exception from here.
      return { action: 'error', error: err?.message ?? String(err) };
    }
  }

  /** Best-effort JSONL breadcrumb (project-local; never cascades). Shares the
   * same log file as backfillAbandonedSession — the two are distinguishable
   * by `_backfill_source` on the eventual sessions.jsonl record, and by the
   * distinct action vocabulary above (`skipped-not-completed`,
   * `skipped-no-state-md`, …) in the breadcrumb itself. */
  function logBreadcrumb(res) {
    try {
      if (typeof log === 'function') {
        log(res);
        return;
      }
      if (typeof repoRoot !== 'string' || repoRoot.length === 0) return;
      const logPath = path.join(repoRoot, ...BACKFILL_LOG_REL);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          timestamp: new Date(nowMs).toISOString(),
          action: res.action,
          session_id: res.sessionId ?? null,
          ...(res.error ? { error: res.error } : {}),
        }) + '\n',
        'utf8'
      );
    } catch {
      /* never let logging cascade into the caller */
    }
  }
}

/** Normalise the `now` arg (number ms | ISO string | undefined) → ms. */
function resolveNowMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string') {
    const ms = Date.parse(now);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}
