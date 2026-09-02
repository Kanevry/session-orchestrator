#!/usr/bin/env node
/**
 * on-session-end.mjs — SessionEnd hook: emit orchestrator.session.ended.
 *
 * Symmetric counterpart to on-session-start.mjs's `orchestrator.session.started`.
 * Fires when the Claude Code / Codex session terminates (clear | logout |
 * prompt_input_exit | other). Emits ONE canonical lifecycle event via emitEvent()
 * so downstream consumers (convergence-monitor, tmux telemetry-stats,
 * gitlab-portfolio) can bound a session window from events.jsonl alone — previously
 * `session.started` had no terminal partner.
 *
 * JSONL format (`.orchestrator/metrics/events.jsonl`):
 *   {"timestamp":<ISO>,"event":"orchestrator.session.ended","session_id":"...","semantic_session_id":"...","reason":"<reason>","duration_ms":<int>}
 *   (`session_id` / `semantic_session_id` are omitted when unresolvable — #1068 AC1.
 *    `duration_ms` likewise: it is written ONLY when the ending session IS the
 *    one `current-session.json` records AND a start timestamp parsed. A
 *    fabricated `0` reads as a measured zero-length session and is
 *    indistinguishable from one — 1082 of 1498 fleet records (72,2 %) carried
 *    exactly that zero, measured 2026-09-02. Omit, never fabricate.)
 *
 * Exit codes: 0 always (informational hook — must never block session teardown).
 * stdin: optional JSON { hook_event_name:"SessionEnd", session_id?, reason?, cwd? }.
 *
 * Registered SYNC (no `async` flag) in hooks.json/hooks-codex.json — mirrors on-stop.mjs.
 * A terminal event must be persisted BEFORE teardown, so we deliberately do NOT
 * fire-and-forget: emitEvent's appendFile is sub-millisecond and its webhook is itself
 * fire-and-forget, so the synchronous window does not meaningfully delay teardown.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('on-session-end')) process.exit(0);

import { emitEvent } from '../scripts/lib/events.mjs';
import { SO_PROJECT_DIR } from '../scripts/lib/platform.mjs';
import {
  backfillAbandonedSession,
  backfillCompletedFromStateMd,
} from '../scripts/lib/session-close-backfill.mjs';
import {
  readLockDetailed,
  release,
  loadOwnerProof,
  OWNER_PROOF_RELPATH,
} from '../scripts/lib/session-lock.mjs';
import { parseSessionId } from '../scripts/lib/session-id.mjs';
import { deregisterSelf, logSweepEvent } from '../scripts/lib/session-registry.mjs';
import { readConfigFile, parseSessionConfig } from '../scripts/lib/config.mjs';
import { flush } from '../scripts/lib/telemetry/sync.mjs';
import { attemptLockReconciliation } from './_lib/lock-reconcile.mjs';
import { atomicMutateJson } from './_lib/atomic-json.mjs';

// ---------------------------------------------------------------------------
// stdin reading (inline — SessionEnd hooks exit 0 always, never deny)
// ---------------------------------------------------------------------------

/**
 * Read stdin to EOF and parse as JSON. Returns null on empty / parse failure / timeout.
 * @returns {Promise<object|null>}
 */
async function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    // 500 ms cap (aligned with on-session-start.mjs) — the SessionEnd hook
    // budget is ~5 s and a 4 s stdin wait is tail-risk with no upside: the
    // harness delivers stdin immediately or not at all.
    const timer = setTimeout(() => { process.stdin.destroy(); resolve(null); }, 500);

    if (process.stdin.readableEnded) { clearTimeout(timer); resolve(null); return; }

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const raw = chunks.join('').trim();
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
    process.stdin.resume();
  });
}

