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
 *   {"timestamp":<ISO>,"event":"orchestrator.session.ended","session_id":"...","reason":"<reason>","duration_ms":<int>}
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
import { backfillAbandonedSession } from '../scripts/lib/session-close-backfill.mjs';
import { readLock, release } from '../scripts/lib/session-lock.mjs';

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
 * Resolve this session's id + duration + semantic id. Stdin session_id wins;
 * otherwise fall back to `.orchestrator/current-session.json` (written by
 * on-session-start.mjs). duration_ms is only computed when the ENDING session
 * is the one recorded in current-session.json — never fabricated for a
 * mismatched / unknown session.
 *
 * `semanticSessionId` is read from current-session.json (present since #587):
 * it is the SEMANTIC id (`<branch>-<date>-<mode>-<n>`) that sessions.jsonl is
 * keyed by, and the id the backfill (C1 #724) uses when the stdin session_id is
 * a harness UUID with no lock.acquired bridge.
 *
 * @param {object|null} input
 * @param {string} projectRoot
 * @returns {Promise<{sessionId: string|null, semanticSessionId: string|null, durationMs: number}>}
 */
async function resolveSession(input, projectRoot) {
  const fromStdin = input?.session_id ?? input?.sessionId ?? null;
  let sessionId = (typeof fromStdin === 'string' && fromStdin.length > 0) ? fromStdin : null;

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

  if (sessionId === null) sessionId = recordedId;

  // Only trust the recorded start time when the ending session IS the recorded one.
  const durationMs =
    startedAtMs !== null && sessionId !== null && sessionId === recordedId
      ? Math.max(0, Date.now() - startedAtMs)
      : 0;

  return { sessionId, semanticSessionId, durationMs };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdinJson();
  const projectRoot = SO_PROJECT_DIR;

  const reason =
    typeof input?.reason === 'string' && input.reason.length > 0 ? input.reason : 'other';
  const { sessionId, semanticSessionId, durationMs } = await resolveSession(input, projectRoot);

  // Single emission path: emitEvent writes the canonical {timestamp, event, ...payload}
  // JSONL record AND fires the optional Clank webhook with the SAME event name.
  await emitEvent('orchestrator.session.ended', {
    ...(sessionId !== null ? { session_id: sessionId } : {}),
    reason,
    duration_ms: durationMs,
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
    await backfillAbandonedSession({ repoRoot: projectRoot, sessionId, semanticSessionId });
  } catch { /* best-effort — never block teardown */ }

  // (b) Deterministic lock release — ONLY our OWN lock. Match by UUID first,
  //     then by semantic id (the UUID rotates across clear/compact/resume while
  //     the semantic id stays stable, #612). A foreign lock is never released.
  try {
    const lock = readLock({ repoRoot: projectRoot });
    if (lock) {
      const ownByUuid = sessionId !== null && lock.session_id === sessionId;
      const ownBySemantic =
        semanticSessionId !== null && lock.semantic_session_id === semanticSessionId;
      if (ownByUuid || ownBySemantic) {
        release({ sessionId: lock.session_id, repoRoot: projectRoot });
      }
    }
  } catch { /* best-effort — never block teardown */ }
}

// Exit 0 always — informational hook must never block session teardown.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
