/**
 * session-transition.mjs — the PROCESS-BOUNDARY teardown of a source repo root.
 *
 * Issue #1069 ("EnterWorktree/CwdChanged als eindeutigen Ein-Root-Übergang
 * modellieren"), operator decision 2026-08-28: **Prozessgrenze**, not live
 * migration. The source session ENDS regularly in the old root; a NEW session
 * with its own identity starts in the destination worktree. Nothing is
 * transferred — no lock hand-off, no registry rewrite, no proof migration.
 *
 * The gap this closes: session-start Phase 0.5 Worktree-Promotion calls
 * `enterWorktree()` and then "exits Phase 0 immediately". It released nothing
 * on the OLD root (measured 2026-08-28: zero `deregisterSelf` / `release(`
 * call sites across `skills/session-start/SKILL.md` and
 * `skills/_shared/parallel-aware-auq.md`). The abandoned registry entry keeps
 * reading FRESH to `detectPeers()` for `freshnessMin=15` minutes and is only
 * removed by `sweepZombies()` after `thresholdMin=60` — so the promoted-away
 * root advertises a PHANTOM peer for up to an hour, and the abandoned
 * `session.lock` blocks/skews every exclusivity decision in that root until
 * its TTL lapses.
 *
 * Ownership rules are NOT re-derived here. The lock half is the same shape
 * `hooks/on-session-end.mjs` uses: `readLockDetailed()` to distinguish an
 * absent lock from an unparseable one, an exact raw `lock.session_id ===
 * sessionId` compare BEFORE any proof is loaded, then `loadOwnerProof()`
 * handed to `release()` as the second identity factor (#987/#989).
 *
 * @module scripts/lib/session-transition
 */

import { deregisterSelf } from './session-registry.mjs';
import { readLockDetailed, loadOwnerProof, release } from './session-lock.mjs';
import { emitEvent } from './events.mjs';

/** Event name emitted once per completed (or attempted) source-root departure. */
export const ROOT_LEFT_EVENT = 'orchestrator.session.root_left';

/**
 * Release this session's claim on `repoRoot` because the session is leaving it
 * for good. Ordering is load-bearing and fixed:
 *
 *   1. `deregisterSelf(sessionId)` — the host-wide registry entry. The registry
 *      is one file per harness session id, so this removes the session's ONLY
 *      entry; the destination worktree's own SessionStart registers itself
 *      afresh under its own identity (that is what "process boundary" means).
 *   2. `release()` of the old root's `session.lock`, gated exactly as
 *      `hooks/on-session-end.mjs` gates it.
 *   3. `emitEvent(ROOT_LEFT_EVENT)` into the OLD root's events.jsonl — the
 *      breadcrumb that says which root was left and why. Emitted even when a
 *      step above found nothing: "nothing to release" is itself a fact worth
 *      recording, and a departure that left no trace is exactly the
 *      indistinguishable-from-a-crash state #1069 was filed about.
 *
 * The caller must invoke this BEFORE the destination worktree's own Phase 1.2
 * `acquire()` runs — never both roots owning a live lock/registry entry at
 * once, which is the double-live-UUID state the issue's acceptance criteria
 * forbid.
 *
 * NEVER THROWS. Every failure is reported in the returned structure, because
 * the sole caller is a promotion path that has already created the destination
 * worktree: a thrown error there would abort the transition halfway, leaving
 * precisely the two-live-roots state this function exists to prevent.
 *
 * @param {object} args
 * @param {string} args.repoRoot — absolute path of the root being LEFT.
 * @param {string} args.sessionId — the raw (physical) session id that owns the
 *   registry entry and the lock in `repoRoot`. NOT the semantic id.
 * @param {string|null} [args.semanticSessionId] — semantic id, when known.
 *   Omitted from the event payload when null/absent rather than emitted as
 *   `null` (same honest-encoding rule as `sessionAttribution()` in events.mjs).
 * @param {string} [args.reason='unspecified'] — why the root is being left,
 *   e.g. `'worktree-promotion'`. Recorded verbatim in the event payload.
 *   Defaults to `'unspecified'` rather than guessing `'worktree-promotion'`:
 *   a mislabelled reason is worse than an admittedly unknown one.
 * @returns {Promise<{
 *   ok: boolean,
 *   steps: { deregistered: boolean, released: boolean, emitted: boolean },
 *   reason?: string
 * }>}
 *   `steps` are literal outcomes: `deregistered` = a registry file was removed,
 *   `released` = the lock file was deleted, `emitted` = the event was appended.
 *
 *   `ok: false` means the departure is NOT provably complete — invalid input, a
 *   registry unlink that failed, an unparseable lock, a contradictory owner
 *   proof, or a filesystem error. A lock belonging to ANOTHER session is
 *   `ok: true` with `released: false`: refusing to delete a foreign lock is the
 *   correct outcome (PSA-005), not a failure.
 *
 *   `reason` is present whenever something other than a full clean teardown
 *   happened; `'already-gone'` is the idempotent-rerun case (nothing left to
 *   remove), which is `ok: true`.
 */
