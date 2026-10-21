/**
 * close-precheck.mjs — the `/close` pre-check as code (#1661).
 *
 * The pre-check used to be prose that read `<state-dir>/STATE.md` and acted on
 * its `status` alone. It never asked whose STATE.md that is. Two failures
 * followed (2026-10-17, three sessions in one afternoon):
 *   - After `/clear` the tab runs under a NEW native id while STATE.md still
 *     carries the previous one. A completed foreign STATE.md read as "already
 *     finalized", the session answered with the wait sentence although its own
 *     handover was written, and the inbox kept nudging.
 *   - A foreign ACTIVE STATE.md (a peer working in the same checkout) passed
 *     condition 3, so session-end would have closed the peer's session.
 *
 * Ownership is decided on the native id only: STATE.md `session-id` (#1368)
 * against `readProcessLocalSessionIds()`. The session lock is no proof here —
 * it records the pid of the short-lived hook process, and in a shared checkout
 * it may name a peer.
 *
 * Ceiling (BV-004): a STATE.md without `session-id` (written before #1368) or
 * a process that cannot name its own id (Cursor, Pi, Codex without a thread
 * id) keeps the pre-#1661 status-only behaviour. Revisit when every writer
 * stamps `session-id` and every harness exposes a native id.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseStateMd } from '../state-md.mjs';
import { findRecordedSession } from '../session-close-backfill.mjs';
import { readLock } from '../session-lock.mjs';
import { readProcessLocalSessionIds } from '../session-identity/own-session.mjs';
import { readJsonlFile } from '../io.mjs';
import { resolveEventsLedgerRoot, resolveStateDir } from '../platform.mjs';

/** Verdicts that hand off to session-end; every other verdict stops `/close`. */
export const RUNS_SESSION_END = new Set(['run-session-end', 'complete-missing-record']);

/**
 * Classify `<state-dir>/STATE.md` for `/close`.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot  project root (the working tree `/close` runs in)
 * @param {string} [opts.stateDir]  `.claude` | `.codex` | `.cursor` | `.pi`; default from the platform
 * @param {object} [opts.env=process.env]  injectable for tests
 * @returns {{
 *   verdict: 'no-state'|'foreign'|'run-session-end'|'complete-missing-record'|'already-finalized'|'unexpected-status'|'inconclusive',
 *   ownership: 'own'|'foreign'|'legacy'|'unprovable'|null,
 *   status: string|null, stateSessionId: string|null, ownSessionIds: string[],
 *   statePath: string, reason?: string
 * }}
 */
export function classifyCloseState({ repoRoot, stateDir, env = process.env } = {}) {
  const dir = stateDir ?? resolveStateDir();
  const statePath = path.join(repoRoot, dir, 'STATE.md');
  const ownSessionIds = readProcessLocalSessionIds({ env });
  const base = { ownership: null, status: null, stateSessionId: null, ownSessionIds, statePath };

  if (!existsSync(statePath)) return { ...base, verdict: 'no-state' };

  const parsed = parseStateMd(readFileSync(statePath, 'utf8'));
  if (!parsed) return { ...base, verdict: 'inconclusive', reason: 'STATE.md has no readable frontmatter' };
  const fm = parsed.frontmatter;
  const status = typeof fm.status === 'string' ? fm.status : null;
  const rawId = typeof fm['session-id'] === 'string' ? fm['session-id'].trim() : '';
  const stateSessionId = rawId || null;

  const ownership = !stateSessionId ? 'legacy'
    : ownSessionIds.length === 0 ? 'unprovable'
      : ownSessionIds.includes(stateSessionId) ? 'own' : 'foreign';
  const known = { ...base, ownership, status, stateSessionId };

  // A foreign STATE.md is never this session's to close, whatever its status:
  // completed belongs to an earlier tab incarnation or a peer, active/paused to a
  // peer (or to this tab before a /clear, which this process cannot prove).
  if (ownership === 'foreign') return { ...known, verdict: 'foreign' };

  if (status === 'active' || status === 'paused') return { ...known, verdict: 'run-session-end' };
  if (status !== 'completed') return { ...known, verdict: 'unexpected-status' };

  // #429: completed alone does not prove the Phase 3.7 writer ran.
  let records;
  try {
    records = readJsonlFile(path.join(resolveEventsLedgerRoot(repoRoot), '.orchestrator', 'metrics', 'sessions.jsonl'));
  } catch (err) {
    return { ...known, verdict: 'inconclusive', reason: `sessions.jsonl unreadable: ${err.message}` };
  }
  // The lock fallback only for STATE.md without session-id (pre-#1368), and
  // only when the lock names THIS process (#1663). A peer's lock UUID would
  // become the native key in findRecordedSession, skip this session's own
  // record (different UUID) before the label match is reached, and send
  // session-end a second time. Foreign or unprovable lock → no fallback, the
  // label + started_at join decides.
  let lockId = null;
  if (!stateSessionId) {
    let raw;
    try { raw = readLock({ repoRoot })?.session_id ?? null; } catch { raw = null; }
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed && ownSessionIds.includes(trimmed)) lockId = trimmed;
  }
  const record = findRecordedSession(records, {
    sessionId: stateSessionId ?? lockId,
    semanticSessionId: fm.session ?? null,
    startedAt: fm.started_at ?? null,
  });
  // An abandoned backfill stub is no completion; a legacy record without
  // `status` (written before the field existed) is authoritative.
  const finalized = record && (record.status === undefined || record.status === 'completed');
  return { ...known, verdict: finalized ? 'already-finalized' : 'complete-missing-record' };
}