/**
 * Resolve this session's id + duration + semantic id. A stdin session_id wins
 * ONLY when it parses as a UUID; otherwise fall back to
 * `.orchestrator/current-session.json` (written by on-session-start.mjs).
 * duration_ms is only computed when the ENDING session is the one recorded in
 * current-session.json — never fabricated for a mismatched / unknown session.
 * Not measurable ⇒ `durationMs: null`, and the caller then OMITS the key
 * entirely (#1193 W5 F1, the last site of the omit-never-fabricate class this
 * session removed from `session.stopped` and `agent.stopped`).
 *
 * #1091 / Kanevry#66 — WRITER/READER SYMMETRY. `on-session-start.mjs`
 * (`resolveSessionId`, :316-317) accepts a stdin raw id only when
 * `parseSessionId(fromStdin)?.format === 'uuid'` and otherwise mints a
 * `randomUUID()`; `current-session.json`, `session.lock` and the host registry
 * are therefore ALWAYS keyed by a UUID. This reader used to accept ANY
 * non-empty stdin string, so a harness that passed a non-UUID id
 * (`{"session_id":"not-a-uuid"}`) resolved a key that matches nothing written
 * at start: the raw-ID ownership compare below (:330) fails, the lock is
 * neither released nor reconciled, and it LEAKS until its TTL expires. Same
 * for `deregisterSelf()`, whose registry file is named after the id
 * `registerSelf()` used. Mirroring the writer's rule here makes the fallback
 * (which reads exactly those artifacts) the single source of the identity.
 * The ownership compare itself stays an exact string `===` — this changes
 * WHICH id is compared, never HOW.
 *
 * `semanticSessionId` is read from current-session.json (present since #587):
 * it is the SEMANTIC id (`<branch>-<date>-<mode>-<n>`) that sessions.jsonl is
 * keyed by, and the id the backfill (C1 #724) uses when the stdin session_id is
 * a harness UUID with no lock.acquired bridge. It is never a lock-release
 * ownership identity; only the raw/native `sessionId` may release a live lock.
 *
 * #863 defect (c) — `semanticSessionId` is gated by the SAME "ending session
 * IS the recorded one" check as `durationMs` above. `current-session.json` is
 * a single repo-global file: it always reflects whichever session most
 * recently ran SessionStart, which may be a DIFFERENT, still-live session
 * when multiple windows share this repo. An unrelated/mismatched ending
 * session therefore resolves `semanticSessionId: null` rather than inheriting
 * another live session's backfill identity.
 *
 * #1193 W4a review F-A — `isRecordedSession` is computed from the RAW stdin
 * UUID, NEVER from the resolved `sessionId`. The old order was
 * `if (sessionId === null) sessionId = recordedId;` followed by
 * `sessionId === recordedId`, which is SELF-FULFILLING: whenever stdin carried
 * no session_id (or a non-UUID one), the fallback assigned the file's own id
 * and the compare then trivially succeeded. Reproduced twice 2026-09-02 —
 * peer-owned `current-session.json` (`last_wave: 3`) plus stdin
 * `{"reason":"other"}` emitted `wave.completed` for the PEER's wave and wrote
 * `last_wave_completed: 3` into the PEER's file, after which the peer's own
 * SessionEnd stayed silent. The same vacuous predicate had always gated
 * `durationMs` and `semanticSessionId`, so the #863 guard was hollow on that
 * path too. One root fix (BV-003) for all three consumers: a `null` raw id
 * means "not attestable" ⇒ `false`.
 *
 * WHY `sessionId` STILL FALLS BACK while the predicate does not. The two are
 * deliberately asymmetric. `sessionId` is the hook's ACTOR identity — the id
 * `deregisterSelf()` and the lock-release ownership compare use, and its
 * current-session.json fallback is a named contract pinned by
 * `tests/hooks/on-session-end.test.mjs` ("falls back to current-session.json
 * session_id when stdin omits it"). `isRecordedSession` is an OWNERSHIP
 * ASSERTION about a repo-global file; an assertion may never be derived from
 * the very value it is asserting about. So the fallback stays for the emitted
 * `session_id` field, and every claim that speaks FOR the recorded session
 * (`duration_ms`, `semantic_session_id`, the final `wave.completed`) is gated
 * on the strict raw compare instead. Precedent: `hooks/on-stop.mjs`
 * `resolveStopDuration()`, which refuses the resolved id for the same reason.
 *
 * @param {object|null} input
 * @param {string} projectRoot
 * @returns {Promise<{sessionId: string|null, semanticSessionId: string|null, durationMs: number|null, isRecordedSession: boolean, rawStdinId: string|null}>}
 */