export async function leaveSourceRoot({
  repoRoot,
  sessionId,
  semanticSessionId = null,
  reason = 'unspecified',
} = {}) {
  const steps = { deregistered: false, released: false, emitted: false };

  if (typeof repoRoot !== 'string' || repoRoot.length === 0
    || typeof sessionId !== 'string' || sessionId.length === 0) {
    // Nothing is attempted on unusable input — in particular no event, since
    // an event without a resolvable root has nowhere honest to be written.
    return { ok: false, steps, reason: 'invalid-args' };
  }

  let ok = true;
  let outcome = null;

  // -- Step 1: registry (host-wide) ------------------------------------------
  try {
    steps.deregistered = await deregisterSelf(sessionId);
  } catch (err) {
    ok = false;
    outcome = `deregister-failed:${err?.message ?? 'unknown'}`;
  }

  // -- Step 2: lock (this root only) -----------------------------------------
  // Mirrors hooks/on-session-end.mjs's release block: discriminate the read
  // first, compare the RAW session_id before touching the proof, and only then
  // hand the proof to release() as a second factor.
  const lockDetail = readLockDetailed({ repoRoot });
  if (lockDetail.status === 'unreadable' || lockDetail.status === 'corrupt') {
    // Fail-closed and VISIBLE (issue #1069 AC: "fehlende oder widersprüchliche
    // Proofs degradieren sichtbar und fail-closed"). A lock we cannot parse is
    // neither released nor proven foreign — ownership stays indeterminate.
    ok = false;
    outcome ??= `lock-${lockDetail.status}`;
  } else if (lockDetail.status === 'ok') {
    const lock = lockDetail.lock;
    if (lock.session_id !== sessionId) {
      // A different session owns this root's lock. Leaving it standing is the
      // rule, not a shortfall — PSA-005 / release()'s own contract.
      outcome ??= `lock-session-mismatch:${lock.session_id}`;
    } else {
      const proof = loadOwnerProof({ repoRoot });
      // `proof` is null whenever ownership cannot be proven; release() treats
      // null as absent (#989) and degrades to the session_id-only path, so it
      // is passed through unguarded — the spread-guard call sites needed
      // before that fix are exactly what the API contract removed.
      const result = release({ sessionId, repoRoot, proof });
      steps.released = result.ok === true && result.deleted === true;
      if (!steps.released) {
        // 'no-lock' = the lock vanished between the read above and the
        // release — benign (idempotent rerun / concurrent SessionEnd).
        if (result.reason !== 'no-lock') ok = false;
        outcome ??= `lock-${result.reason ?? 'not-deleted'}`;
      }
    }
  }

  if (outcome === null && !steps.deregistered && !steps.released) {
    outcome = 'already-gone';
  }

  // -- Step 3: breadcrumb ----------------------------------------------------
  try {
    await emitEvent(ROOT_LEFT_EVENT, {
      session_id: sessionId,
      ...(semanticSessionId ? { semantic_session_id: semanticSessionId } : {}),
      from_root: repoRoot,
      reason,
    }, { repoRoot });
    steps.emitted = true;
  } catch (err) {
    ok = false;
    outcome ??= `emit-failed:${err?.message ?? 'unknown'}`;
  }

  return outcome === null ? { ok, steps } : { ok, steps, reason: outcome };
}
