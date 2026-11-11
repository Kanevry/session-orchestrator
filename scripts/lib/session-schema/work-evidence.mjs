/**
 * session-schema/work-evidence.mjs — what a backfilled stub measurably did (#1835).
 *
 * Pure functions. Stdlib only. No imports from siblings or parent barrel
 * (the Option 1 submodule-isolation convention of the other session-schema/*
 * modules).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `session-close-backfill.mjs` writes an `abandoned` stub with `total_waves: 0`,
 * `total_agents: 0` and `total_files_changed: 0`, and lists exactly those keys in
 * `_backfill_incomplete_fields`: the zeros are placeholders, not measurements.
 * A reader counting `status: 'abandoned'` therefore cannot tell an empty restart
 * (nothing typed after `/clear`) from a session that ran 86 agents and then died.
 * Measured 2026-10-27 on one consumer repo's ledger: of six stubs since
 * 2026-10-25, two had no turn stop at all (9 s and 14 s), two had one and four
 * turns, and two carried 15 and 86 `agent.stopped` events.
 *
 * `work_evidence` is the measurement the stub was missing. It holds EVENT
 * COUNTS, not a wave or agent count: `orchestrator.wave.completed` has two
 * emitters (`hooks/on-session-end.mjs`, `hooks/post-tool-batch-wave-signal.mjs`),
 * so its count is evidence that waves ran, never how many.
 *
 * ── THE MEASUREMENT CLAIM ──────────────────────────────────────────────────
 *
 * `workEvidenceFor()` is the only gate. It returns an object only when
 *   - the caller read the session's whole event history (`complete`),
 *   - the first `session.started` it read is a FRESH start (`native_source`
 *     `startup` or `clear`): a `compact` or `resume` start re-uses the raw id,
 *     so an earlier part of the same session may sit in an archive the caller
 *     did not read, and a start without `native_source` cannot say which it was,
 *   - and the session's platform writes turn stops.
 * Otherwise it returns `null` and the writer omits the field. Absent means "not
 * measured" — never 0. A reader may therefore treat a well-formed
 * `work_evidence` as measured without knowing these rules (`classifyStubWork`
 * in `filters.mjs`).
 *
 * `empty` must never hide work, so the counters fail toward activity: every
 * event of the session that is neither a work event nor start/end bookkeeping
 * (`LIFECYCLE_EVENTS`) counts in `activity_events` — an unknown or future event
 * name included — and so does every Skill call the session made
 * (`skill-invocations.jsonl`, added by the caller via {@link addSkillCalls}).
 *
 * What `empty` therefore measures: no completed turn, no subagent stop, no wave
 * completion, no recorded tool event and no Skill call. Ceiling (BV-004): a
 * turn cut off before its Stop hook whose tool calls were all Bash/Edit/Read
 * without any guard or telemetry event leaves no trace in either ledger and
 * still reads `empty` — only the transcript would show it. Measured
 * 2026-10-27 on this repo: of 16 sessions without a work event, 15 held only
 * lifecycle events and ended within seconds; the 16th had an AskUserQuestion
 * event. Revisit when a transcript check finds tool calls in an `empty` stub.
 *
 * Exports: WORK_EVENTS, LEGACY_TURN_STOP_EVENT, LIFECYCLE_EVENTS,
 *          FRESH_START_SOURCES, TURN_STOP_PLATFORMS, emptyWorkCounts,
 *          countWorkEvent, addSkillCalls, tallyWorkEvents, workEvidenceFor,
 *          SO_RUN_EVENT, BACKFILL_COMPLETED_EVENT, NO_RUN_ACTION, NO_RUN_SINCE,
 *          SO_RUN_SKILLS, SKILL_HOOK_PLATFORMS, isNoRunEvidence
 */

/** Counter key → the event it counts. */
export const WORK_EVENTS = Object.freeze({
  turn_stops: 'orchestrator.turn.stopped',
  agent_stops: 'orchestrator.agent.stopped',
  wave_completions: 'orchestrator.wave.completed',
});

/**
 * The Stop hook's name for the same per-turn event before 2026-09-06 (#1234).
 * Since then `hooks/on-stop.mjs` writes both names with identical payloads, so
 * a session's turn stops are the LARGER of the two counts, never their sum.
 * Measured 2026-10-27: a 158-minute session with 7 legacy stops, 14
 * `discovery_validator_violation` and a destructive-guard block read as empty
 * while only the new name was counted.
 */
export const LEGACY_TURN_STOP_EVENT = 'orchestrator.session.stopped';

/**
 * Start/end bookkeeping that hooks write without any assistant action — the
 * events an empty restart consists of. Measured 2026-10-27 over every session
 * without a turn, agent or wave event (a consumer repo 49 of 306 starts,
 * session-orchestrator 8 of 67); each name's emitter is a SessionStart or
 * SessionEnd path (`on-session-start.mjs` / `_lib/lock-bootstrap.mjs` /
 * `_lib/lock-reconcile.mjs` / `session-start-probes.mjs` / `on-session-end.mjs`).
 * Not listed on purpose: the loop-guard warning and the AskUserQuestion
 * clarity event occurred in the same population but come
 * from tool calls, i.e. the assistant was working.
 */
