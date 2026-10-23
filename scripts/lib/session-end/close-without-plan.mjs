/**
 * close-without-plan.mjs — the `sessions.jsonl` record of a `/close` that has
 * no own plan to close (GitLab #1762).
 *
 * The `/close` pre-check (`close-precheck.mjs`) stops on `foreign`, `no-state`,
 * `unexpected-status`, an unconfirmed `ownership-unproven`, … — session-end
 * never runs, so no record is written. The SessionEnd hook does not cover the
 * gap either: on a tab `/clear` it skips the abandoned backfill, and with a
 * lead holding the main checkout lock it returns `skipped-foreign-live-lock`.
 * Five fleet sessions (nights of 2026-10-22/23) ended that way without a trace.
 *
 * This writer records ONLY the closing session itself, keyed by this process's
 * native id X (`readProcessLocalSessionIds`). It never takes anything from a
 * STATE.md — the one it saw belongs to another session, or does not exist.
 *
 * Status `closed-without-plan`, not `completed`: a later own plan under the
 * same id would read `already-finalized` and its real record would never be
 * written. Dedupe with the SessionEnd backfill runs both ways: the record
 * carries `raw_session_id: X` (`findRecordedSession` matches it), and both
 * writers claim the same TOCTOU marker keyed by X (`markerName`).
 */

import fs from 'node:fs';
import path from 'node:path';

import { appendJsonl } from '../common.mjs';
import { eventsFilePath, scanEventsBackwards } from '../events.mjs';
import { readJsonlFile } from '../io.mjs';
import { explainEventsLedgerRoot, resolveEventsLedgerRoot } from '../platform.mjs';
import { findRecordedSession, isUuid, markerName } from '../session-close-backfill.mjs';
import { readProcessLocalSessionIds } from '../session-identity/own-session.mjs';
import { readRegistry } from '../session-registry.mjs';
import { serializeSessionLineChecked } from '../session-schema.mjs';
import { validateSession } from '../session-schema/validator.mjs';
import { RUNS_SESSION_END } from './close-precheck.mjs';

const EVENT_STARTED = 'orchestrator.session.started';
const EVENT_LOCK_ACQUIRED = 'orchestrator.session.lock.acquired';
/**
 * Events-ledger window for the #1401 census (`events-retention-banner.mjs`):
 * `null` — {@link readOwnEvents} reads back as far as this session's own
 * `session.started`, however old, so no day count bounds it. A cut history
 * leaves that event unread: the started time then falls back to the registry
 * entry, else to now, and the record lists `started_at` among
 * `_backfill_incomplete_fields` — never a guessed time.
 */
export const REQUIRED_EVENTS_WINDOW_DAYS = null;

/** Wall-clock budget for the backwards events walk (rotated archives included). */
const EVENTS_SCAN_BUDGET_MS = 3000;

/**
 * This session's own facts from the events ledger: its `session.started`
 * timestamp and the semantic label its own `lock.acquired` carried. Only events
 * whose `session_id` is exactly X count — a label never comes from a peer.
 *
 * @param {string} repoRoot
 * @param {string} rawId
 * @returns {{ startedAt: string|null, label: string|null }}
 */
function readOwnEvents(repoRoot, rawId) {
  let startedAt = null;
  let label = null;
  try {
    scanEventsBackwards({
      filePath: eventsFilePath(repoRoot),
      filter: rawId,
      budgetMs: EVENTS_SCAN_BUDGET_MS,
      onRecord: (ev) => {
        if (!ev || ev.session_id !== rawId) return false;
        // Walking newest first: the last started seen is the earliest one.
        if (ev.event === EVENT_STARTED && typeof ev.timestamp === 'string' && !Number.isNaN(Date.parse(ev.timestamp))) {
          startedAt = ev.timestamp;
        } else if (ev.event === EVENT_LOCK_ACQUIRED && label === null
          && typeof ev.semantic_session_id === 'string' && ev.semantic_session_id.trim()) {
          label = ev.semantic_session_id.trim();
        }
        return false;
      },
    });
  } catch {
    /* unreadable events ledger → fall through to the registry / now */
  }
  return { startedAt, label };
}

