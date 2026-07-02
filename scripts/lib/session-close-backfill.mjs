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
 * ── ID BRIDGE ────────────────────────────────────────────────────────────────
 *   sessions.jsonl records are keyed by SEMANTIC ids (`main-2026-05-27-session-1`).
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
import { readLock as defaultReadLock, isLockLive as defaultIsLockLive } from './session-lock.mjs';
import { validateSession as defaultValidateSession } from './session-schema/validator.mjs';
import { serializeSessionLineChecked as defaultSerialize } from '../emit-session.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** session_type enum accepted by the schema — lock.mode is coerced against it. */
const VALID_SESSION_TYPES = new Set(['feature', 'deep', 'housekeeping']);

const EVENT_STARTED = 'orchestrator.session.started';
const EVENT_LOCK_ACQUIRED = 'orchestrator.session.lock.acquired';
const EVENT_STOPPED = 'orchestrator.session.stopped';
const EVENT_ENDED = 'orchestrator.session.ended';

const EVENTS_REL = ['.orchestrator', 'metrics', 'events.jsonl'];
const SESSIONS_REL = ['.orchestrator', 'metrics', 'sessions.jsonl'];
const BACKFILL_LOG_REL = ['.orchestrator', 'metrics', 'session-close-backfill.log'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when `s` is a canonical UUID (v4-shaped). */
export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Filesystem-safe marker filename for an arbitrary session id. */
function markerName(id) {
  const cleaned = String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return `.backfilled-${cleaned}.marker`;
}

/**
 * Read a JSONL file into an array of parsed objects. Missing file → []; each
 * malformed line is skipped rather than aborting the whole read. Never throws.
 */
function readJsonlSafe(readFileSync, filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
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
  if (isUuid(sessionId)) uuids.add(sessionId);

  let mode = null;
  let semanticFromLock = null;

  // First pass — lock.acquired bridges the UUID set + carries mode + semantic.
  for (const ev of events) {
    if (ev.event !== EVENT_LOCK_ACQUIRED) continue;
    const matchesUuid = isUuid(sessionId) && ev.session_id === sessionId;
    const matchesSemantic =
      (semanticSessionId && ev.semantic_session_id === semanticSessionId) ||
      (!isUuid(sessionId) && sessionId && ev.semantic_session_id === sessionId);
    if (!matchesUuid && !matchesSemantic) continue;
    if (typeof ev.session_id === 'string') uuids.add(ev.session_id);
    if (typeof ev.mode === 'string') mode = ev.mode;
    if (typeof ev.semantic_session_id === 'string') semanticFromLock = ev.semantic_session_id;
  }

  // Second pass — started + terminal timestamps from every matched UUID.
  let startedAt = null;
  let branch = null;
  let project = null;
  let lastTerminalMs = null;
  let earliestMs = null;

  for (const ev of events) {
    if (typeof ev.session_id !== 'string' || !uuids.has(ev.session_id)) continue;
    const ts = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
    if (!Number.isNaN(ts)) earliestMs = earliestMs === null ? ts : Math.min(earliestMs, ts);

    if (ev.event === EVENT_STARTED) {
      if (typeof ev.timestamp === 'string') startedAt = ev.timestamp;
      if (typeof ev.branch === 'string' && ev.branch.length > 0) branch = ev.branch;
      if (typeof ev.project === 'string') project = ev.project;
    } else if (ev.event === EVENT_STOPPED || ev.event === EVENT_ENDED) {
      if (!Number.isNaN(ts)) {
        lastTerminalMs = lastTerminalMs === null ? ts : Math.max(lastTerminalMs, ts);
      }
      if (typeof ev.branch === 'string' && ev.branch.length > 0 && !branch) branch = ev.branch;
    }
  }

  return { uuids, mode, semanticFromLock, startedAt, branch, project, lastTerminalMs, earliestMs };
}

/**
 * Build the abandoned-session stub record. Required fields with no events
 * source are defaulted to empty/zero and enumerated in
 * `_backfill_incomplete_fields`; the mode → session_type coercion sets
 * `_session_type_inferred`.
 */
function synthesizeRecord({ recordId, synthetic, gathered, nowMs }) {
  const startedIso = canonicalIso(gathered.startedAt, gathered.earliestMs ?? nowMs);
  const startedMs = Date.parse(startedIso);
  const terminalMs = Number.isFinite(gathered.lastTerminalMs) ? gathered.lastTerminalMs : nowMs;
  // completed_at = last terminal event (or now), never earlier than started_at.
  const completedIso = new Date(Math.max(startedMs, terminalMs)).toISOString();

  let sessionType = 'housekeeping';
  let inferred = true;
  if (gathered.mode && VALID_SESSION_TYPES.has(gathered.mode)) {
    sessionType = gathered.mode;
    inferred = false;
  }

  const startedFound = typeof gathered.startedAt === 'string';
  const branchFound = typeof gathered.branch === 'string' && gathered.branch.length > 0;

  const incomplete = ['total_waves', 'waves', 'agent_summary', 'total_agents', 'total_files_changed'];
  if (!startedFound) incomplete.push('started_at');
  if (!branchFound) incomplete.push('branch');

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
    status: 'abandoned',
    _backfill_source: 'events-jsonl',
    _backfill_incomplete_fields: incomplete,
  };
  if (branchFound) record.branch = gathered.branch;
  if (inferred) record._session_type_inferred = true;
  if (synthetic) record._synthetic_session_id = true;
  return record;
}