export const LIFECYCLE_EVENTS = Object.freeze(new Set([
  'orchestrator.session.started',
  'orchestrator.session.ended',
  'orchestrator.session.lock.acquired',
  'orchestrator.session.lock.released',
  'orchestrator.session.lock.reconcile_attempted',
  'orchestrator.session.backfill_completed',
  'orchestrator.probes.completed',
  'orchestrator.wave.final_refused',
]));

/** `native_source` values of a `session.started` that open a new raw id. */
export const FRESH_START_SOURCES = Object.freeze(['startup', 'clear']);

/**
 * Platforms whose Stop hook writes turn stops (the `platform` field of
 * `orchestrator.session.started`). Measured 2026-10-27 in this repo's
 * events.jsonl: claude 53 of 62 sessions with at least one turn stop, codex 4 of
 * 4. Ceiling (BV-004): cursor (1 session, 0 turn stops) and pi have no evidence
 * yet, so a stub of theirs stays unmeasured instead of reading as an empty
 * restart. Revisit when a cursor or pi session with work shows turn stops in
 * events.jsonl.
 */
export const TURN_STOP_PLATFORMS = Object.freeze(['claude', 'codex']);

const KEY_BY_EVENT = new Map([
  ...Object.entries(WORK_EVENTS).map(([key, event]) => [event, key]),
  [LEGACY_TURN_STOP_EVENT, 'legacy_turn_stops'],
]);

/**
 * A fresh counter set for {@link countWorkEvent}. `legacy_turn_stops` is an
 * intermediate count; {@link workEvidenceFor} folds it into `turn_stops`.
 *
 * @returns {{turn_stops: number, legacy_turn_stops: number, agent_stops: number, wave_completions: number, activity_events: number}}
 */
export function emptyWorkCounts() {
  return { turn_stops: 0, legacy_turn_stops: 0, agent_stops: 0, wave_completions: 0, activity_events: 0 };
}

/**
 * Count one event of the session into `counts` (from {@link emptyWorkCounts}).
 * A lifecycle event counts nowhere; every other event — a non-string name
 * included — counts as activity unless it is a work event.
 *
 * @param {ReturnType<typeof emptyWorkCounts>} counts — mutated
 * @param {unknown} eventName — the `event` field of an events.jsonl record
 */
export function countWorkEvent(counts, eventName) {
  if (typeof eventName === 'string' && LIFECYCLE_EVENTS.has(eventName)) return;
  const key = typeof eventName === 'string' ? KEY_BY_EVENT.get(eventName) : undefined;
  counts[key ?? 'activity_events'] += 1;
}

/**
 * Add the session's Skill calls (rows of `skill-invocations.jsonl` with its raw
 * id) to `counts` as activity. A non-integer or negative `n` adds nothing.
 *
 * @param {ReturnType<typeof emptyWorkCounts>} counts — mutated
 * @param {unknown} n
 */
export function addSkillCalls(counts, n) {
  if (Number.isSafeInteger(n) && n > 0) counts.activity_events += n;
}

/**
 * Count the events of one session.
 *
 * @param {unknown} events — parsed events.jsonl records
 * @param {Set<string>} uuids — the session's raw ids (`session_id` field)
 * @returns {ReturnType<typeof emptyWorkCounts>}
 */
export function tallyWorkEvents(events, uuids) {
  const counts = emptyWorkCounts();
  if (!Array.isArray(events) || !(uuids instanceof Set) || uuids.size === 0) return counts;
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object' || !uuids.has(ev.session_id)) continue;
    countWorkEvent(counts, ev.event);
  }
  return counts;
}

const COUNT_KEYS = Object.freeze(Object.keys(emptyWorkCounts()));

/**
 * The `work_evidence` value for a stub, or null when it must be omitted.
 *
 * @param {object} args
 * @param {unknown} args.platform — `platform` of the session's `session.started`
 * @param {unknown} args.counts — result of {@link tallyWorkEvents} / {@link countWorkEvent}
 * @param {boolean} args.complete — true only when the caller read the session's
 *   history whole: one raw id, its `session.started` found, no unread or pruned
 *   archive inside its window
 * @param {unknown} args.firstStartSource — `native_source` of the FIRST
 *   `session.started` the caller read for this session
 * @returns {{platform: string, turn_stops: number, agent_stops: number, wave_completions: number, activity_events: number}|null}
 */
export function workEvidenceFor({ platform, counts, complete, firstStartSource } = {}) {
  if (complete !== true) return null;
  if (typeof firstStartSource !== 'string' || !FRESH_START_SOURCES.includes(firstStartSource)) return null;
  if (typeof platform !== 'string' || !TURN_STOP_PLATFORMS.includes(platform)) return null;
  if (counts === null || typeof counts !== 'object') return null;
  if (!COUNT_KEYS.every((k) => Number.isSafeInteger(counts[k]) && counts[k] >= 0)) return null;
  return {
    platform,
    turn_stops: Math.max(counts.turn_stops, counts.legacy_turn_stops),
    agent_stops: counts.agent_stops,
    wave_completions: counts.wave_completions,
    activity_events: counts.activity_events,
  };
}