async function resolveSession(input, projectRoot) {
  const fromStdin = input?.session_id ?? input?.sessionId ?? null;
  // UUID-only, exactly as the writer decides it (see the docblock above).
  const rawStdinId = parseSessionId(fromStdin)?.format === 'uuid' ? fromStdin : null;
  let sessionId = rawStdinId;

  let recordedId = null;
  let semanticSessionId = null;
  let startedAtMs = null;
  try {
    const raw = await fs.readFile(
      path.join(projectRoot, '.orchestrator', 'current-session.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw);
    if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      recordedId = parsed.session_id;
    }
    if (typeof parsed.semantic_session_id === 'string' && parsed.semantic_session_id.length > 0) {
      semanticSessionId = parsed.semantic_session_id;
    }
    if (typeof parsed.timestamp === 'string') {
      const t = Date.parse(parsed.timestamp);
      if (!Number.isNaN(t)) startedAtMs = t;
    }
  } catch { /* missing or unparseable is fine */ }

  // Actor-identity fallback ONLY — see the docblock's asymmetry note. This
  // value must NEVER feed the ownership predicate below.
  if (sessionId === null) sessionId = recordedId;

  // Only trust the recorded start time when the ending session IS the recorded
  // one — decided on the RAW stdin id, so an absent/non-UUID id is `false`
  // rather than self-fulfilling (F-A).
  const isRecordedSession = rawStdinId !== null && rawStdinId === recordedId;
  const durationMs = startedAtMs !== null && isRecordedSession
    ? Math.max(0, Date.now() - startedAtMs)
    : null;

  // #863 defect (c) — same guard as durationMs above: only surface the
  // recorded semantic id when THIS ending session is genuinely the one
  // current-session.json describes. See the docblock above for the exact
  // contamination scenario this closes.
  const resolvedSemanticSessionId = isRecordedSession ? semanticSessionId : null;

  // `rawStdinId` is returned so a LATER read of current-session.json can
  // re-verify ownership against the same identity (W4c Q1-LOW-TOCTOU) instead
  // of trusting an attestation made against an earlier read of the file.
  return {
    sessionId,
    semanticSessionId: resolvedSemanticSessionId,
    durationMs,
    isRecordedSession,
    rawStdinId,
  };
}

/**
 * POST budget for the close-time telemetry flush (ms).
 *
 * NAMED CEILING, and the reason it is BELOW the module default POST_TIMEOUT_MS
 * (3000): the two timeouts fail differently.
 *
 *   - This one expiring is LOSSLESS. `flush()` catches the abort and routes the
 *     record into the bounded offline queue; the daily fallback
 *     (`shouldDailyFlush`) drains it on a later session.
 *   - The HARNESS timeout expiring is LOSSY. Claude Code kills the hook process
 *     mid-flight, so the enqueue never runs and the record is simply gone —
 *     which is the exact failure #1138 exists to remove.
 *
 * So the internal bound must stay comfortably under the harness bound, not
 * merely below it. Budget (hooks/hooks.json `SessionEnd.timeout: 10` s, raised
 * from 5 with this change): up to 500 ms stdin + a backfill measured at a
 * ~845 ms median (its TAIL, not its median, is what would collide) + lock
 * release + deregistration, then this 2 s. That leaves several seconds of slack
 * for the backfill tail while still covering a normal round-trip many times
 * over.
 *
 * Revisit if the hooks.json SessionEnd timeout changes — the pin lives in
 * tests/hooks/on-session-end.test.mjs.
 */
const TELEMETRY_FLUSH_TIMEOUT_MS = 2000;

/**
 * Read `persistence` from the repo's Session Config. Defaults to `true` — the
 * same default `scripts/lib/config.mjs` applies — so an unreadable or absent
 * CLAUDE.md (or its Codex alias AGENTS.md) never silently disables the flush.
 *
 * @param {string} projectRoot
 * @returns {Promise<boolean>}
 */
async function readPersistence(projectRoot) {
  try {
    const md = await readConfigFile(projectRoot);
    return parseSessionConfig(md).persistence !== false;
  } catch {
    return true;
  }
}

/**
 * Reduce a `flush()` result to the two-field breadcrumb the event carries.
 *
 * `reason` is normalised to its head token because `flush()` may return
 * `build-error: <message>`, and a raw error message is unbounded free text in a
 * stream whose whole purpose is aggregation by class.
 *
 * @param {{sent?: boolean, queued?: boolean, reason?: string}|null|undefined} res
 * @returns {{outcome: 'sent'|'queued'|'gated'|'skipped', reason: string}}
 */
function classifyFlush(res) {
  const reason = String(res?.reason ?? 'unknown').split(':')[0];
  if (res?.sent === true) return { outcome: 'sent', reason };
  if (res?.queued === true) return { outcome: 'queued', reason };
  if (reason === 'gated') return { outcome: 'gated', reason };
  return { outcome: 'skipped', reason };
}

/**
 * #1138 — the MECHANICAL telemetry flush.
 *
 * Until now the close-time flush existed only as prose in
 * `skills/session-end/SKILL.md` § Phase 3.45, i.e. it ran only when the
 * coordinator LLM happened to execute that phase. Measured 2026-08-23: 588
 * session closes across 13 repos produced 82 ingest records (~14%). A hook is
 * the only caller that fires on EVERY close, including the ones that never
 * reach `/close` at all.
 *
 * Strictly best-effort: never throws, and bounded by TELEMETRY_FLUSH_TIMEOUT_MS.
 * The consent gate lives INSIDE `flush()` (`resolveConsent()` is its first
 * statement) — this function deliberately does not re-implement it, so there is
 * exactly one place where "may we send?" is decided.
 *
 * Always emits `orchestrator.telemetry.flush` with `{ outcome, reason }` and
 * NOTHING else — no payload, no anon_id. Per `.claude/rules/host-resources.md`
 * HR-105, a mechanism whose firing rate nothing records cannot be falsified;
 * this event is what makes the flush rate measurable next time.
 *
 * @param {string} projectRoot
 * @returns {Promise<void>}
 */
async function flushTelemetry(projectRoot) {
  let result;
  try {
    result = (await readPersistence(projectRoot))
      ? classifyFlush(await flush({
        metricsDir: path.join(projectRoot, '.orchestrator', 'metrics'),
        timeoutMs: TELEMETRY_FLUSH_TIMEOUT_MS,
      }))
      // `persistence: false` means this session leaves no durable local trace;
      // a telemetry ping is a durable record too, so it honours the same switch.
      : { outcome: 'skipped', reason: 'persistence-disabled' };
  } catch {
    result = { outcome: 'skipped', reason: 'error' };
  }

  // `result` is passed through verbatim: it holds EXACTLY {outcome, reason}, so
  // no payload field can leak into the event by accident.
  try {
    await emitEvent('orchestrator.telemetry.flush', result);
  } catch { /* observability is best-effort */ }
}

/**
 * #1068 AC2 — emit ONE canonically queryable outcome per backfill attempt.
 *
 * Until now a backfill result reached exactly one place:
 * `.orchestrator/metrics/session-close-backfill.log`, a side-log no lifecycle
 * consumer reads and no staleness/integrity check joins against. The event
 * stream is where every other lifecycle fact already lives, so the outcome goes
 * there too — carrying IDENTITY (`session_id` raw UUID + the record id the
 * backfill acted on + the attested semantic id), ACTION, and, when the action
 * was an error, its REASON. The side-log is unchanged and remains the verbose
 * copy; this is the queryable one.
 *
 * `kind` distinguishes the two backfill classes, which share the log file and
 * would otherwise be indistinguishable in aggregate: `'abandoned'`
 * (`backfillAbandonedSession`) vs `'state-md-completed'`
 * (`backfillCompletedFromStateMd`).
 *
 * Every id key is OMITTED when unknown — never `""`, never a guess (#1068 AC1).
 * Best-effort throughout: observability must never block teardown.
 *
 * @param {'abandoned'|'state-md-completed'} kind
 * @param {{action?: string, sessionId?: string|null, supersedes?: string, error?: string}|null|undefined} result
 * @param {{sessionId: string|null, semanticSessionId: string|null}} ids
 * @returns {Promise<void>}
 */
async function emitBackfillOutcome(kind, result, { sessionId, semanticSessionId }) {
  try {
    const recordId = typeof result?.sessionId === 'string' ? result.sessionId : null;
    await emitEvent('orchestrator.session.backfill_completed', {
      kind,
      action: typeof result?.action === 'string' ? result.action : 'unknown',
      ...(sessionId !== null ? { session_id: sessionId } : {}),
      ...(semanticSessionId !== null ? { semantic_session_id: semanticSessionId } : {}),
      ...(recordId !== null ? { record_id: recordId } : {}),
      ...(typeof result?.supersedes === 'string' ? { supersedes: result.supersedes } : {}),
      ...(typeof result?.error === 'string' ? { reason: result.error } : {}),
    });
  } catch { /* observability is best-effort */ }
}

/**
 * Emit the FINAL `orchestrator.wave.completed` of the session (#1193).
 *
 * `hooks/post-tool-batch-wave-signal.mjs` closes wave N-1 only at an N-1→N
 * transition, so the LAST wave of every session never received a completion —
 * measured fleet-wide 2026-09-02 as 296 gaps over 296 wave runs (1018 started
 * vs 722 completed), i.e. EXACTLY one missing final completion per run. The
 * comment that claimed the coordinator emitted it at session close described a
 * step that never existed. SessionEnd is that emitter.
 *
 * Deliberately SessionEnd-only: `on-stop.mjs` is not mirrored, so the ledger
 * keeps the closed-vs-abandoned split measurable.
 *
 * Idempotent via the `last_wave_completed` high-water mark, written by both
 * emitters and preserved across clear/compact by `on-session-start.mjs`.
 * Emits nothing when `last_wave` is absent or 0 — an Express-Path or
 * coordinator-direct session never batched, and zero waves is the correct
 * reading there, not a gap.
 *
 * OWNERSHIP-GATED (#1193 review F1). `.orchestrator/current-session.json` is a
 * single repo-global file describing whichever session most recently ran
 * SessionStart — routinely a DIFFERENT, still-live session when two windows
 * share this working copy. Emitting unguarded would (a) close a PEER's live
 * wave with a completion the peer never reached, and (b) write
 * `last_wave_completed` into the peer's file, so the peer's own SessionEnd then
 * stays silent — preserving the very #1193 gap this closes, on the wrong
 * session. So this reuses the SAME `isRecordedSession` predicate
 * `resolveSession()` applies to `durationMs` and `semanticSessionId` (#863
 * defect (c)); when it is false, nothing is emitted and nothing is written.
 *
 * REASON-GATED for `/clear` AND `resume` (#1193 review F2 + W4c Q3-MED-2). The
 * SessionEnd matcher is empty, so `/clear` fires this hook mid-wave while the
 * LOGICAL session continues (`hooks/on-session-start.mjs:383` preserves
 * `last_wave` / `last_wave_completed` across exactly that). A `resume` is the
 * SAME class — start preserves the marker across a resume of the same logical
 * session just as it does across a clear — and resume is the MORE common of the
 * two (fleet n = 1498 `session.ended`, 2026-09-02: 12 resume vs 9 clear).
 * Closing the live wave on either is premature, and the preserved marker would
 * then suppress the real completion later. Fleet `session.ended` reasons, re-measured
 * 2026-09-02 over every repo's `.orchestrator/metrics/events.jsonl` under
 * `~/Projects` (glob written as a path segment on purpose — a literal star
 * followed by a slash would close this comment), except
 * `EventDrop.at-deps-2026-09` — n = 1335: 1286 other, 27 completed, 12 resume,
 * 8 clear, 1 error, 1 close. (Same denominator and date as the
 * `session.ended` row in `docs/audits/2026-09-02-fleet-instruments.md`; the two
 * disagreed by ~150 before W4a F-F because each counted a different repo set.)
 *
 * Strictly best-effort: never throws, never blocks teardown.
 *
 * @param {string} projectRoot
 * @param {{sessionId: string|null, semanticSessionId: string|null,
 *          isRecordedSession: boolean, reason: string,
 *          rawStdinId: string|null}} ctx
 * @returns {Promise<void>}
 */
async function emitFinalWaveCompleted(
  projectRoot,
  { sessionId, semanticSessionId, isRecordedSession, reason, rawStdinId },
) {
  try {
    // F1 — never speak for a session current-session.json does not describe.
    if (!isRecordedSession) return;
    // F2 — `/clear` ends the HARNESS session, not the logical one. `resume` is
    // the SAME class (W4c Q3-MED-2): `on-session-start.mjs` preserves
    // `last_wave` / `last_wave_completed` across a resume of the same logical
    // session exactly as it does across a clear, and resume is the MORE common
    // of the two (fleet n=1498, 2026-09-02: 12 resume vs 9 clear).
    if (reason === 'clear' || reason === 'resume') return;
    const sessionFile = path.join(projectRoot, '.orchestrator', 'current-session.json');
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    } catch {
      return; // absent or malformed → nothing attestable to close
    }

    // W4c Q1-LOW-TOCTOU — `isRecordedSession` was attested against the FIRST
    // read of this file (in `resolveSession()`); the values acted on below come
    // from this SECOND read. Re-verify ownership here rather than inheriting a
    // stale attestation. A genuine swap BETWEEN the two reads is not testable
    // without a seam, and none is added for it — the peer-id case pins the
    // re-check, and this predicate is what makes the window harmless.
    if (rawStdinId === null || parsed?.session_id !== rawStdinId) return;

    const lastWave = parsed?.last_wave;
    if (typeof lastWave !== 'number' || !(lastWave > 0)) return;
    // W4c Q3-MED-3(iii) / Q3-LOW-4 — strictly ABOVE the high-water mark, not
    // merely different from it: a marker AHEAD of `last_wave` (written by the
    // batch hook's explicit `wave-complete{N}` branch) means this wave is
    // already closed, and a non-integer marker (`'3'`, `null`) counts as
    // ABSENT rather than as "different".
    const marker = Number.isInteger(parsed?.last_wave_completed) ? parsed.last_wave_completed : 0;
    if (!(lastWave > marker)) return;

    await emitEvent('orchestrator.wave.completed', {
      ...(sessionId !== null ? { session_id: sessionId } : {}),
      ...(semanticSessionId !== null ? { semantic_session_id: semanticSessionId } : {}),
      wave_number: lastWave,
      reason: 'session-end',
      emitted_by: 'on-session-end',
    });

    // Monotone, exactly as the batch hook's `maxWave()` — the mark may only
    // ever rise, whichever of the three writers gets here last (W4c Q3-MED-3).
    const markResult = await atomicMutateJson(sessionFile, {}, (current) => ({
      ...current,
      last_wave_completed: Number.isInteger(current?.last_wave_completed)
        && current.last_wave_completed > lastWave
        ? current.last_wave_completed
        : lastWave,
    }), 'ose');
    // The wave.completed EVENT above already fired regardless — this only
    // withholds the shared-file high-water mark on a non-ENOENT failure.
    if (!markResult.ok) {
      console.error(`on-session-end: last_wave_completed mark skipped (${markResult.reason})`);
    }
  } catch { /* best-effort — a SessionEnd hook must never block teardown */ }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  const projectRoot = SO_PROJECT_DIR;

  const reason =
    typeof input?.reason === 'string' && input.reason.length > 0 ? input.reason : 'other';
  const { sessionId, semanticSessionId, durationMs, isRecordedSession, rawStdinId } =
    await resolveSession(input, projectRoot);

  // Single emission path: emitEvent writes the canonical {timestamp, event, ...payload}
  // JSONL record AND fires the optional Clank webhook with the SAME event name.
  //
  // #1068 AC1 — the terminal event carries the raw UUID *and* the semantic id
  // whenever the latter is ATTESTED, so a lifecycle outcome is joinable by
  // identity from events.jsonl alone (previously only `session.lock.acquired`
  // carried both, and only ~1/3 of sessions emit one). The key is OMITTED, never
  // written as `""` or `null`, when `resolveSession()` could not attest it —
  // "identity unresolved" must stay visibly unresolved rather than become a
  // guessed id (#1068 AC1's explicit "niemals eine geratene ID"). Note the
  // attestation bar is the #863 defect (c) guard inside `resolveSession()`: an
  // ending session that is NOT the one current-session.json describes resolves
  // `semanticSessionId: null` and therefore emits no key here.
  // #1193 — close the last wave BEFORE the terminal session event, so the
  // ledger's wave lifecycle is balanced within the session's own window. Gated
  // on the SAME `isRecordedSession` attestation as the identity keys above, and
  // skipped for `reason === 'clear'` and `reason === 'resume'` alike — both end
  // the HARNESS session while the LOGICAL one continues; see the emitter's docblock.
  await emitFinalWaveCompleted(projectRoot, {
    sessionId,
    semanticSessionId,
    isRecordedSession,
    reason,
    rawStdinId,
  });

  await emitEvent('orchestrator.session.ended', {
    ...(sessionId !== null ? { session_id: sessionId } : {}),
    ...(semanticSessionId !== null ? { semantic_session_id: semanticSessionId } : {}),
    reason,
    // Omit-never-fabricate: only a MEASURED span is written. `null` here means
    // the ending session is not the recorded one (or no start time parsed) —
    // absence must stay absence, not become a zero-length session.
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { duration_ms: durationMs } : {}),
  });

  // -------------------------------------------------------------------------
  // C1 (#724) — Close-through backfill + deterministic lock release.
  // Both are STRICTLY best-effort: a SessionEnd hook must never block teardown
  // nor exceed its timeout. All work is local fs (no network); backfill itself
  // never throws (returns a structured result). We still wrap in try/catch as a
  // belt-and-suspenders guard against an unexpected import-time failure.
  // -------------------------------------------------------------------------

  // (a) Backfill a status:'abandoned' stub when this session never reached /close.
  //     Dedupe + foreign-live-lock + TOCTOU-marker guards live in the lib.
  //     Dead-by-age relaxation (relaxDeadByAge/assumeDeadBeforeMs, #731 — used by the
  //     historical migration CLI) is NEVER passed here: a foreign lock that is live
  //     at hook-time is, by definition, a real active session, not stale history.
  try {
    const res = await backfillAbandonedSession({ repoRoot: projectRoot, sessionId, semanticSessionId });
    await emitBackfillOutcome('abandoned', res, { sessionId, semanticSessionId });
  } catch { /* best-effort — never block teardown */ }

  // (a2) #429 — STATE.md `status: completed` self-heal. Orthogonal to (a)
  //      above and to THIS session's own id: it reads STATE.md directly and
  //      repairs a PAST session whose `status: completed` was set (by hand or
  //      otherwise) without session-end's Phase 3.7 ever writing the matching
  //      sessions.jsonl record — the exact state `commands/close.md`'s
  //      Pre-Check then reads as "already finalized" forever after. Cheap
  //      no-op on the overwhelmingly common path (STATE.md status is
  //      'active'/'paused'/'idle', or the record already exists).
  try {
    const res = await backfillCompletedFromStateMd({ repoRoot: projectRoot });
    await emitBackfillOutcome('state-md-completed', res, { sessionId, semanticSessionId });
  } catch { /* best-effort — never block teardown */ }

  // (b) Deterministic lock release — ONLY a lock whose raw/native session_id
  //     exactly matches this ending session's raw/native sessionId. Semantic
  //     IDs remain lifecycle/backfill metadata and persisted proofs remain an
  //     additional delete defense, but neither can heal a raw-ID mismatch.
  //
  //     A mismatch routes only through reconciliation. The reaper independently
  //     never touches a live lease, a cross-host lease, or a lease whose
  //     recorded PID is still alive on this host; this retains dead/stale-lock
  //     recovery without granting a SessionEnd hook foreign-lock ownership.
  try {
    // readLockDetailed (additive, see its JSDoc in session-lock.mjs) replaces
    // readLock() here so an unreadable/corrupt lock file is DISTINGUISHABLE
    // from a genuinely absent one, instead of both collapsing to the same
    // `null`. Only 'absent' is treated as "nothing to release/reconcile" —
    // 'unreadable'/'corrupt' is an anomaly worth a breadcrumb, since a lock we
    // cannot even parse is neither released nor reconciled below, and used to
    // silently look identical to "no lock, all clear".
    const lockDetail = readLockDetailed({ repoRoot: projectRoot });

    if (lockDetail.status === 'unreadable' || lockDetail.status === 'corrupt') {
      try {
        await emitEvent('orchestrator.session.lock.read_anomaly', {
          session_id: sessionId,
          status: lockDetail.status,
          ...(lockDetail.status === 'unreadable' ? { error: lockDetail.error } : {}),
        });
      } catch { /* observability is best-effort */ }
    } else if (lockDetail.status === 'ok') {
      const lock = lockDetail.lock;
      const ownByRawId = sessionId !== null && lock.session_id === sessionId;

      if (ownByRawId) {
        // The proof is deliberately passed to release() only after this raw-ID
        // check. release() validates a supplied proof against its fresh on-disk
        // read, preserving it as a second defense for the raw-owned path without
        // allowing proof equality to establish ownership by itself.
        const proof = loadOwnerProof({ repoRoot: projectRoot });

        // Defense-in-depth (#987): when a persisted proof exists, hand it to
        // release() so the delete is double-gated (session_id match AND
        // proof match) at the fs layer too. `proof` is `null` whenever
        // loadOwnerProof() could not prove ownership (pre-#987 sessions,
        // failed proof write) — release() gates on `proof != null` (#989) and
        // degrades to the session_id-only path for that case, so passing it
        // through unguarded is correct.
        // A 'proof-mismatch' result flows into the existing release_failed
        // breadcrumb below (releaseResult.reason surfaces verbatim).
        const releaseResult = release({
          sessionId,
          repoRoot: projectRoot,
          proof,
        });
        // release() has a no-throw contract (always returns a structured
        // result). A matched ownership that still fails to delete — an
        // fs-error, or an unexpected non-delete outcome other than the benign
        // "already gone" race (reason: 'no-lock') — must surface as a
        // breadcrumb instead of vanishing into the catch below.
        const benignAlreadyGone = releaseResult.ok === true && releaseResult.reason === 'no-lock';
        if (!benignAlreadyGone && (!releaseResult.ok || releaseResult.deleted !== true)) {
          try {
            await emitEvent('orchestrator.session.lock.release_failed', {
              session_id: sessionId,
              reason: releaseResult.ok
                ? (releaseResult.reason ?? 'not-deleted')
                : (releaseResult.reason ?? 'fs-error'),
              caller: 'on-session-end',
            });
          } catch { /* observability is best-effort */ }
        } else {
          // #952 (A) — SUCCESS breadcrumb. Until now ONLY the failure path
          // emitted: a release that actually worked left zero trace, so
          // "the hook-lock vanished somewhere in the start chain" (#914
          // residual 3) was forensically undecidable — an absent lock could
          // equally mean "we released it cleanly at SessionEnd" or "something
          // else deleted it". Both REACHED outcomes now emit, distinguished by
          // `outcome`:
          //   'deleted'      — we unlinked it ourselves (the normal close).
          //   'already-gone' — ownership matched, but the lock had ALREADY
          //                    vanished between readLock() and release()
          //                    (release() reason 'no-lock'). This is the
          //                    forensically INTERESTING one: a third party
          //                    removed our lock while we still held it, which
          //                    IS the #914 disappearance class. Staying silent
          //                    on it would leave exactly that signal unobservable.
          //
          // `end_reason` (not `reason`) deliberately: the sibling
          // `…lock.release_failed` event above uses `reason` for the FAILURE
          // reason, so reusing the key for the SessionEnd reason
          // (clear|logout|prompt_input_exit|other) inside the same
          // `orchestrator.session.lock.*` namespace would make any consumer
          // roll-up over `.reason` mix "clear" with "fs-error".
          //
          // Emitted at the CALL-SITE, never inside release(): session-lock.mjs
          // deliberately carries no dependency on events.mjs, and release() is
          // synchronous while emitEvent() is async. `caller` keeps the two
          // release call-sites (this hook and the autopilot worktree pipeline)
          // distinguishable in the single stream.
          try {
            await emitEvent('orchestrator.session.lock.released', {
              session_id: sessionId,
              lock_session_id: lock.session_id,
              ...(semanticSessionId !== null ? { semantic_session_id: semanticSessionId } : {}),
              end_reason: reason,
              caller: 'on-session-end',
              outcome: benignAlreadyGone ? 'already-gone' : 'deleted',
              verified: releaseResult.verified === true,
            });
          } catch { /* observability is best-effort */ }

          // #987 hygiene — the successful own release consumed the genesis
          // proof; remove it best-effort. A leftover would be harmless (its
          // millisecond started_at cannot match any FUTURE lock, so it
          // self-invalidates), this just avoids the stale artifact. ENOENT
          // (no proof was ever written) lands in the same swallow.
          try {
            await fs.unlink(path.join(projectRoot, OWNER_PROOF_RELPATH));
          } catch { /* best-effort — a leftover proof is self-invalidating */ }
        }
      } else {
        // A raw-ID mismatch never grants release ownership. Reconciliation is
        // the only remaining cleanup path; it no-ops for a live lock and safely
        // reaps only eligible dead/stale locks.
        await attemptLockReconciliation({ repoRoot: projectRoot, sessionId, lock });
      }
    }
    // 'absent' — no lock file at all; nothing to release or reconcile
    // (mirrors the pre-existing `if (lock)` guard's false branch).
  } catch { /* best-effort — never block teardown */ }

  // (c) #1047 — host-registry deregistration, the symmetric partner of
  //     on-session-start.mjs's registerSelf(). This used to live in
  //     hooks/on-stop.mjs, which fires at TURN end, so every assistant turn
  //     deleted the entry of a still-live session; on-stop.mjs now refreshes
  //     the entry (heartbeat) and teardown happens here, at the real end.
  //
  //     Keyed by `sessionId` ONLY, never by `semanticSessionId`: the registry
  //     file is named after the id registerSelf() was called with, and in the
  //     `generated-uuid-fallback-collision` path (on-session-start.mjs) the
  //     semantic candidate names ANOTHER session's entry — deregistering by it
  //     would delete a foreign live session. Ownership is therefore structural
  //     here, not a check.
  //
  //     CONSEQUENCE, accepted deliberately — and the affected platform is
  //     CODEX ALONE. Measured 2026-08-17 across the three bridge manifests:
  //       hooks.json         SessionStart + SessionEnd        -> registers, deregisters
  //       hooks-pi.json      session_start + session_shutdown -> registers, deregisters
  //                          (session_shutdown maps to THIS file)
  //       hooks-codex.json   SessionStart + Stop, no SessionEnd
  //                          -> registers, never deregisters      <- the gap
  //       hooks-cursor.json  afterFileEdit + beforeShellExecution only
  //                          -> never registers, so nothing to leak
  //     On Codex an entry therefore persists until sweepZombies() removes it at
  //     the next SessionStart — up to the sweep threshold (`thresholdMin`,
  //     default 60 min) after the session ended. That is the same path crash
  //     and Ctrl-C already rely on for EVERY platform; no platform-detecting
  //     second teardown branch exists by design.
  //
  //     Note where this is written: THIS file does not run on Codex, so the
  //     consequence is also pointed at from hooks/on-stop.mjs, which does.
  //
  //     The `sessionId` guard is not decoration: deregisterSelf() throws
  //     TypeError on a null/empty id, and "no id resolvable" is a normal
  //     degraded state (no stdin id, no current-session.json), not a failure
  //     worth a sweep.log breadcrumb.
  if (sessionId) {
    try {
      await deregisterSelf(sessionId);
    } catch (err) {
      // Deregistration failed — observability breadcrumb to sweep.log, never a
      // throw and never stderr: the hook must not block teardown.
      logSweepEvent({ event: 'deregister-failed', session_id: sessionId, error: err?.message ?? String(err) });
    }
  }

  // (d) #1138 — mechanical telemetry flush. Deliberately LAST: it is the only
  //     step here that may touch the network, so every local-fs guarantee above
  //     (backfill, lock release, deregistration) is already durable before the
  //     hook spends any of its remaining budget on a POST.
  await flushTelemetry(projectRoot);
}

// Exit 0 always — informational hook must never block session teardown.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
