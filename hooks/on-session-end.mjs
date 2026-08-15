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
  isLockLive,
  loadOwnerProof,
  isLockOwnedByProof,
  OWNER_PROOF_RELPATH,
} from '../scripts/lib/session-lock.mjs';
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
 * a harness UUID with no lock.acquired bridge.
 *
 * #863 defect (c) — `semanticSessionId` is gated by the SAME "ending session
 * IS the recorded one" check as `durationMs` above. `current-session.json` is
 * a single repo-global file: it always reflects whichever session most
 * recently ran SessionStart, which may be a DIFFERENT, still-live session
 * when multiple windows share this repo. Before this fix, a foreign
 * terminating window (its own stdin `session_id` explicitly present, but NOT
 * equal to the recorded session) still inherited the CURRENTLY-recorded
 * session's `semantic_session_id` unconditionally — main()'s `ownBySemantic`
 * check then matched that OTHER, still-running session's lock and released
 * it. Gating this field closes that window: an unrelated/mismatched ending
 * session now resolves `semanticSessionId: null`, so `ownBySemantic` can
 * never accidentally fire on someone else's identity.
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

  // (b) Deterministic lock release — ONLY our OWN lock. Match by UUID first,
  //     then by semantic id (the UUID rotates across clear/compact/resume while
  //     the semantic id stays stable, #612). A foreign lock is never released.
  //
  //     Epic #724 hardening ("ended logged but lock survived"): the ownership
  //     match alone left two silent failure modes —
  //       (1) release() can fail at the fs layer; the swallowed try/catch below
  //           made this invisible (session.ended is logged, the lock survives).
  //       (2) when the harness UUID rotates (clear/compact/resume) and
  //           current-session.json's semantic_session_id is null/stale, BOTH
  //           ownership checks are false and this branch never runs release()
  //           at all — the lock survives until the NEXT session-start's own
  //           reaper sweep discovers it.
  //     Both are addressed below without loosening the strict
  //     never-release-a-foreign-lock invariant: release() only ever runs when
  //     ownership matched; the reconciliation fallback only ever runs through
  //     reapRepoLock(), which independently NEVER reaps a live lease (and only
  //     ever reaps on this same host with a dead recorded PID).
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
      const ownByUuid = sessionId !== null && lock.session_id === sessionId;
      const ownBySemanticStrict =
        semanticSessionId !== null && lock.semantic_session_id === semanticSessionId;
      // #863 (d) — lock-shape trap: some on-disk locks store the semantic id
      // directly in `session_id` with no separate `semantic_session_id` field
      // at all (the "generated-semantic" acquisition path in
      // on-session-start.mjs mints `session_id === the semantic id`, and
      // bootstrapLock's v2 enrichment step never ran for that lock). Without
      // this fallback, ownBySemanticStrict is dead code for that shape.
      const ownBySemanticFallback =
        semanticSessionId !== null && lock.session_id === semanticSessionId;
      const ownBySemantic = ownBySemanticStrict || ownBySemanticFallback;

      // #987 Part 2 — persisted ownership proof (pid + host + started_at,
      // written at lock genesis by bootstrapLock Step 2b, see
      // writeOwnerProof() in session-lock.mjs). loadOwnerProof() is
      // fail-closed: a missing/corrupt proof file yields null, and a null
      // proof presented to isLockOwnedByProof() yields false — the hook then
      // degrades to exactly the pre-#987 (proof-less) behaviour below.
      const proof = loadOwnerProof({ repoRoot: projectRoot });
      const ownByProof = isLockOwnedByProof(lock, proof);

      // #906-class fix: the semantic session id
      // (`<branch>-<date>-<mode>-<n>`) is NOT globally unique — the
      // id-counter can hand out the SAME id to two different session
      // processes (live-observed twice on 2026-07-29: `main-2026-07-29-deep-1`
      // and `main-2026-07-29-session-1`, each assigned to two distinct
      // sessions). A live lock matched ONLY via a collidable semantic id
      // (strict OR fallback, never corroborated by a non-collidable factor)
      // is therefore NEVER trusted for release.
      //
      // #987 Part 2 — the discrimination the #906-class fix escalated as
      // "structurally unobservable" is now OBSERVABLE via the persisted
      // owner proof: a genuine same-session UUID rotation (clear/compact)
      // and a foreign same-day semantic collision used to produce the
      // IDENTICAL shape here (UUID mismatch + semantic match on a live
      // lock), so the previous fix conservatively left BOTH un-released
      // (bounded by the ttl_hours reaper). The proof written at lock genesis
      // (pid + host + started_at — presence-at-genesis, never the collidable
      // session_id/semantic id, see the FACTOR CHOICE docblock on
      // isLockOwnedByProof()) is exactly the discriminator that RCR-007
      // escalation named: on a self-rotation the on-disk lock is FROZEN at
      // its pre-rotation values (bootstrapLock's shouldForce is false for a
      // rotated UUID, so it bails without touching the lock), which are the
      // SAME values the proof captured at genesis → ownByProof is true → the
      // lock is released correctly. A foreign same-day collision wrote its
      // lock in a DIFFERENT process at a DIFFERENT millisecond → ownByProof
      // is false → semanticOnlyLive stays true → no release, the foreign
      // lease survives (the never-release-a-foreign-lock invariant is
      // untouched). No proof on disk (pre-#987 sessions, failed proof
      // write) → ownByProof false → the conservative pre-#987 behaviour.
      const semanticOnlyLive = !ownByUuid && !ownByProof && ownBySemantic && isLockLive(lock);
      const releaseEligible = (ownByUuid || ownBySemantic) && !semanticOnlyLive;

      if (releaseEligible) {
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
          sessionId: lock.session_id,
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
        // Root-cause reconciliation fallback: either NEITHER the UUID nor the
        // semantic id matched the recorded lock, OR the ONLY match was a
        // collidable semantic comparison (strict or fallback) on a lock that
        // is still live (semanticOnlyLive). attemptLockReconciliation() is
        // the extracted, DI-testable seam (Issue #748) — it internally
        // no-ops when the lease is still live (isLockLive), which is exactly
        // what makes it safe to route the semanticOnlyLive case here too: it
        // is otherwise best-effort, and reapRepoLock() never touches a live
        // lease, a cross-host lease, or a lease whose recorded PID is still
        // alive on this host.
        await attemptLockReconciliation({ repoRoot: projectRoot, sessionId, lock });
      }
    }
    // 'absent' — no lock file at all; nothing to release or reconcile
    // (mirrors the pre-existing `if (lock)` guard's false branch).
  } catch { /* best-effort — never block teardown */ }
}

// Exit 0 always — informational hook must never block session teardown.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