/**
 * The event that marks a session as an SO run (#1975): `/session` emits it the
 * moment its mode became an execution plan. Same string as `SESSION_SHAPE_EVENT`
 * in `scripts/lib/session-shape.mjs` (not imported: that module is not part of
 * this zero-import submodule's closure).
 * `session.lock.acquired` is NOT such a mark — the SessionStart hook takes the
 * lock mechanically for every session (`hooks/_lib/lock-bootstrap.mjs`).
 */
export const SO_RUN_EVENT = 'orchestrator.session.shape_resolved';

/** The event every backfill outcome is emitted as (SessionEnd hook, SessionStart path). */
export const BACKFILL_COMPLETED_EVENT = 'orchestrator.session.backfill_completed';

/** The backfill outcome for a session that ended without ever running SO (#1975). */
export const NO_RUN_ACTION = 'skipped-no-run';

/**
 * The day #1975 changed what the census rates count: from then on a session
 * that never ran SO gets no record, so it leaves `abort_rate_all`, while the
 * historical `conversation` / `empty` stubs of such sessions stay in it.
 */
export const NO_RUN_SINCE = '2026-11-08';

/**
 * Skills whose `selected` row in `skill-invocations.jsonl` marks an SO run
 * (#1975): `/session` and session-start. The PreToolUse Skill hook
 * (`hooks/skill-invocation-telemetry.mjs`) stamps the raw session id on them.
 * Measured 2026-11-08 over the last 3000 rows of this repo's ledger:
 * session-start 298 rows (39 with `session_id: null` — the skill's own
 * Phase 1.05 self-report, which joins nothing), `session` 106 rows, all with a
 * raw id.
 */
export const SO_RUN_SKILLS = Object.freeze(['session-orchestrator:session', 'session-orchestrator:session-start']);

/**
 * Platforms that register the skill-invocation hook, so that the ABSENCE of a
 * {@link SO_RUN_SKILLS} row is a measurement. Measured 2026-11-08:
 * `hooks/hooks.json` (Claude Code) registers `skill-invocation-telemetry.mjs`,
 * `hooks/hooks-codex.json` does not. On any other platform the skill signal is
 * unknown (`null`), never `false`. Revisit when another platform's hook file
 * registers the Skill telemetry hook.
 */
export const SKILL_HOOK_PLATFORMS = Object.freeze(['claude']);

/**
 * True when a session that ended without its own record never ran SO (#1975):
 * its evidence is MEASURED (a well-formed {@link workEvidenceFor} result), it
 * shows no agent stop and no wave completion, no {@link SO_RUN_EVENT} of it
 * was read, and no {@link SO_RUN_SKILLS} call of it was read. A lead tab, a
 * pure conversation, a tab the inbox closes via `/exit` — none of them is an
 * aborted run, so no `abandoned` stub is written; a `/session` that ended in
 * session-start or plan is one, and keeps its stub. The single predicate for
 * the SessionEnd hook and the SessionStart backfill (both call
 * `backfillAbandonedSession`).
 *
 * Fails toward recording: every signal must be an explicit `false`, and
 * unmeasured evidence (`null`) is never no-run. The skill signal is `false`
 * only when a skill ledger EXISTS and was read on a {@link SKILL_HOOK_PLATFORMS}
 * platform. A missing ledger (ENOENT in every root) is `null`: the hook creates
 * the file on the first Skill call of the repo, so a missing file means either
 * no skill ever ran there or the hook is off (`SO_HOOK_PROFILE` /
 * `SO_DISABLED_HOOKS`) — the second case would drop a real `/session` run.
 * Cost: in a repo where no Skill was ever called, no-run sessions keep their
 * `abandoned` stub until the first call creates the ledger.
 * Ceiling (BV-004): a ledger that exists but whose hook was switched off later
 * still reads as measured. Revisit when a no-run verdict is found for a session
 * whose transcript shows a `/session` call.
 *
 * @param {unknown} evidence — the stub's `work_evidence` (or null/undefined)
 * @param {{shapeResolved?: unknown, soRunSkill?: unknown}} [signals]
 *   `shapeResolved` — an SO_RUN_EVENT of the session was read;
 *   `soRunSkill` — a SO_RUN_SKILLS row of its raw id was read (`null` = unknown)
 * @returns {boolean}
 */
export function isNoRunEvidence(evidence, { shapeResolved, soRunSkill } = {}) {
  if (shapeResolved !== false || soRunSkill !== false) return false;
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  if (!Number.isSafeInteger(evidence.agent_stops) || !Number.isSafeInteger(evidence.wave_completions)) return false;
  return evidence.agent_stops === 0 && evidence.wave_completions === 0;
}
