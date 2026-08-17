/**
 * memory-cleanup-stamp.mjs — stamp `memory_cleanup_at` on a session record when
 * `/memory-cleanup` ran this session, and DERIVE that fact from the event log
 * instead of from coordinator recall.
 *
 * Issue #699 fix: a healthy no-op run of `/memory-cleanup` previously left
 * `memory_cleanup_at` unstamped, so `auto-dream.mjs` `readDreamSignals`
 * never advanced `lastCleanupAt` and `shouldDispatchAutoDream` kept firing a
 * false nudge. `stampMemoryCleanup()` stamps the field unconditionally whenever
 * the cleanup ran — including a healthy no-op where no memory files were mutated.
 *
 * #699 follow-up (Disziplin statt Mechanik): the `ranCleanup` boolean itself used
 * to come from the coordinator-LLM remembering a prose step at session-end. It
 * measurably failed — a `/memory-cleanup` ran on 2026-08-14 and all three session
 * records of that day read `memory_cleanup_at: null`, so the session-start banner
 * reported "29 days ago" while the operator's own notes said 3. Since then
 * `/memory-cleanup` emits `orchestrator.memory.cleanup_completed` and
 * `deriveMemoryCleanupSignal()` reads that event back out of
 * `.orchestrator/metrics/events.jsonl`, which is what `scripts/emit-session.mjs`
 * calls at write time. Nothing depends on recall any more.
 *
 * Design constraints:
 *   - `stampMemoryCleanup()` stays pure — no I/O, no side-effects.
 *   - No-throw — invalid inputs / unreadable-or-corrupt event log return the
 *     "no cleanup" answer rather than blocking a session close.
 *   - Testable seam — both functions are unit-tested directly.
 *   - No external deps — Node stdlib only.
 */

import { readFileSync } from 'node:fs';

/**
 * Event `/memory-cleanup` emits when a run completes (any mode, any outcome —
 * including a healthy no-op). Emitted via `scripts/emit-event.mjs` → the
 * canonical `emitEvent()` path; see `skills/memory-cleanup/SKILL.md` § Output.
 */
export const MEMORY_CLEANUP_EVENT = 'orchestrator.memory.cleanup_completed';

/**
 * Stamp `memory_cleanup_at` on a session record when `/memory-cleanup` ran.
 *
 * A cleanup run includes ALL outcomes: dry-run, apply-pending, AND healthy
 * no-op (MEMORY.md already healthy — no files mutated). The cadence marker
 * MUST advance even on a no-op so `shouldDispatchAutoDream` does not fire a
 * false nudge on the next session.
 *
 * @param {object} record       The in-memory session record object (not mutated).
 * @param {object} opts
 * @param {boolean} opts.ranCleanup  True when `/memory-cleanup` ran this session
 *   in any mode (dry-run, apply-pending, or interactive/healthy no-op).
 *   False or absent → return record unchanged.
 * @param {string}  opts.completedAt ISO-8601 UTC timestamp to write as
 *   `memory_cleanup_at`. Typically the session's `completed_at` value.
 *   Required when `ranCleanup === true`; if missing, returns record unchanged
 *   (defensive — never throws).
 * @returns {object} Shallow-cloned record with `memory_cleanup_at` set, OR
 *   the original record object when no stamp is applied.
 */
export function stampMemoryCleanup(record, { ranCleanup, completedAt } = {}) {
  // Guard: only stamp when the cleanup actually ran.
  if (ranCleanup !== true) {
    return record;
  }

  // Guard: completedAt is required to stamp; if missing, skip defensively.
  if (typeof completedAt !== 'string' || completedAt.length === 0) {
    return record;
  }

  // Guard: record must be a plain object; anything else is returned unchanged.
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }

  // Return a shallow clone with the stamp applied — never mutate the input.
  return { ...record, memory_cleanup_at: completedAt };
}

/**
 * Derive "did `/memory-cleanup` run in THIS session?" from the event log.
 *
 * Reads `eventsFile` and looks for `orchestrator.memory.cleanup_completed`
 * records that fall inside the session's own `[startedAt, completedAt]` window.
 * This is the mechanical replacement for the coordinator-supplied boolean.
 *
 * Matching rule (two clauses, both mechanical):
 *   1. the event's `timestamp` lies within `[startedAt, completedAt]` inclusive;
 *   2. IF the event carries a non-empty `semantic_session_id`, it must equal
 *      `sessionId` (sessions.jsonl `session_id` is the SEMANTIC id — the UUID
 *      `session_id` some events carry lives in a different id space and is
 *      deliberately NOT used for matching).
 *
 * Named ceiling (deliberate simplification): an event with NO attribution is
 * claimed on the window alone, so two parallel sessions in one repo with
 * overlapping windows both derive `ranCleanup: true`. The consequence is a
 * marginally generous cadence marker on the peer's record — never a MISSED
 * cleanup, which is the failure this whole path exists to prevent. Revisit
 * trigger: if per-session cleanup accounting is ever needed, attach
 * `semantic_session_id` to the emitted event and clause 2 makes it exact.
 * Scan cost is a single linear pass over `events.jsonl` (~23k lines,
 * size-rotated at SessionStart by `events-rotation.mjs`) — revisit if rotation
 * is ever removed.
 *
 * No-throw: a missing, unreadable, or partly-corrupt event log yields
 * `{ ranCleanup: false, ... }`. A session close must never fail because
 * telemetry is damaged.
 *
 * @param {object} opts
 * @param {string} opts.eventsFile  Absolute or CWD-relative path to events.jsonl.
 * @param {string} [opts.sessionId] The record's `session_id` (semantic form).
 * @param {string} opts.startedAt   Session `started_at` (ISO-8601).
 * @param {string} opts.completedAt Session `completed_at` (ISO-8601).
 * @returns {{ranCleanup: boolean, at: string|null, matches: number}}
 *   `at` is the LATEST matching event timestamp (null when none matched);
 *   `matches` is how many events matched (a run can emit more than one).
 */
export function deriveMemoryCleanupSignal({
  eventsFile,
  sessionId,
  startedAt,
  completedAt,
} = {}) {
  const none = { ranCleanup: false, at: null, matches: 0 };

  if (typeof eventsFile !== 'string' || eventsFile.length === 0) return none;

  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(completedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return none;
  }

  let raw;
  try {
    raw = readFileSync(eventsFile, 'utf8');
  } catch {
    // Missing / unreadable event log — no signal, never an error.
    return none;
  }

  const wantSession = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  let matches = 0;
  let latestMs = -Infinity;
  let latestTs = null;

  for (const line of raw.split('\n')) {
    // Cheap substring prefilter before the JSON.parse cost.
    if (line.length === 0 || !line.includes(MEMORY_CLEANUP_EVENT)) continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // corrupt line — skip, best-effort reader
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
    if (rec.event !== MEMORY_CLEANUP_EVENT) continue;

    const tsMs = Date.parse(rec.timestamp);
    if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs > endMs) continue;

    const semantic = rec.semantic_session_id;
    if (
      wantSession !== null &&
      typeof semantic === 'string' &&
      semantic.length > 0 &&
      semantic !== wantSession
    ) {
      continue; // attributed to a DIFFERENT session — not ours
    }

    matches += 1;
    if (tsMs > latestMs) {
      latestMs = tsMs;
      latestTs = rec.timestamp;
    }
  }

  return { ranCleanup: matches > 0, at: latestTs, matches };
}
