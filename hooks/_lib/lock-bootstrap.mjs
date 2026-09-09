/**
 * lock-bootstrap.mjs — mechanical session.lock writer for the SessionStart hook.
 *
 * Epic #583 P3 closes the D1 wiring gap: until P3, `acquire()` from
 * scripts/lib/session-lock.mjs had no mechanical caller in the
 * /session or /deep flow (only the autopilot-multi pipeline called it).
 * The lock was written only when the coordinator-LLM happened to invoke
 * Phase 1.2 prose — silent skip → discoverActiveSessions() returns empty →
 * parallel-session AUQ never fires.
 *
 * This helper is invoked from hooks/on-session-start.mjs once per session.
 * It is intentionally best-effort: every failure path swallows its error
 * so the hook stays non-blocking (the hook's contract is informational-only;
 * a write failure here must NEVER break session-start).
 *
 * Schema v2 (Epic #583 D4 #587):
 *   {
 *     session_id:           string,  // native raw identity OR generated UUID; sole live lock/registry ownership key
 *     semantic_session_id:  string,  // attribution/history label only; never ownership
 *     started_at:           ISO,
 *     last_heartbeat:       ISO,     // basis for liveness; replaces PID-liveness checks
 *     mode:                 string,  // "deep"|"feature"|"housekeeping"|"session"|...
 *     pid:                  number,  // forensics only — DO NOT use for liveness (D2/D4)
 *     host:                 string,
 *     ttl_hours:            number,
 *   }
 *
 * The current scripts/lib/session-lock.mjs (pre-I3) writes the v1 shape
 * (no last_heartbeat, no semantic_session_id). This helper layers v2 fields
 * on top via an atomic tmp+rename overwrite — when I3 ships its v2 schema,
 * this helper's overlay becomes a no-op (the field is already there) and
 * everything continues to work.
 *
 * @module hooks/_lib/lock-bootstrap
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../../scripts/lib/io.mjs';

/**
 * Native SessionStart `source` values that are a RE-ENTRY into the same logical
 * session rather than a new one (#1091).
 *
 * SSOT for both consumers — the SessionStart hook's high-water-mark
 * preservation and the force-refresh gate below — so a later widening
 * ("`fork` is a re-entry too") can never reach one side only. It lives HERE,
 * in the leaf module, because the hook already imports this file while the
 * reverse direction would pull the whole hook's closure into a helper.
 *
 * `startup` is deliberately absent: a fresh process start must never inherit a
 * predecessor's markers or take over its lock.
 *
 * @type {ReadonlySet<string>}
 */
export const SAME_LOGICAL_SESSION_SOURCES = new Set(['resume', 'clear', 'compact']);

/**
 * Bootstrap the session.lock for this hook invocation.
 *
 * Best-effort: every internal failure is swallowed, the helper returns null
 * instead of throwing. Callers (the SessionStart hook) wrap this in a
 * try/catch anyway, but the helper itself never propagates.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot — absolute path to the repository root.
 * @param {string} opts.sessionId — the physical raw session id from the native
 *   harness, or a generated UUID when no trustworthy raw id exists. This is the
 *   only live lock/registry ownership key.
 * @param {string} [opts.semanticSessionId] — the semantic attribution/history
 *   label, surfaced separately and never used for ownership. When omitted, the
 *   field is populated by mirroring sessionId for backward-compatible display only.
 * @param {string} opts.mode — session mode (e.g. "deep", "feature").
 * @param {number} [opts.ttlHours=4] — lock TTL in hours.
 * @param {string|null} [opts.nativeSource=null] — the native SessionStart
 *   `source` (`startup`|`resume`|`clear`|`compact`), when the harness sent one.
 *   Only consulted for the same-logical-session force-refresh below; every
 *   existing caller that omits it keeps its pre-#1091 behaviour exactly.
 * @param {string|null} [opts.predecessorSessionId=null] — the raw `session_id`
 *   recorded in `.orchestrator/current-session.json` by our OWN previous run of
 *   this hook. It is the third, load-bearing conjunct of the re-entry
 *   force-refresh below: without it a same-host semantic-label collision (#1066)
 *   lets one session take over a live peer's lock. Omitting it (the default)
 *   disables the re-entry force-refresh entirely — fail-closed.
 * @param {Function} [opts._acquireImpl] — DI for tests (defaults to importing acquire from session-lock.mjs).
 * @param {Function} [opts._forceAcquireImpl] — DI for tests (defaults to importing forceAcquire from session-lock.mjs).
 * @param {Function} [opts._emitEventImpl] — DI for tests (defaults to importing emitEvent from events.mjs).
 * @returns {Promise<object|null>} the enriched v2 lock body on success, null on any failure.
 */