/** `started_at` of this session's own registry entry, or null. */
async function readOwnRegistryStart(rawId) {
  try {
    const entry = (await readRegistry()).find((e) => e?.session_id === rawId);
    const at = entry?.started_at;
    return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Write the `closed-without-plan` record for the session running `/close`.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot  working tree `/close` runs in (a linked
 *   worktree maps to its main checkout's ledger)
 * @param {{ verdict: string, reason?: string }} opts.precheck  result of
 *   `classifyCloseState`
 * @param {object} [opts.env=process.env]  injectable for tests
 * @param {() => Date} [opts.now]  injectable clock
 * @returns {Promise<{ written: boolean, verified?: boolean, reason?: string,
 *   session_id?: string, raw_session_id?: string }>}
 *   `written: false` always carries a `reason`: `no-native-id`,
 *   `hand-off-verdict`, `ledger-unreadable`, `ledger-root-unresolved`,
 *   `already-recorded`, `marker-exists`, `marker-failed`, `invalid-record`,
 *   `append-failed`.
 */
export async function recordCloseWithoutPlan({ repoRoot, precheck, env = process.env, now = () => new Date() } = {}) {
  const rawId = readProcessLocalSessionIds({ env })[0] ?? null;
  if (!rawId) return { written: false, reason: 'no-native-id' };
  const refuse = (reason) => ({ written: false, reason, raw_session_id: rawId });

  const verdict = precheck?.verdict;
  if (RUNS_SESSION_END.has(verdict)) return refuse('hand-off-verdict');
  if (verdict === 'inconclusive' && /^sessions\.jsonl unreadable/.test(precheck?.reason ?? '')) {
    return refuse('ledger-unreadable');
  }

  const { resolved } = explainEventsLedgerRoot(repoRoot);
  if (!resolved) return refuse('ledger-root-unresolved');
  const sessionsPath = path.join(resolveEventsLedgerRoot(repoRoot), '.orchestrator', 'metrics', 'sessions.jsonl');
  const readLedger = () => readJsonlFile(sessionsPath, { skipInvalid: true });

  let records;
  try {
    records = readLedger();
  } catch {
    return refuse('ledger-unreadable');
  }
  // No label from any STATE.md: the raw id alone decides "already recorded".
  if (findRecordedSession(records, { sessionId: rawId })) return refuse('already-recorded');

  const markerDir = path.dirname(sessionsPath);
  const markerPath = path.join(markerDir, markerName(rawId));
  if (fs.existsSync(markerPath)) return refuse('marker-exists');

  const own = readOwnEvents(repoRoot, rawId);
  const startedAt = own.startedAt ?? await readOwnRegistryStart(rawId);
  const nowIso = now().toISOString();
  // Same naming as the abandoned backfill: the own semantic label when it is
  // not already a key in the ledger, otherwise the raw id (label kept beside).
  const labelTaken = own.label !== null && records.some((r) => r?.session_id === own.label);
  const sessionId = own.label !== null && !labelTaken ? own.label : rawId;

  const record = {
    session_id: sessionId,
    session_type: 'unknown',
    started_at: startedAt !== null ? new Date(Date.parse(startedAt)).toISOString() : nowIso,
    completed_at: nowIso,
    total_waves: 0,
    waves: [],
    agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
    total_agents: 0,
    total_files_changed: 0,
    status: 'closed-without-plan',
    close_reason: typeof verdict === 'string' ? verdict : 'unknown',
    raw_session_id: rawId,
    _backfill_source: 'close-without-plan',
  };
  if (labelTaken) record.semantic_session_id = own.label;
  if (startedAt === null) record._backfill_incomplete_fields = ['started_at'];
  // A non-UUID raw id (a platform with another id shape) cannot be joined by
  // findRecordedSession's native branch; the label branch still matches it.

  let validated;
  try {
    validated = validateSession(record);
    serializeSessionLineChecked(validated);
  } catch {
    return refuse('invalid-record');
  }

  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.closeSync(fs.openSync(markerPath, 'wx'));
  } catch (err) {
    return refuse(err?.code === 'EEXIST' ? 'marker-exists' : 'marker-failed');
  }

  try {
    await appendJsonl(sessionsPath, validated);
  } catch {
    // Give the claim back (mirrors the backfill, #1609): a marker without its
    // record would keep this session from ever being recorded.
    try { fs.unlinkSync(markerPath); } catch { /* best-effort */ }
    return { written: false, reason: 'append-failed', session_id: sessionId, raw_session_id: rawId };
  }

  let verified = false;
  try {
    const found = findRecordedSession(readLedger(), { sessionId: rawId, semanticSessionId: isUuid(rawId) ? null : sessionId });
    verified = found?.raw_session_id === rawId;
  } catch {
    /* re-read failed → stays unverified */
  }
  return { written: true, verified, session_id: sessionId, raw_session_id: rawId };
}
