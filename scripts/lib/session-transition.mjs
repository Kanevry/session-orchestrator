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
 * ## Deliberate deltas vs `hooks/on-session-end.mjs` (its release block)
 *
 * The two teardowns share the ownership gate and now the
 * `orchestrator.session.lock.released` breadcrumb, and diverge in four places
 * ON PURPOSE. Each divergence is a narrower authority, never an oversight:
 *
 *  1. **No reconciliation on a raw-ID mismatch.** SessionEnd calls
 *     `attemptLockReconciliation()`, which may reap a provably-dead foreign
 *     lease. A worktree promotion is not a lifecycle end for the foreign
 *     session and carries no mandate over its lease: this function returns
 *     `lock-session-mismatch:<owner>` and touches nothing.
 *  2. **No owner-proof unlink after a successful release.** SessionEnd removes
 *     the genesis proof as hygiene because the session is ending. Here the
 *     session continues in the DESTINATION root; the source proof is
 *     self-invalidating (its millisecond `started_at` can never match a future
 *     lock) and deleting it would be a write outside the teardown's remit.
 *  3. **No `orchestrator.session.lock.read_anomaly` breadcrumb.** An
 *     unparseable lock aborts this teardown outright and is reported in the
 *     RETURN value (`ok: false`, `reason: 'lock-unreadable'|'lock-corrupt'`),
 *     which the caller must surface as a WARN. SessionEnd has no return channel
 *     to its caller, so there the event is the only place the anomaly can land.
 *  4. **No `orchestrator.session.lock.release_failed` breadcrumb.** Same
 *     reason as (3): a failed release surfaces as `ok: false` plus
 *     `reason: 'lock-<release-reason>'` to a caller that is required to WARN on
 *     it, so the stream is not the only witness.
 *
 * @module scripts/lib/session-transition
 */

import path from 'node:path';

import { deregisterSelf, readRegistry, repoPathHash } from './session-registry.mjs';
import { readLockDetailed, loadOwnerProof, release } from './session-lock.mjs';
import { emitEvent } from './events.mjs';

/** Event name emitted once per completed source-root departure. */
export const ROOT_LEFT_EVENT = 'orchestrator.session.root_left';

/** Shared lock-release breadcrumb — same event the other two `release()` call sites emit. */
export const LOCK_RELEASED_EVENT = 'orchestrator.session.lock.released';

