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
import {
  readLockDetailed,
  release,
  loadOwnerProof,
  OWNER_PROOF_RELPATH,
} from '../scripts/lib/session-lock.mjs';
import { deregisterSelf, logSweepEvent } from '../scripts/lib/session-registry.mjs';
import { attemptLockReconciliation } from './_lib/lock-reconcile.mjs';

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
  const isRecordedSession = sessionId !== null && sessionId === recordedId;
  const durationMs = startedAtMs !== null && isRecordedSession
    ? Math.max(0, Date.now() - startedAtMs)
    : 0;

  // #863 defect (c) — same guard as durationMs above: only surface the
  // recorded semantic id when THIS ending session is genuinely the one
  // current-session.json describes. See the docblock above for the exact
  // contamination scenario this closes.
  const resolvedSemanticSessionId = isRecordedSession ? semanticSessionId : null;

  return { sessionId, semanticSessionId: resolvedSemanticSessionId, durationMs };
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
              semantic_session_id: semanticSessionId,
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
}

// Exit 0 always — informational hook must never block session teardown.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