export async function bootstrapLock({
  repoRoot,
  sessionId,
  semanticSessionId,
  mode,
  ttlHours = 4,
  nativeSource = null,
  predecessorSessionId = null,
  _acquireImpl,
  _forceAcquireImpl,
  _emitEventImpl,
} = {}) {
  // Sanity-check required inputs. Anything missing → bail silently.
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof mode !== 'string' || mode.length === 0) return null;

  // Resolve DI shims at call time so test mocks can replace the imports.
  let acquireFn = _acquireImpl;
  let forceAcquireFn = _forceAcquireImpl;
  if (!acquireFn || !forceAcquireFn) {
    try {
      const lockMod = await import('../../scripts/lib/session-lock.mjs');
      acquireFn = acquireFn ?? lockMod.acquire;
      forceAcquireFn = forceAcquireFn ?? lockMod.forceAcquire;
    } catch {
      return null;
    }
  }

  // Step 1: try to acquire. If a fresh acquire succeeds, we are done.
  // If a stale-heartbeat lock exists, force-overwrite it (the prior session
  // stopped heartbeating past its ttl; the current raw owner can take the
  // worktree).
  // Only an exact match of the existing physical raw sessionId permits the
  // same-session force-refresh. semantic_session_id, STATE.md `session`, and
  // an owner proof never make a different raw id the same owner.
  let acquireResult;
  try {
    // quiet: true suppresses the unknown-mode stderr WARN in acquire() (#592 MED-2).
    // The hook is informational-only and tests assert stderr is empty.
    acquireResult = acquireFn({ sessionId, mode, ttlHours, repoRoot, quiet: true });
  } catch {
    return null;
  }

  if (!acquireResult || typeof acquireResult !== 'object') return null;

  // #1091 F2 — a same-logical-session re-entry whose RAW id the harness did not
  // preserve. `resume` entered the SessionStart matcher in #1091, so this hook
  // now runs on re-entry: if Claude Code mints a fresh raw `session_id` there,
  // `acquire()` returns `reason:'active'` with THIS SESSION'S OWN predecessor
  // lock as `existingLock` (its heartbeat is fresh, so it is live by
  // definition), `shouldForce` is false, and the hook bails — leaving the
  // session running for up to the 4 h TTL without owning its own lock, while
  // `recordConflictSignal()` below names the session's own former self as a
  // foreign conflict.
  //
  // THREE conjuncts gate the force, and all three are load-bearing:
  //   (a) `SAME_LOGICAL_SESSION_SOURCES.has(nativeSource)` — the harness itself
  //       says this is a re-entry rather than a fresh start;
  //   (b) `existingLock.semantic_session_id === semanticSessionId` — the lock's
  //       label is written by this same bootstrap, so an equal label means the
  //       predecessor was minted from the same (branch, date, mode, n) tuple;
  //   (c) `existingLock.session_id === predecessorSessionId` — the RAW id our
  //       own previous hook run recorded in current-session.json is the raw id
  //       the live lock carries.
  //
  // (a)+(b) alone are NOT enough (security review, #1066): semantic labels are
  // measurably collidable on one host — two sessions minted the SAME label when
  // the host-wide registry contributed nothing to the n-increment — so a
  // `/clear` in session B would take over session A's LIVE lock. (c) is the only
  // conjunct tied to a witness WE wrote about OURSELVES; it is deliberately not
  // `resumeLinkage === 'raw-id'`, which is true exactly when the raw id was
  // PRESERVED — the complement of the fresh-raw-id case this branch exists for.
  //
  // NOT gated on process liveness, deliberately: `pid` on a session.lock is the
  // ephemeral hook subprocess that WROTE it, so `isPidAliveOnHost(lock.pid)`
  // reports "dead" for essentially every lock including live heartbeating ones
  // (7/7 measured, #1137) — a vacuous predicate that would widen this branch to
  // every source, not narrow it. `isLockLive()` is no help either: under
  // `reason:'active'` acquire() has already established it is true
  // (session-lock.mjs `classifyExisting`).
  //
  // Ceiling (BV-004), named rather than claimed closed: the residual is a peer
  // that wrote `current-session.json` LAST with our semantic label — that peer's
  // raw id is what we read as `predecessorSessionId`, so if it also owns the
  // live lock, conjunct (c) holds for the wrong session. `current-session.json`
  // carries no session field of its own (see
  // `.claude/rules/identity-and-locks.md` § shared repo artefacts), which is
  // exactly why this is a ceiling and not a proof. Revisit when the lock or
  // current-session.json carries a durable logical-session id of its own.
  const isSameLogicalReentry =
    typeof nativeSource === 'string' && SAME_LOGICAL_SESSION_SOURCES.has(nativeSource);

  const shouldForce =
    acquireResult.ok !== true && (
      // #1137: 'stale-heartbeat' replaced the former 'stale-pid-dead' /
      // 'stale-pid-alive' pair. Both legacy spellings are gone from
      // session-lock.mjs; matching only the new one keeps this force-branch
      // reachable.
      acquireResult.reason === 'stale-heartbeat' ||
      (acquireResult.reason === 'active' &&
        acquireResult.existingLock &&
        (acquireResult.existingLock.session_id === sessionId ||
          (isSameLogicalReentry &&
            typeof semanticSessionId === 'string' &&
            semanticSessionId.length > 0 &&
            acquireResult.existingLock.semantic_session_id === semanticSessionId &&
            typeof predecessorSessionId === 'string' &&
            predecessorSessionId.length > 0 &&
            acquireResult.existingLock.session_id === predecessorSessionId)))
    );

  if (!acquireResult.ok && shouldForce) {
    try {
      acquireResult = forceAcquireFn({ sessionId, mode, ttlHours, repoRoot });
    } catch {
      return null;
    }
  }

  // Any other non-ok reason (parallel-conflict, fs-error, other-session-active)
  // → bail without enriching. The hook stays non-blocking.
  //
  // Issue #590 Item 1: before bailing, record a durable conflict signal for the
  // FOREIGN-active case — reason 'active' where the existing lock belongs to a
  // DIFFERENT session than ours (the same-session case was already force-refreshed
  // above via shouldForce). Without this, the operator gets no signal that a
  // parallel session owns the worktree. We persist the foreign session_id into
  // current-session.json for forensics/operator visibility. Best-effort: any FS
  // failure is swallowed and the bail proceeds. The return contract is unchanged —
  // bootstrapLock STILL returns null on this path.
  if (!acquireResult || acquireResult.ok !== true) {
    if (
      acquireResult &&
      acquireResult.reason === 'active' &&
      acquireResult.existingLock &&
      typeof acquireResult.existingLock.session_id === 'string' &&
      acquireResult.existingLock.session_id.length > 0 &&
      acquireResult.existingLock.session_id !== sessionId
    ) {
      recordConflictSignal(repoRoot, acquireResult.existingLock.session_id);
    }
    return null;
  }

  // Step 2: enrich the lock with v2 fields (last_heartbeat + semantic_session_id).
  // We re-read the file fresh (acquire() just wrote it) and overlay the new
  // fields, then atomically tmp+rename. When I3 lands and acquire() writes the
  // v2 shape natively, this overlay becomes idempotent (already-present fields
  // get overwritten with identical values).
  const lockFile = path.join(repoRoot, '.orchestrator', 'session.lock');
  let baseLock;
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    baseLock = JSON.parse(raw);
    if (typeof baseLock !== 'object' || baseLock === null) return null;
  } catch {
    // Lock vanished between write and read — best-effort, return null.
    return null;
  }

  const startedAt = typeof baseLock.started_at === 'string'
    ? baseLock.started_at
    : new Date().toISOString();

  const enriched = {
    ...baseLock,
    // last_heartbeat is the basis for liveness — set to started_at on bootstrap
    // so an immediate liveness check (< ttl_hours from now) succeeds.
    last_heartbeat: startedAt,
    // semantic_session_id is an attribution/history label, normally semantic
    // even when the physical session_id is a UUID-v4. Fall back to mirroring
    // session_id only for backward-compatible display when no label was provided;
    // it never changes the raw ownership key.
    semantic_session_id:
      typeof semanticSessionId === 'string' && semanticSessionId.length > 0
        ? semanticSessionId
        : (typeof baseLock.session_id === 'string' ? baseLock.session_id : sessionId),
  };

  {
    const w = writeJsonAtomicSync(lockFile, enriched, { tmpPrefix: '.session.lock.boot.tmp' });
    if (!w.ok) {
      // Failed to overwrite — base lock is still on disk, so we degrade
      // gracefully. Return null so the caller logs no spurious success.
      return null;
    }
  }

  // Step 2b (#987 Part 1): persist the durable ownership proof at lock
  // genesis. `enriched` is byte-identical to the on-disk lock at this point
  // (the v2 overlay never touches pid/host/started_at), so the proof written
  // here will verify via isLockOwnedByProof() against any later re-read. The
  // proof is supplementary evidence only: it never bridges a raw-id mismatch
  // through semantic_session_id or STATE.md `session` equality.
  // This single call covers BOTH the plain-acquire and the forceAcquire
  // branch — both flow through the enriched write above. Best-effort like
  // the surrounding breadcrumb writes: writeOwnerProof() is no-throw by
  // contract and a failure never bails the bootstrap — but it is no longer
  // SILENT (#987 Part 2 review finding): a failed proof write means this
  // session's /close will degrade to the weaker proof-less release path, so
  // a one-line stderr WARN gives the operator the only signal there is.
  try {
    const { writeOwnerProof } = await import('../../scripts/lib/session-lock.mjs');
    const proofResult = writeOwnerProof({ repoRoot, lock: enriched });
    if (proofResult && !proofResult.ok) {
      process.stderr.write(
        `⚠ lock-bootstrap: owner-proof write failed (${proofResult.reason ?? 'unknown'}) — /close degrades to proof-less release behaviour\n`,
      );
    }
  } catch { /* best-effort — a missing proof never breaks session-start */ }

  // Step 3: best-effort observability breadcrumb. Failures are swallowed
  // so a missing events module never breaks the hook.
  try {
    let emitFn = _emitEventImpl;
    if (!emitFn) {
      const eventsMod = await import('../../scripts/lib/events.mjs');
      emitFn = eventsMod.emitEvent;
    }
    if (typeof emitFn === 'function') {
      await emitFn('orchestrator.session.lock.acquired', {
        session_id: enriched.session_id,
        semantic_session_id: enriched.semantic_session_id,
        mode: enriched.mode,
        pid: enriched.pid,
        host: enriched.host,
        ttl_hours: enriched.ttl_hours,
      });
    }
  } catch { /* observability is best-effort */ }

  return enriched;
}