/**
 * Release this session's claim on `repoRoot` because the session is leaving it
 * for good. Ordering is load-bearing and fixed:
 *
 *   1. `readLockDetailed()` — OWNERSHIP IS ESTABLISHED BEFORE ANYTHING IS
 *      REMOVED. A lock this session does not own, or one that cannot be parsed,
 *      aborts the teardown with `ok: false` and zero side effects. (This used to
 *      run second, after the registry entry had already been deleted: a caller
 *      passing the wrong `sessionId` destroyed a live registry entry and was
 *      told `ok: true` — the registry half of the very phantom-peer state the
 *      function exists to prevent.)
 *   2. `deregisterSelf(sessionId)` — the host-wide registry entry. The registry
 *      is one file per harness session id, so this removes the session's ONLY
 *      entry; the destination worktree's own SessionStart registers itself
 *      afresh under its own identity (that is what "process boundary" means).
 *      Gated a second time on the entry's `repo_path_hash`: an entry that
 *      describes a DIFFERENT root is not this root's claim, and deleting it
 *      would silently unregister a session living somewhere else.
 *   3. `release()` of the old root's `session.lock`, gated exactly as
 *      `hooks/on-session-end.mjs` gates it, followed by the shared
 *      `orchestrator.session.lock.released` breadcrumb (`caller:
 *      'session-transition'`) so this third `release()` call site is visible on
 *      the same stream as the other two.
 *   4. `emitEvent(ROOT_LEFT_EVENT)` into the OLD root's events.jsonl — the
 *      breadcrumb that says which root was left and why. Emitted even when a
 *      step above found nothing: "nothing to release" is itself a fact worth
 *      recording, and a departure that left no trace is exactly the
 *      indistinguishable-from-a-crash state #1069 was filed about. NOT emitted
 *      on an aborted teardown (foreign lock, unparseable lock, invalid args):
 *      the event asserts that a root was LEFT, and on those branches nothing
 *      was — writing it would put a fiction in a stream that, unlike the
 *      registry, may belong to the session that actually owns this root.
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
 * @param {object} [deps] — test seams (same shape as `foreign-dispatch.mjs`).
 * @param {Function} [deps.emitFn] — event-emitter seam; defaults to `emitEvent`.
 * @returns {Promise<{
 *   ok: boolean,
 *   steps: { deregistered: boolean, released: boolean, emitted: boolean },
 *   reason?: string
 * }>}
 *   `steps` are literal outcomes: `deregistered` = a registry file was removed,
 *   `released` = the lock file was deleted, `emitted` = the `root_left` event
 *   was appended.
 *
 *   `ok: false` means the departure is NOT provably complete — invalid input, a
 *   lock owned by someone else, an unparseable lock, a registry entry pinned to
 *   a different root, a registry unlink that failed, a contradictory owner
 *   proof, or a filesystem error. Callers WARN on it and continue; see the
 *   `enterWorktree: leaveSourceRoot: <reason>` contract in
 *   `skills/_shared/parallel-aware-auq.md`.
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
} = {}, deps = {}) {
  const emit = deps.emitFn ?? emitEvent;
  const steps = { deregistered: false, released: false, emitted: false };

  if (typeof repoRoot !== 'string' || repoRoot.length === 0
    || typeof sessionId !== 'string' || sessionId.length === 0) {
    // Nothing is attempted on unusable input — in particular no event, since
    // an event without a resolvable root has nowhere honest to be written.
    return { ok: false, steps, reason: 'invalid-args' };
  }

  // -- Step 1: ownership, BEFORE any removal --------------------------------
  // Mirrors hooks/on-session-end.mjs's release block: discriminate the read
  // first, compare the RAW session_id before touching the proof, and only then
  // hand the proof to release() as a second factor. An 'absent' lock is the
  // idempotent-rerun / never-acquired case and does NOT block the teardown.
  const lockDetail = readLockDetailed({ repoRoot });

  if (lockDetail.status === 'unreadable' || lockDetail.status === 'corrupt') {
    // Fail-closed and VISIBLE (issue #1069 AC: "fehlende oder widersprüchliche
    // Proofs degradieren sichtbar und fail-closed"). A lock we cannot parse is
    // neither released nor proven foreign — ownership stays indeterminate, so
    // nothing is removed and nothing is claimed.
    return { ok: false, steps, reason: `lock-${lockDetail.status}` };
  }

  if (lockDetail.status === 'ok' && lockDetail.lock.session_id !== sessionId) {
    // A different session owns this root's lock, so this root is not ours to
    // tear down — not the lock, and not the registry entry either. Aborting
    // with `ok: false` (rather than the pre-#1069-review `ok: true`) is the
    // point: a caller that passed the wrong id has NOT departed anything, and
    // reporting success let that mistake through silently.
    return { ok: false, steps, reason: `lock-session-mismatch:${lockDetail.lock.session_id}` };
  }

  let ok = true;
  let outcome = null;

  // -- Step 2: registry (host-wide) -----------------------------------------
  // Second ownership factor, on the registry's own terms: the entry records the
  // root it belongs to as a hash. When it names a DIFFERENT root, the entry is
  // some other checkout's live claim and unlinking it would unregister a
  // session that is still running there. Legacy v1 entries carry no hash — the
  // gate is skipped rather than fail-closed, because rejecting them would make
  // this teardown a no-op against exactly the old entries most likely to be
  // stale (same back-compat rule as `_validEntry`'s optional `mode`).
  let registryGateOk = true;
  try {
    const entry = (await readRegistry()).find((e) => e.session_id === sessionId);
    if (entry && typeof entry.repo_path_hash === 'string' && entry.repo_path_hash.length > 0
      && entry.repo_path_hash !== repoPathHash(repoRoot)) {
      registryGateOk = false;
      ok = false;
      outcome ??= 'registry-root-mismatch';
    }
  } catch { /* an unreadable registry is handled by deregisterSelf below */ }

  if (registryGateOk) {
    try {
      steps.deregistered = await deregisterSelf(sessionId);
    } catch (err) {
      ok = false;
      outcome ??= `deregister-failed:${err?.message ?? 'unknown'}`;
    }
  }

  // -- Step 3: lock (this root only) ----------------------------------------
  if (lockDetail.status === 'ok') {
    const proof = loadOwnerProof({ repoRoot });
    // `proof` is null whenever ownership cannot be proven; release() treats
    // null as absent (#989) and degrades to the session_id-only path, so it
    // is passed through unguarded — the spread-guard call sites needed
    // before that fix are exactly what the API contract removed.
    const result = release({ sessionId, repoRoot, proof });
    steps.released = result.ok === true && result.deleted === true;
    // 'no-lock' = the lock vanished between the read above and the release —
    // benign (idempotent rerun / concurrent SessionEnd), and forensically the
    // interesting half: someone else removed a lock we still held.
    const alreadyGone = result.ok === true && result.reason === 'no-lock';
    if (!steps.released) {
      if (!alreadyGone) ok = false;
      outcome ??= `lock-${result.reason ?? 'not-deleted'}`;
    }
    if (steps.released || alreadyGone) {
      // ARCH-MED-1 — this is the THIRD `release()` call site in the repo and
      // was the only one silent on `orchestrator.session.lock.*`. Emitted at
      // the call site, never inside release(): session-lock.mjs carries no
      // dependency on events.mjs, and release() is synchronous.
      try {
        await emit(LOCK_RELEASED_EVENT, {
          session_id: sessionId,
          ...(semanticSessionId ? { semantic_session_id: semanticSessionId } : {}),
          caller: 'session-transition',
          outcome: steps.released ? 'deleted' : 'already-gone',
          verified: result.verified === true,
        }, { repoRoot });
      } catch { /* observability is best-effort — the return value still tells */ }
    }
  }

  if (outcome === null && !steps.deregistered && !steps.released) {
    outcome = 'already-gone';
  }

  // -- Step 4: breadcrumb ----------------------------------------------------
  try {
    await emit(ROOT_LEFT_EVENT, {
      session_id: sessionId,
      ...(semanticSessionId ? { semantic_session_id: semanticSessionId } : {}),
      // NEVER the absolute path. emitEvent forwards the whole payload to the
      // optional Clank webhook with no redaction, and an absolute repo root on
      // this host is `/Users/<operator>/…`. The hash is the SAME function the
      // session registry keys its entries by (`repo_path_hash`), so a consumer
      // can still join a departure to the registry entry it removed; the
      // basename matches the registry's `repo_name`. Same rule as the
      // `board_written` / `mirror_completed` payloads and
      // `relativeWorktreePath` in worktree-pipeline.mjs.
      from_root_hash: repoPathHash(repoRoot),
      from_root_basename: path.basename(path.resolve(repoRoot)),
      reason,
    }, { repoRoot });
    steps.emitted = true;
  } catch (err) {
    ok = false;
    outcome ??= `emit-failed:${err?.message ?? 'unknown'}`;
  }

  return outcome === null ? { ok, steps } : { ok, steps, reason: outcome };
}
