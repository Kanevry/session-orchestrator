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
 * Unproven ownership (#1718): a STATE.md without `session-id` (written before
 * #1368, in practice a foreign old file) or a process that cannot name its own
 * id never runs session-end on status alone. A would-be session-end verdict
 * becomes `ownership-unproven` with a `confirmToken` bound to the STATE.md path
 * and its raw bytes; only that token (`--confirm-own`) turns it back, and only while the
 * file is unchanged. Field incident 2026-10-21: a legacy STATE.md of an older,
 * already closed plan read `complete-missing-record`.
 *
 * Ceiling (BV-004): on platforms without a native id (Cursor, Pi, Codex
 * without a thread id) that is one operator confirmation per `/close`.
 * Revisit when those platforms expose a native session id.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseStateMd } from '../state-md.mjs';
import { findRecordedSession } from '../session-close-backfill.mjs';
import { readLock } from '../session-lock.mjs';
import { readProcessLocalSessionIds } from '../session-identity/own-session.mjs';
import { readJsonlFile } from '../io.mjs';
import { resolveEventsLedgerRoot, resolveStateDir } from '../platform.mjs';

/**
 * Confirmation token for an `ownership-unproven` STATE.md (#1718): bound to the
 * STATE.md path and its raw bytes, so a byte-identical file in another checkout
 * yields a different token.
 *
 * @param {string} statePath  path of the STATE.md (resolved to absolute)
 * @param {Buffer|string} raw  the raw STATE.md bytes
 * @returns {string}  16 lowercase hex characters
 */
export function computeConfirmToken(statePath, raw) {
  return createHash('sha256').update(path.resolve(statePath)).update('\0').update(raw).digest('hex').slice(0, 16);
}

/** Verdicts that hand off to session-end; every other verdict stops `/close`. */
export const RUNS_SESSION_END = new Set(['run-session-end', 'complete-missing-record']);

/**
 * Classify `<state-dir>/STATE.md` for `/close`.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot  project root (the working tree `/close` runs in)
 * @param {string} [opts.stateDir]  `.claude` | `.codex` | `.cursor` | `.pi`; default from the platform
 * @param {object} [opts.env=process.env]  injectable for tests
 * @param {string} [opts.confirmToken]  token from an earlier `ownership-unproven`
 *   result; bound to the STATE.md path and its raw bytes, confirms a legacy/unprovable
 *   STATE.md while that file is unchanged (#1718)
 * @returns {{
 *   verdict: 'no-state'|'foreign'|'run-session-end'|'complete-missing-record'|'already-finalized'|'unexpected-status'|'inconclusive'|'ownership-unproven',
 *   ownership: 'own'|'foreign'|'legacy'|'unprovable'|'confirmed'|null,
 *   status: string|null, stateSessionId: string|null, ownSessionIds: string[],
 *   statePath: string, reason?: string,
 *   wouldRun?: 'run-session-end'|'complete-missing-record', confirmToken?: string,
 *   session?: string|null, startedAt?: string|null
 * }}  the last four only with `ownership-unproven`
 */
export function classifyCloseState({ repoRoot, stateDir, env = process.env, confirmToken } = {}) {
  const dir = stateDir ?? resolveStateDir();
  const statePath = path.join(repoRoot, dir, 'STATE.md');
  const ownSessionIds = readProcessLocalSessionIds({ env });
  const base = { ownership: null, status: null, stateSessionId: null, ownSessionIds, statePath };

  if (!existsSync(statePath)) return { ...base, verdict: 'no-state' };

  const raw = readFileSync(statePath);
  const parsed = parseStateMd(raw.toString('utf8'));
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

  // #1718: legacy/unprovable never reaches session-end without a token bound
  // to this path and the bytes read here; every non-session-end verdict passes unchanged.
  const gate = (wouldRun) => {
    if (ownership === 'own') return { ...known, verdict: wouldRun };
    const token = computeConfirmToken(statePath, raw);
    if (confirmToken === token) return { ...known, ownership: 'confirmed', verdict: wouldRun };
    const unproven = {
      ...known, verdict: 'ownership-unproven', wouldRun, confirmToken: token,
      session: typeof fm.session === 'string' ? fm.session : null,
      startedAt: typeof fm.started_at === 'string' ? fm.started_at : null,
    };
    if (confirmToken === undefined) return unproven;
    return { ...unproven, reason: 'confirm token does not match STATE.md (changed since the pre-check, or the token belongs to another file)' };
  };

  if (status === 'active' || status === 'paused') return gate('run-session-end');
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
    let lockRaw;
    try { lockRaw = readLock({ repoRoot })?.session_id ?? null; } catch { lockRaw = null; }
    const trimmed = typeof lockRaw === 'string' ? lockRaw.trim() : '';
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
  return finalized ? { ...known, verdict: 'already-finalized' } : gate('complete-missing-record');
}
