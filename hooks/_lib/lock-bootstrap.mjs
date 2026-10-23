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
 * scripts/lib/session-lock.mjs `buildLock()` has written `last_heartbeat`
 * itself since Epic #583 W2-I3 (`last_heartbeat` = `started_at` at genesis).
 * This helper's tmp+rename overlay therefore re-writes an identical
 * `last_heartbeat`, and its remaining job is `semantic_session_id`, which
 * `acquire()` / `forceAcquire()` are not given here.
 *
 * @module hooks/_lib/lock-bootstrap
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomicSync } from '../../scripts/lib/io.mjs';
import { readNavigatorLease } from '../../scripts/lib/fleet-protocol.mjs';

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
 * Native `source` values on which a fleet lead's lease keeps this session out
 * of the MAIN checkout (#1635). A subset of SAME_LOGICAL_SESSION_SOURCES:
 * `compact` keeps the lock it already holds, `startup` stays untouched. A
 * session that yielded holds none: the yield leaves a #1651 release marker, so
 * its later `compact` stays lockless too (#1747).
 *
 * @type {ReadonlySet<string>}
 */
const LEAD_YIELD_SOURCES = new Set(['clear', 'resume']);

/**
 * Native `source` values on which a lock this same raw session released on
 * purpose stays released (#1651). A subset of SAME_LOGICAL_SESSION_SOURCES:
 * `clear` starts new work and takes a lock as before, `startup` too.
 *
 * @type {ReadonlySet<string>}
 */
const RELEASED_LOCK_STAYS_RELEASED_SOURCES = new Set(['resume', 'compact']);

/**
 * #1651 — true when `sessionId` left a release marker in this repo. Never
 * throws: a missing module or any error reads as "no marker" (the pre-#1651
 * acquire path).
 *
 * @param {string} repoRoot
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
async function hasOwnReleaseMarker(repoRoot, sessionId) {
  try {
    const { hasReleaseMarker } = await import('../../scripts/lib/session-lock.mjs');
    return hasReleaseMarker({ repoRoot, sessionId }) === true;
  } catch {
    return false;
  }
}

/** #1747 — `reason` of a release marker the lead yield writes. */
const LEAD_YIELD_REASON = 'lead-yield';

/**
 * #1747 — the #1651 marker body for `sessionId`, or null. Never throws.
 *
 * @param {string} repoRoot
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
async function readOwnReleaseMarker(repoRoot, sessionId) {
  try {
    const { readReleaseMarker } = await import('../../scripts/lib/session-lock.mjs');
    return readReleaseMarker({ repoRoot, sessionId });
  } catch {
    return null;
  }
}

/**
 * #1747 — a lead yield is a release too: leave the #1651 marker for `sessionId`,
 * tagged `reason: 'lead-yield'`, so a later `compact` or `resume` of this same
 * session stays lockless while the lead's lease is active (compact is no yield
 * source, and without the marker it took the free lock). Once the lease is
 * gone, re-entry acquires and acquire() removes the marker as before. Never
 * throws; a failed write is one stderr WARN and leaves the pre-#1747 behaviour.
 *
 * A marker that is already there and was not written by a yield stays as it is:
 * without `reason` it is an explicit release (release-session-lock.mjs), which
 * keeps its #1651 behaviour after the lease ends. Rewriting it as `lead-yield`
 * made the next compaction after the lease take the lock back (review of !244,
 * M1). An unreadable marker is kept for the same reason: the branch below
 * already reads it as explicit.
 *
 * @param {string} repoRoot
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function writeOwnReleaseMarker(repoRoot, sessionId) {
  if (await hasOwnReleaseMarker(repoRoot, sessionId)) {
    const existing = await readOwnReleaseMarker(repoRoot, sessionId);
    if (existing?.reason !== LEAD_YIELD_REASON) return;
  }
  let reason;
  try {
    const { writeReleaseMarker } = await import('../../scripts/lib/session-lock.mjs');
    const result = writeReleaseMarker({ repoRoot, sessionId, reason: LEAD_YIELD_REASON });
    if (result?.ok !== true) reason = result?.reason ?? 'unknown';
  } catch (err) {
    reason = err?.message ?? 'unknown';
  }
  if (reason !== undefined) {
    process.stderr.write(
      `⚠ lock-bootstrap: no release marker after the lead yield (${reason}) — a compaction may take the lock again\n`,
    );
  }
}

/**
 * #1641 — the Claude Code process id this hook runs under, or null. The value
 * comes from `CLAUDE_PID`, but it counts ONLY when that process is this hook's
 * direct parent: the variable is inherited by everything a Claude session
 * starts, so a Codex child launched from a session's Bash would otherwise carry
 * the parent's pid into its own SessionStart (`hooks-codex.json` matches
 * resume|clear|compact) and take over the parent's LIVE lock (REFUTE review,
 * reproduced against the real acquire/forceAcquire).
 *
 * Measured 2026-10-15 (claude 2.1.300, macOS): a SessionStart hook launched as
 * `sh run-node.sh <hook>` runs node with `process.ppid === CLAUDE_PID` and the
 * parent's comm `claude` — both shells exec. A Codex hook's parent is Codex or
 * its shell, never Claude, so it reads null here. Depth 1, deliberately: a
 * depth-2 walk would admit a hook whose parent is a Codex process that bash
 * exec'd straight under Claude. Spawn-free.
 *
 * #1717: Claude runs each hook as `/bin/sh -c "<command>"`. On Linux/WSL
 * /bin/sh is dash, and the WSL dash 0.5.12 FORKS a single `-c` command
 * instead of exec'ing it, so node's parent was that intermediate sh and this
 * read null on every hook (measured 2026-10-21 on win-wsl, 3/3 runs; with an
 * `exec ` prefix the ppid matched). Every run-node.sh command in
 * `hooks/hooks.json` therefore starts with `exec sh …`; run-node.sh itself
 * execs node on every branch, so both hops are exec and depth 1 holds.
 * The other manifests (hooks-codex/-cursor/-pi.json) deliberately keep the
 * plain form: only a Claude hook can match its own CLAUDE_PID, so the prefix
 * would buy nothing there (their parent is that harness either way).
 * Measured 2026-10-21 on macOS: /bin/sh (bash 3.2) and /bin/dash (dash-16)
 * both match ppid with AND without `exec`, and exit status 2, stderr and stdin
 * pass through unchanged in both forms — the prefix costs nothing there.
 * Ceiling (BV-004): a harness whose launcher is not `/bin/sh -c` (or that
 * wraps the command in a further shell) still reads null and keeps the
 * pre-#1641 behaviour (fail-closed). Revisit if `reclaimed: own-process`
 * never appears on a host where /clear without SessionEnd does.
 *
 * The process survives `/clear` while the raw session id is minted anew, so
 * this is the witness of "the same terminal session" that the label and the
 * raw id cannot give.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [ppid] — this process' parent pid (DI for tests).
 * @returns {number|null}
 */
export function readClaudePid(env = process.env, ppid = process.ppid) {
  const raw = typeof env?.CLAUDE_PID === 'string' ? env.CLAUDE_PID.trim() : '';
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid === ppid ? pid : null;
}

/**
 * #1641 — true when `lock` was written under the Claude Code process this hook
 * runs under, on this host. Only then may a lock with a DIFFERENT raw id count
 * as our own predecessor (startup → /clear mints a new raw id in the same
 * process). #1746 judges the `claude_pid`/`host` pair current-session.json
 * carries with this same predicate, so both witnesses mean the same thing.
 *
 * Why the pid alone is enough, without a start time: both sides come from
 * readClaudePid(), which admits a pid only as the writer hook's DIRECT parent.
 * So the lock's pid names the Claude process that wrote it, and equal to ours
 * it names either this process or a dead one whose pid the OS recycled to us —
 * not another live Claude process in the same pid namespace.
 * The host check keeps a lock on a shared filesystem from another machine out.
 * Ceilings (BV-004), named rather than claimed closed: (1) two pid namespaces
 * that report the same hostname (WSL2 distros, a container and its host on one
 * checkout) can hold equal pids; (2) an in-process agent team whose teammates
 * each ran SessionStart under one Claude process (measured: subagents fire no
 * SessionStart). Revisit when either shape works in a shared checkout.
 *
 * @param {object|null} lock
 * @param {number|null} claudePid — from readClaudePid().
 * @returns {Promise<boolean>}
 */
async function isSameClaudeProcess(lock, claudePid) {
  if (typeof claudePid !== 'number' || !lock || lock.claude_pid !== claudePid) return false;
  try {
    const { hostnamesMatch, lockHostCandidate } = await import('../../scripts/lib/host-identity.mjs');
    return hostnamesMatch(lockHostCandidate(lock), os.hostname());
  } catch {
    return false;
  }
}

/** Re-reads of a just-acquired lock that answers ENOENT, and the pause between them (#1494). */
const ENRICH_READ_RETRIES = 5;
const ENRICH_READ_RETRY_MS = 10;

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
 *   the last session start in this checkout recorded in
 *   `.orchestrator/current-session.json` — our own previous run of this hook
 *   unless a peer started here since (every start rewrites the file, #1746).
 *   It is the third, load-bearing conjunct of the re-entry
 *   force-refresh below: without it a same-host semantic-label collision (#1066)
 *   lets one session take over a live peer's lock. Omitting it (the default)
 *   disables the re-entry force-refresh entirely — fail-closed.
 * @param {{ claude_pid?: unknown, host?: unknown }|null} [opts.predecessorProcess=null]
 *   — the `claude_pid`/`host` pair the writer of that `current-session.json`
 *   recorded (#1746), unvalidated. The #1635 lead yield takes
 *   `predecessorSessionId` for our own predecessor only when this pair names
 *   our own Claude Code process (isSameClaudeProcess); null or any mismatch
 *   yields.
 * @param {number|null} [opts.claudePid=null] — the Claude Code process id from
 *   readClaudePid() (#1641). Stamped on the lock as `claude_pid`; a lock that
 *   carries this same pid on this host is our own predecessor after /clear, for
 *   the re-entry force-refresh AND the #1635 lead-yield release. Null (Codex,
 *   Cursor, tests that omit it) leaves both exactly as before.
 * @param {Function} [opts._acquireImpl] — DI for tests (defaults to importing acquire from session-lock.mjs).
 * @param {Function} [opts._forceAcquireImpl] — DI for tests (defaults to importing forceAcquire from session-lock.mjs).
 * @param {Function} [opts._emitEventImpl] — DI for tests (defaults to importing emitEvent from events.mjs).
 * @param {(context: string, banner: string) => void} [opts.onNotice] — receives
 *   the model notice and the operator banner line when the lock is deliberately
 *   NOT taken because a fleet lead holds the main checkout (#1635), or because
 *   this raw id released its lock on purpose and the source is `resume` /
 *   `compact` (#1651).
 * @param {Function} [opts._readLeaseImpl] — DI for tests (defaults to readNavigatorLease from fleet-protocol.mjs).
 * @param {Function} [opts._releaseImpl] — DI for tests (defaults to release from session-lock.mjs).
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
  predecessorProcess = null,
  claudePid = null,
  _acquireImpl,
  _forceAcquireImpl,
  _emitEventImpl,
  onNotice,
  _readLeaseImpl = readNavigatorLease,
  _releaseImpl,
} = {}) {
  // Sanity-check required inputs. Anything missing → bail silently.
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof mode !== 'string' || mode.length === 0) return null;

  // #1635: after /clear or resume in the MAIN checkout, a lead's active lease
  // means the lead runs headless jobs here — our lock would make its slot check
  // report the repo as occupied. Yield instead of acquiring, and give back a
  // lock this same raw id already holds here.
  const leadHolder = await leadHoldingMainCheckout({
    repoRoot,
    sessionId,
    predecessorSessionId,
    predecessorProcess,
    claudePid,
    nativeSource,
    readLease: _readLeaseImpl,
  });
  if (leadHolder !== null) {
    // Released: a lock with our own raw id (a resume where the harness kept the
    // id), or one written under our own Claude Code process (#1641 — startup →
    // /clear mints a new raw id in the same process). Never a lock whose only
    // "it was us" witness is current-session.json: every session start in this
    // checkout rewrites that file, so a peer's /clear or resume would release a
    // LIVE foreign lock. A predecessor from before #1641 carries no
    // `claude_pid` and still stays until its TTL.
    await releaseOwnLockForLead({ repoRoot, sessionId, claudePid, releaseImpl: _releaseImpl });
    await writeOwnReleaseMarker(repoRoot, sessionId);
    if (typeof onNotice === 'function') {
      // The lease reader admits only [A-Za-z0-9._-] ids, so the id is banner-safe.
      const sid8 = leadHolder.slice(0, 8);
      try {
        onNotice(
          `Haupt-Checkout belegt durch Lead ${sid8}, arbeite im Worktree`,
          `🧭 Haupt-Checkout belegt durch Lead ${sid8} — kein Session-Lock, arbeite im Worktree`,
        );
      } catch { /* the notice is informational */ }
    }
    return null;
  }

  // #1651: this raw session gave its lock back on purpose
  // (scripts/release-session-lock.mjs), typically so a headless run can use
  // the slot. A compaction or resume of that same session is not new work and
  // must not take the lock again; startup and clear acquire as before. The
  // marker is removed by the session's next deliberate acquire().
  // #1747: a marker the lead yield above wrote counts only while a lead lease
  // is still active; once the lead is gone the session acquires again.
  if (
    typeof nativeSource === 'string' &&
    RELEASED_LOCK_STAYS_RELEASED_SOURCES.has(nativeSource) &&
    (await hasOwnReleaseMarker(repoRoot, sessionId))
  ) {
    const marker = await readOwnReleaseMarker(repoRoot, sessionId);
    const yielded = marker?.reason === LEAD_YIELD_REASON;
    const leadId = yielded ? await activeLeadSessionId(_readLeaseImpl) : null;
    if (!yielded || leadId !== null) {
      if (typeof onNotice === 'function') {
        try {
          if (yielded) {
            const sid8 = leadId.slice(0, 8);
            onNotice(
              `Haupt-Checkout belegt durch Lead ${sid8}, arbeite im Worktree`,
              `🧭 Haupt-Checkout belegt durch Lead ${sid8} — kein Session-Lock, arbeite im Worktree`,
            );
          } else {
            onNotice(
              'Session-Lock wurde in dieser Session bewusst freigegeben und nach dem Neueinstieg nicht neu angelegt',
              'ℹ Session-Lock bewusst freigegeben — nach dem Neueinstieg nicht neu angelegt',
            );
          }
        } catch { /* the notice is informational */ }
      }
      return null;
    }
  }

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
  // exactly why this is a ceiling and not a proof.
  //
  // #1641 — (b) never holds after /clear: resolveSessionId() mints the label
  // anew as maxN+1, because the predecessor's own lock is counted (measured
  // 2026-10-15: lock `…-session-1`, new label `…-session-2`). The process-bound
  // alternative replaces (b)+(c) with ONE witness the lock itself carries:
  // `claude_pid` equal to the Claude Code process this hook runs under, on this
  // host (isSameClaudeProcess). It needs no repo-global artefact, so the
  // ceiling above does not apply to it. (a) still gates it.
  const isSameLogicalReentry =
    typeof nativeSource === 'string' && SAME_LOGICAL_SESSION_SOURCES.has(nativeSource);
  const ownProcessPredecessor =
    acquireResult.ok !== true &&
    acquireResult.reason === 'active' &&
    isSameLogicalReentry &&
    acquireResult.existingLock?.session_id !== sessionId &&
    (await isSameClaudeProcess(acquireResult.existingLock, claudePid));

  const shouldForce =
    acquireResult.ok !== true && (
      // #1137: 'stale-heartbeat' replaced the former 'stale-pid-dead' /
      // 'stale-pid-alive' pair. Both legacy spellings are gone from
      // session-lock.mjs; matching only the new one keeps this force-branch
      // reachable.
      acquireResult.reason === 'stale-heartbeat' ||
      // A lock file that is not a lock record (invalid JSON or not the lock
      // shape) can never be a live lock — every writer writes atomically — so
      // it is reclaimed like a stale one, with one stderr WARN below. Before
      // acquire() reported 'corrupt' it answered 'active' / existingLock:null,
      // which this predicate could never force: one damaged file wedged every
      // new session in the repo.
      acquireResult.reason === 'corrupt' ||
      ownProcessPredecessor ||
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

  // Recorded on the acquired event below, so a takeover of a stale or corrupt
  // lock is countable — its stderr WARN is discarded by the harness (#1401).
  let reclaimed = null;
  if (!acquireResult.ok && shouldForce) {
    const reclaimingCorrupt = acquireResult.reason === 'corrupt';
    const forcedFrom = acquireResult.reason;
    // A session resuming its OWN stale lock (same raw id after > ttl idle) is
    // a refresh, not a takeover — counting it would inflate the very figure
    // `reclaimed` exists to make countable.
    const priorOwner = acquireResult.existingLock?.session_id;
    try {
      // A stale or corrupt lock is reclaimed single-winner (#1494): two starts
      // that both saw it used to force it, both got ok:true, and the later
      // rename won. With onlyIfNotLive the loser gets the winner's live lock
      // back as 'active' and bails into the conflict signal below. The same-
      // session refresh of a LIVE lock keeps the unconditional overwrite.
      const reclaim = forcedFrom === 'stale-heartbeat' || forcedFrom === 'corrupt';
      acquireResult = forceAcquireFn({ sessionId, mode, ttlHours, repoRoot, ...(reclaim ? { onlyIfNotLive: true } : {}) });
    } catch {
      return null;
    }
    if (
      acquireResult?.ok === true &&
      (forcedFrom === 'corrupt' || (forcedFrom === 'stale-heartbeat' && priorOwner !== sessionId))
    ) {
      reclaimed = forcedFrom;
    } else if (acquireResult?.ok === true && ownProcessPredecessor) {
      // #1641: countable, so the rate of /clear takeovers can be measured.
      reclaimed = 'own-process';
    }
    if (reclaimingCorrupt) {
      // The file's content is not echoed: it is unbounded and may be anything.
      process.stderr.write(
        acquireResult && acquireResult.ok === true
          ? '⚠ lock-bootstrap: .orchestrator/session.lock was not a valid lock record — reclaimed for this session\n'
          : `⚠ lock-bootstrap: .orchestrator/session.lock is not a valid lock record and could not be reclaimed (${acquireResult?.reason ?? 'unknown'}) — this session runs without a lock\n`,
      );
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
    // #1494 / #599: a lock path that exists but cannot be read (EACCES, or a
    // directory) is never reclaimed — but it is no longer silent either. The
    // WARN is discarded by the harness, so the read_anomaly event (the one
    // SessionEnd already emits for the same state) is the countable trace.
    if (acquireResult && acquireResult.reason === 'unreadable') {
      process.stderr.write(
        `⚠ lock-bootstrap: .orchestrator/session.lock exists but cannot be read (${acquireResult.error ?? 'unknown'}) — this session runs without a lock\n`,
      );
      await emitBestEffort(_emitEventImpl, 'orchestrator.session.lock.read_anomaly', {
        session_id: sessionId,
        status: 'unreadable',
        ...(typeof acquireResult.error === 'string' ? { error: acquireResult.error } : {}),
      });
    }
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
  // fields, then atomically tmp+rename. acquire() already writes
  // last_heartbeat (Epic #583 W2-I3), so that half of the overlay re-writes an
  // identical value; semantic_session_id is the half that adds information.
  const lockFile = path.join(repoRoot, '.orchestrator', 'session.lock');
  let raw;
  // ENOENT right after ok:true is most likely a racer holding OUR fresh lock in
  // its tombstone: a second start that saw the same stale lock renames it
  // aside, finds it live and links it back within microseconds
  // (session-lock.mjs reclaimIfNotLive). Reading once and giving up left the
  // lock ours but without semantic_session_id, owner proof and lock.acquired
  // (#1494 review: two racers are enough). Bounded: 5 retries × 10 ms, so a lock
  // that is really gone costs this hook at most ~50 ms. Measured 2026-10-02
  // (2000 live-restore reclaims, load average ~9): the racer's rename→link-back
  // window was p50 0.34 ms, p99 2.4 ms, max 31.7 ms. Ceiling (BV-004): a window
  // longer than ~50 ms still ends in the lockless-enrichment null above;
  // revisit if lock.acquired goes missing for sessions that own the lock.
  for (let attempt = 0; raw === undefined; attempt += 1) {
    try {
      raw = fs.readFileSync(lockFile, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT' || attempt >= ENRICH_READ_RETRIES) return null;
      await new Promise((resolve) => setTimeout(resolve, ENRICH_READ_RETRY_MS));
    }
  }
  let baseLock;
  try {
    baseLock = JSON.parse(raw);
    if (typeof baseLock !== 'object' || baseLock === null) return null;
  } catch {
    return null;
  }
  // The file can belong to another session by now. The reclaim above is
  // single-winner since #1494 (tombstone rename + link-create in
  // forceAcquire's onlyIfNotLive), but a plain forceAcquire — the same-session
  // refresh, an operator's Phase-1.2 force-take — still overwrites
  // unconditionally, and a link-back that loses to a third writer drops the
  // lock it was restoring (session-lock.mjs reclaimIfNotLive, ceiling 2).
  // Enriching a foreign lock would stamp OUR label onto ITS record and write
  // an owner proof that verifies against it, so it is left as is.
  if (baseLock.session_id !== sessionId) return null;

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
    // #1641: the process-bound witness a later /clear in this same process
    // recognises its predecessor by (isSameClaudeProcess). Absent, not null,
    // when the harness sets no CLAUDE_PID.
    ...(typeof claudePid === 'number' ? { claude_pid: claudePid } : {}),
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

  // Step 3: best-effort observability breadcrumb.
  // #1636 Pkt 2: a live peer that works here while its lock sits in another
  // checkout is invisible to acquire(); record it (true/false/null) so its rate
  // is measured before any conflict banner exists. Absent only if the reader
  // itself cannot be loaded.
  let foreignWorkRoot;
  try {
    const { foreignWorkRootIn } = await import('./hook-root.mjs');
    foreignWorkRoot = foreignWorkRootIn(repoRoot, sessionId);
  } catch { /* the measurement is best-effort */ }
  await emitBestEffort(_emitEventImpl, 'orchestrator.session.lock.acquired', {
    session_id: enriched.session_id,
    semantic_session_id: enriched.semantic_session_id,
    mode: enriched.mode,
    pid: enriched.pid,
    host: enriched.host,
    ttl_hours: enriched.ttl_hours,
    ...(reclaimed ? { reclaimed } : {}),
    ...(foreignWorkRoot !== undefined ? { foreign_work_root: foreignWorkRoot } : {}),
  });

  return enriched;
}

/**
 * #1635 — on a lead yield, release the main checkout's lock IFF it carries our
 * own raw `session_id`, or was written under our own Claude Code process on this
 * host (#1641, isSameClaudeProcess); any other lock is never touched. The delete
 * goes through session-lock.mjs `release()` under the LOCK's raw id with the
 * repo's persisted owner proof, so release() re-checks both the id and the proof
 * itself. Never throws; a failed release is one stderr WARN and changes nothing
 * else — the caller still skips the acquire.
 *
 * @param {{ repoRoot: string, sessionId: string, claudePid?: number|null, releaseImpl?: Function }} args
 * @returns {Promise<void>}
 */
async function releaseOwnLockForLead({ repoRoot, sessionId, claudePid = null, releaseImpl }) {
  let reason = null;
  try {
    const lockMod = await import('../../scripts/lib/session-lock.mjs');
    const existing = lockMod.readLock({ repoRoot });
    if (!existing || typeof existing.session_id !== 'string') return;
    if (existing.session_id !== sessionId && !(await isSameClaudeProcess(existing, claudePid))) return;
    const result = (releaseImpl ?? lockMod.release)({
      sessionId: existing.session_id,
      repoRoot,
      proof: lockMod.loadOwnerProof({ repoRoot }),
    });
    if (!result || result.ok !== true) reason = result?.reason ?? 'unknown';
    else if (result.deleted !== true) reason = result.reason ?? 'not-deleted';
    else if (result.verified === false) reason = 'lock-still-present';
  } catch (err) {
    reason = err?.message ?? 'unknown';
  }
  if (reason !== null) {
    process.stderr.write(
      `⚠ lock-bootstrap: own session.lock could not be released for the fleet lead (${reason}) — it blocks the lead until its TTL\n`,
    );
  }
}

/**
 * #1635 — the session id of a fleet lead whose ACTIVE lease keeps this session
 * out of the main checkout, or null when the lock is taken as before.
 *
 * Non-null only when ALL hold: `nativeSource` is clear/resume; `repoRoot/.git`
 * is a directory (the main worktree — a linked worktree or submodule has a
 * `.git` FILE, no subprocess needed); `repoRoot/.orchestrator/runtime/fleet`
 * is a directory (the lease is HOST-global, this marks the repos the fleet
 * works in); the lease reads `active`; and its `session_id` is neither our
 * raw id nor our predecessor's (the lead's own tab after /clear has a new raw
 * id while the lease still carries the old one — it keeps the old behaviour).
 *
 * #1746 — "our predecessor's" needs a process witness. `predecessorSessionId`
 * comes from current-session.json, which every session start in this checkout
 * rewrites: once the lead started here LAST, its raw id was every other tab's
 * "predecessor", and their /clear took the lock (LSO #778, twice on
 * 2026-10-22). The id counts only when `predecessorProcess` names our own
 * Claude Code process on this host (isSameClaudeProcess, the #1641 witness).
 * Cost, accepted: the lead's own tab now also yields when the entry carries no
 * witness — no readable CLAUDE_PID (Codex, Cursor) or a file written before
 * #1746. Harmless: the lead works through its lease, not this lock. (When
 * another session started in between, the tab yielded before #1746 already:
 * the file then names that session.)
 * Ceiling (BV-004): a dead lead process whose pid the OS recycled to our
 * Claude process still reads as "ours" (the same residual isSameClaudeProcess
 * names) and takes the lock as before #1746.
 *
 * Fail direction: every other outcome — no lease (no fleet: silent), an
 * expired lease, an unreadable one (one stderr WARN), any exception — returns
 * null, i.e. the pre-#1635 acquire path. It never blocks the session.
 *
 * @param {{ repoRoot: string, sessionId: string, predecessorSessionId: string|null, predecessorProcess: object|null, claudePid: number|null, nativeSource: string|null, readLease: Function }} args
 * @returns {Promise<string|null>}
 */
async function leadHoldingMainCheckout({ repoRoot, sessionId, predecessorSessionId, predecessorProcess, claudePid, nativeSource, readLease }) {
  try {
    if (typeof nativeSource !== 'string' || !LEAD_YIELD_SOURCES.has(nativeSource)) return null;
    if (!isDirectory(path.join(repoRoot, '.git'))) return null;
    if (!isDirectory(path.join(repoRoot, '.orchestrator', 'runtime', 'fleet'))) return null;
    const verdict = await readLease();
    if (verdict?.state === 'unreadable') {
      process.stderr.write(
        `⚠ lock-bootstrap: navigator lease unreadable (${verdict.reason ?? 'unknown'}) — lead occupancy not measurable, taking the lock as before\n`,
      );
      return null;
    }
    if (verdict?.state !== 'active') return null;
    const leadId = verdict.lease?.session_id;
    if (typeof leadId !== 'string' || leadId.length === 0) return null;
    if (leadId === sessionId) return null;
    if (leadId === predecessorSessionId && (await isSameClaudeProcess(predecessorProcess, claudePid))) return null;
    return leadId;
  } catch {
    return null;
  }
}

/**
 * #1747 — the session id of an ACTIVE fleet-lead lease, or null for every
 * other outcome (none, expired, unreadable, a throwing reader). The marker
 * was written only in the main checkout under a foreign lead, so the lease
 * alone decides here. Never throws.
 *
 * @param {Function} readLease
 * @returns {Promise<string|null>}
 */
async function activeLeadSessionId(readLease) {
  try {
    const verdict = await readLease();
    const leadId = verdict?.state === 'active' ? verdict.lease?.session_id : null;
    return typeof leadId === 'string' && leadId.length > 0 ? leadId : null;
  } catch {
    return null;
  }
}

/** True when `p` is a directory itself (lstat: a symlink does not count). Never throws. */
function isDirectory(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Emit one event; every failure is swallowed so a missing events module never
 * breaks the hook (observability is best-effort).
 *
 * @param {Function|undefined} emitImpl — the `_emitEventImpl` test seam.
 * @param {string} name
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function emitBestEffort(emitImpl, name, payload) {
  try {
    let emitFn = emitImpl;
    if (!emitFn) {
      const eventsMod = await import('../../scripts/lib/events.mjs');
      emitFn = eventsMod.emitEvent;
    }
    if (typeof emitFn === 'function') await emitFn(name, payload);
  } catch { /* observability is best-effort */ }
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