/**
 * Dedupe against sessions.jsonl. Returns a `skipped-already-recorded` result
 * when `recordId` (or a UUID `sessionId` written directly as a key) is already
 * present, else `null`. Reads the (small) sessions.jsonl exactly once.
 */
function checkAlreadyRecorded(readFileSync, sessionsPath, { recordId, sessionId }) {
  const sessionRecords = readJsonlSafe(readFileSync, sessionsPath);
  const existingIds = new Set(
    sessionRecords.map((r) => (r && typeof r.session_id === 'string' ? r.session_id : null)).filter(Boolean)
  );
  if (existingIds.has(recordId)) {
    return { action: 'skipped-already-recorded', sessionId: recordId };
  }
  // Defensive: a prior record keyed directly by the UUID also counts.
  if (isUuid(sessionId) && existingIds.has(sessionId)) {
    return { action: 'skipped-already-recorded', sessionId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Backfill an abandoned session record into sessions.jsonl from events.jsonl.
 *
 * Never throws. Returns one of:
 *   { action: 'backfilled', sessionId, record }        — written to disk
 *   { action: 'would-backfill', sessionId, record }    — dryRun only, not written
 *   { action: 'skipped-no-identifier' }                — neither id known
 *   { action: 'skipped-already-recorded', sessionId }  — already in sessions.jsonl
 *   { action: 'skipped-foreign-live-lock', sessionId, lockSessionId }
 *   { action: 'skipped-marker-exists', sessionId }     — lost the TOCTOU claim
 *   { action: 'error', error, sessionId? }             — any failure, swallowed
 *
 * @param {object} args
 * @param {string}  args.repoRoot                 absolute project root
 * @param {string|null} [args.sessionId]          harness UUID (SessionEnd stdin) or semantic id
 * @param {string|null} [args.semanticSessionId]  semantic id when already known (current-session.json)
 * @param {number|string} [args.now]              ms-since-epoch (test seam) or ISO string
 * @param {boolean} [args.dryRun=false]           compute + validate only, no marker/write
 * @param {object}  [args.deps]                   DI overrides (fs, appendJsonl, readLock, …)
 * @returns {Promise<object>}
 */
export async function backfillAbandonedSession({
  repoRoot,
  sessionId = null,
  semanticSessionId = null,
  now = Date.now(),
  dryRun = false,
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
        if (gathered.semanticFromLock) {
          recordId = gathered.semanticFromLock;
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

      // -- Liveness guard — never overwrite a FOREIGN live lock ---------------
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
          (Boolean(recordId) && lock.semantic_session_id === recordId);
        const foreign = !ownByUuid && !ownBySemantic;
        if (foreign && isLockLive(lock, nowMs)) {
          return { action: 'skipped-foreign-live-lock', sessionId: recordId, lockSessionId: lock.session_id };
        }
      }

      // -- Synthesize + validate (round-trip gate) BEFORE any disk mutation ---
      const record = synthesizeRecord({ recordId, synthetic, gathered, nowMs });
      let validated;
      try {
        validated = validateSession(record);
        serializeSessionLineChecked(validated);
      } catch (err) {
        return { action: 'error', error: `validation: ${err?.message ?? String(err)}`, sessionId: recordId };
      }

      if (dryRun) {
        return { action: 'would-backfill', sessionId: recordId, record: validated };
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
      return { action: 'backfilled', sessionId: recordId, record: validated };
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

/** Normalise the `now` arg (number ms | ISO string | undefined) → ms. */
function resolveNowMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string') {
    const ms = Date.parse(now);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}