/**
 * Record a foreign-session conflict signal into current-session.json (Issue #590
 * Item 1). When bootstrapLock detects that a DIFFERENT session already owns the
 * worktree lock, it persists the colliding session_id (plus a forensic timestamp)
 * so the operator and downstream skills have a durable record of the collision —
 * the previous behaviour bailed silently with no signal whatsoever.
 *
 * Uses an atomic read-modify-write (read → merge → tmp+rename) that PRESERVES
 * every existing field (`session_id`, `semantic_session_id`, `pid`, `source`,
 * `timestamp`, and any concurrently-appended `cwd_changes` / `corrective_context`
 * / `last_batch` arrays). It never overwrites the whole file — it overlays only
 * the two conflict fields on top of whatever is currently on disk.
 *
 * Best-effort: any FS error (missing file, parse failure, write race) is swallowed
 * so the SessionStart hook stays non-blocking. The conflict signal is a forensic
 * breadcrumb, not a correctness requirement.
 *
 * Lost-update window (Issue #596, deep-6 R2 MED — ACCEPTED): the read→merge→write
 * is not lock-serialised. recordConflictSignal's only caller is the SessionStart hook
 * (on-session-start.mjs), which runs it early — well before the slow detectPeers phase.
 * That hook is async:true, so strict ordering vs the corrective_context/cwd_changes/
 * last_batch writers (PostToolUse/CwdChanged/PostToolBatch) is not MECHANICALLY
 * guaranteed; but in practice recordConflictSignal completes in a few ms, long before
 * any tool-triggered hook can fire. Crucially, the conflict_* fields have zero readers
 * (forensic-only), so even a lost update is harmless. The real anti-stomp guard is
 * state.lock/PSA-005, not this advisory file.
 *
 * @param {string} repoRoot — absolute path to the repository root.
 * @param {string} foreignSessionId — the session_id of the lock holder we collided with.
 */
function recordConflictSignal(repoRoot, foreignSessionId) {
  try {
    const sessionFile = path.join(repoRoot, '.orchestrator', 'current-session.json');

    // Read-modify-write: start from whatever is on disk (or {} when absent /
    // unparseable) so concurrently-written fields survive the overlay.
    let current = {};
    try {
      const raw = fs.readFileSync(sessionFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed;
      }
    } catch {
      // File absent or unparseable — start from an empty object. The conflict
      // signal is still worth recording even if the session file was not yet written.
    }

    const merged = {
      ...current,
      conflict_with_session_id: foreignSessionId,
      conflict_detected_at: new Date().toISOString(),
    };

    // Best-effort atomic write — return value swallowed intentionally.
    writeJsonAtomicSync(sessionFile, merged, { tmpPrefix: '.current-session.conflict.tmp' });
  } catch {
    // Best-effort — any failure is swallowed; the caller still returns null.
  }
}
