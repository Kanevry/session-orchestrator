/**
 * peer-discovery.mjs — Issue #592 MED-1 (3-surface peer-discovery unifier).
 *
 * Unions all THREE peer-discovery surfaces into one provenance-tagged flat
 * list, fail-open per surface:
 *
 *   - Surface A+B (lock + registry) — `discoverActiveSessions(repoRoot, opts)`
 *     from session-discovery.mjs. Already merges per-worktree session.lock
 *     reads with the host-wide session registry, deduped by sessionId. Async,
 *     fails open internally (single-worktree fallback + swallowed registry
 *     errors). Returns entries shaped
 *     `{ worktreePath, sessionId, mode, startedAt, pid, host, branch }`.
 *
 *   - Surface C (STATE.md) — `checkPeerStateMd(repoRoot, mySessionId, opts)`
 *     from state-md-peer-guard.mjs. Synchronous, never throws (fail-open).
 *     This is the surface that is CURRENTLY OUTSIDE the discoverActiveSessions
 *     union — the genuine gap MED-1 closes. Returns
 *     `{ peer: { sessionId, startedAt, currentWave, mode, ageHours } | null, reason }`.
 *
 * Design (decided by coordinator — provenance-tagged flat list, shape (a)):
 *
 *   Each output entry carries a `source` of 'discovered' | 'state-md' plus a
 *   sessionId. Callers inspect `source` to reason about which surface
 *   independently flagged a peer (defense-in-depth).
 *
 *   Provenance for discoverActiveSessions entries — that function ALREADY
 *   dedupes lock + registry into one irreversible shape (identical 7-field
 *   shapes, flattened). The lock vs registry distinction is NOT recoverable
 *   from the return value, so all entries from this surface are tagged
 *   'discovered' unconditionally. The tag is advisory provenance, not a
 *   security boundary.
 *
 *   Cross-source dedup is INTENTIONALLY NOT performed: if the STATE.md peer's
 *   sessionId already appears in the discoverActiveSessions results, it is
 *   STILL emitted as a separate `source: 'state-md'` entry. The whole point of
 *   MED-1 is to show that STATE.md *independently* flags the peer — collapsing
 *   it would erase the defense-in-depth signal.
 *
 * Error semantics (load-bearing): findPeers NEVER throws. Each surface fails
 * open independently:
 *   - discoverActiveSessions rejects/throws  → contribute empty discovered list.
 *   - checkPeerStateMd throws (it shouldn't)  → contribute no state-md entry.
 *   - Worst case returns `{ peers: [] }`.
 *
 * ---------------------------------------------------------------------------
 * Second export: checkLiveForeignSession (Issue #908)
 * ---------------------------------------------------------------------------
 *
 * findPeers is the raw union — powerful, but every consumer so far had to
 * re-derive the same three non-obvious rules to turn it into the one question
 * that is actually asked ("is a live FOREIGN session running in <repo>?"):
 * which id-space self-excludes on which surface, which liveness signal is
 * canonical, and which `source` values may be counted. Getting any of the
 * three wrong is silent — you get a plausible boolean that is simply false.
 * checkLiveForeignSession answers the question once, so no caller has to.
 * See its own JSDoc for the decision record.
 *
 * @module peer-discovery
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { discoverActiveSessions } from './session-discovery.mjs';
import { readLock, isLockLive, LOCK_PATH } from './session-lock.mjs';
import { checkPeerStateMd } from './state-md-peer-guard.mjs';
import { listWorktreesChecked } from './worktree/listing.mjs';

/** Closed enum of provenance sources. */
const SOURCE_DISCOVERED = 'discovered'; // lock + registry unified (irreversibly merged upstream)
const SOURCE_STATE_MD = 'state-md';

/**
 * Compute age in decimal hours from an ISO-8601 `startedAt` string to a `now`
 * reference (ms-since-epoch). Returns undefined when the input is unparseable
 * so callers can omit the field rather than emit a misleading number.
 *
 * DIVERGENCE NOTE: `_ageHoursFromStartedAt` in state-md-peer-guard.mjs returns
 * Infinity on unparseable input (fail-safe: treat malformed date as "very old"
 * → allow overwrite). This function returns undefined instead, so the caller
 * can omit the ageHours field entirely rather than emitting a misleading number.
 * The divergence is intentional: peer-discovery treats unparseable as
 * "unknown/omit"; peer-guard treats it as "infinitely old/definitely-stale →
 * fail-safe". Do NOT merge or unify these helpers.
 *
 * @param {string|null|undefined} startedAt
 * @param {number} nowMs
 * @returns {number|undefined}
 */
function _ageHoursFrom(startedAt, nowMs) {
  if (typeof startedAt !== 'string' || startedAt.trim() === '') return undefined;
  const ms = nowMs - new Date(startedAt).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return ms / (1000 * 60 * 60);
}

/**
 * Map one discoverActiveSessions entry into a provenance-tagged peer.
 *
 * @param {{worktreePath:string,sessionId:string,mode:string,startedAt:string,pid:number,host:string,branch:string}} s
 * @param {number} nowMs
 * @returns {object}
 */
function _peerFromDiscovered(s, nowMs) {
  // Lock + registry are irreversibly merged by discoverActiveSessions — tag all
  // entries 'discovered' unconditionally (see module header provenance note).
  const source = SOURCE_DISCOVERED;
  const ageHours = _ageHoursFrom(s.startedAt, nowMs);
  const peer = {
    source,
    sessionId: s.sessionId,
    mode: s.mode ?? null,
    host: s.host,
    pid: s.pid,
    worktreePath: s.worktreePath,
  };
  if (ageHours !== undefined) peer.ageHours = ageHours;
  return peer;
}

/**
 * findPeers — union of all 3 peer-discovery surfaces, fail-open per surface.
 *
 * @param {string} repoRoot  Absolute path to the repository root.
 * @param {object} [opts] passthrough seams shared with the underlying surfaces.
 * @param {string|null} [opts.mySessionId]      Current session id, used for
 *   self-exclusion on BOTH surfaces — but the two surfaces read different
 *   id-spaces. Surface A+B (discoverActiveSessions) compares against
 *   `session_id` from session.lock / the host registry, which is ALWAYS the
 *   UUID (never `semantic_session_id` — see session-lock.mjs). Surface C
 *   (checkPeerStateMd) compares against STATE.md's `session:` frontmatter
 *   field, which callers may populate with either id-space as long as it is
 *   the SAME id-space `mySessionId` was derived from (see the PRECONDITION
 *   note in state-md-peer-guard.mjs). Passing a semantic id here self-excludes
 *   correctly on Surface C but NOT on Surface A+B (the UUID lock/registry
 *   entry for the same session will still surface as a 'discovered' peer of
 *   itself) — callers that need both surfaces to self-exclude MUST pass the
 *   UUID.
 * @param {number}      [opts.now]              ms-since-epoch (test seam for freshness/age).
 * @param {number}      [opts.freshnessMin]     Registry-entry freshness threshold (minutes).
 * @param {number}      [opts.maxAgeHours]      STATE.md abandonment threshold (hours).
 * @param {Function}    [opts.listWorktreesImpl] DI seam for discoverActiveSessions.
 * @param {Function}    [opts.registryReader]    DI seam for discoverActiveSessions.
 * @returns {Promise<{ peers: Array<object> }>} Each peer carries `source` +
 *   `sessionId` + (when parseable) `ageHours`. The remaining fields are
 *   per-source — only the fields the originating surface can supply are emitted
 *   (no field is advertised that the implementation does not set):
 *     - source 'discovered' (from discoverActiveSessions — lock + registry unified):
 *         { source, sessionId, mode|null, host, pid, worktreePath, ageHours? }
 *     - source 'state-md' (from checkPeerStateMd):
 *         { source, sessionId, mode|null, currentWave, reason, ageHours? }
 */
export async function findPeers(repoRoot, opts = {}) {
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const mySessionId = opts.mySessionId ?? null;

  const peers = [];

  // ------------------------------------------------------------------
  // Surface A+B — lock + registry (already unioned by discoverActiveSessions).
  // Fail open: a throw/reject contributes nothing.
  // ------------------------------------------------------------------
  try {
    const discovered = await discoverActiveSessions(repoRoot, {
      now: nowMs,
      freshnessMin: opts.freshnessMin,
      maxAgeHours: opts.maxAgeHours,
      listWorktreesImpl: opts.listWorktreesImpl,
      registryReader: opts.registryReader,
    });
    if (Array.isArray(discovered)) {
      for (const s of discovered) {
        // Self-exclusion (#798): discoverActiveSessions has no notion of "my
        // session" — it returns every live lock/registry entry, including the
        // caller's own SessionStart-hook heartbeat. Exclude it here so it
        // never surfaces as a source:'discovered' peer of itself. Mirrors the
        // same guard in session-registry.mjs detectPeers() and
        // hooks/on-session-start.mjs. `mySessionId === null` needs no special
        // case: `!==` against a string sessionId is always true when
        // mySessionId is null, so a foreign entry is never filtered.
        if (s && typeof s.sessionId === 'string' && s.sessionId !== mySessionId) {
          peers.push(_peerFromDiscovered(s, nowMs));
        }
      }
    }
  } catch {
    // discoverActiveSessions is internally fail-open, but we defend against an
    // unexpected reject (e.g. a throwing DI seam) so findPeers never rejects.
  }

  // ------------------------------------------------------------------
  // Surface C — STATE.md peer-guard. Synchronous + contractually never throws,
  // but we wrap defensively so a future regression cannot break the union.
  // Emitted as a SEPARATE 'state-md' entry even if the sessionId already
  // appears above (intentional non-dedup-across-sources — provenance matters).
  // ------------------------------------------------------------------
  try {
    const { peer, reason } = checkPeerStateMd(repoRoot, mySessionId, {
      maxAgeHours: opts.maxAgeHours,
    });
    if (peer && typeof peer.sessionId === 'string') {
      const entry = {
        source: SOURCE_STATE_MD,
        sessionId: peer.sessionId,
        mode: peer.mode ?? null,
        currentWave: peer.currentWave,
        reason,
      };
      if (typeof peer.ageHours === 'number') entry.ageHours = peer.ageHours;
      peers.push(entry);
    }
  } catch {
    // Defensive — checkPeerStateMd is documented never-throws. Contribute no
    // state-md entry on the off chance it regresses.
  }

  return { peers };
}

// ===========================================================================
// checkLiveForeignSession (Issue #908) — "is a live FOREIGN session running
// in this repo?" as a single mechanical verdict.
// ===========================================================================

/** Verdict `probe` values — which measurement actually ran. */
const PROBE_NONE = 'none';       // pre-check refused to measure (fail-safe verdict)
const PROBE_LOCK_ONLY = 'lock-only'; // cheap path: one sync lock read, no git
const PROBE_FULL = 'full';       // full path: findPeers (worktrees + registry + STATE.md)
const PROBE_FULL_DEGRADED = 'full-degraded'; // full path ran but returned demonstrably incomplete data

/**
 * Resolve a path to its canonical form, falling back to the merely-resolved
 * form when the path does not exist (realpathSync throws on ENOENT). Never
 * throws — a non-canonical comparison is still a useful comparison.
 *
 * @param {string} p
 * @returns {string}
 */
function _realpathOrResolved(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Nearest ancestor of `dirAbs` (inclusive) that holds a `.git` entry — i.e. the
 * working-copy root `dirAbs` belongs to. `null` when `dirAbs` is not inside any
 * working copy.
 *
 * DELIBERATELY NOT `git rev-parse --show-toplevel`. This runs on the probe-
 * SELECTION path, whose whole justification is that the `'lock-only'` branch
 * touches no git process; a spawn here would re-introduce exactly the cost the
 * two-probe split exists to avoid, and it would pay it on EVERY call — including
 * the calls that then take the cheap branch. The cases `rev-parse` would decide
 * differently are `GIT_DIR`/`GIT_WORK_TREE` env overrides and `core.worktree`
 * indirection; no call site in this repo produces them, and when they do occur
 * the disagreement costs at most a probe-variant choice, never a wrong verdict
 * direction (the `'lock-only'` branch reads the target's OWN lock either way).
 *
 * `.git` is a directory in a normal checkout and a FILE in a linked worktree.
 * `existsSync` accepts both, which is what we want: a linked worktree's root IS
 * its own working copy (see the sibling-worktree note on `_isOwnWorkingCopy`).
 *
 * @param {string} dirAbs
 * @returns {string|null}
 */
function _workingCopyRootOf(dirAbs) {
  // Bounded by path depth; one stat syscall per level.
  let cur = dirAbs;
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null; // reached the filesystem root
    cur = parent;
  }
}

/**
 * True when `cwdAbs` and `repoRootAbs` denote the SAME working copy.
 *
 * Containment alone is NOT the test. The full probe enumerates peers through
 * `findPeers` → `discoverActiveSessions` → `listWorktrees`, and `listWorktrees`
 * runs `git worktree list` in `process.cwd()` (worktree/listing.mjs) — it can
 * only ever measure the working copy the PROCESS sits in. Selecting it for a
 * repo that merely CONTAINS (or is contained by) the cwd measures a different
 * repository and then reports THAT repository's emptiness as the target's
 * verdict — a successful measurement of the wrong thing, which the fail-safe
 * direction cannot catch because nothing failed.
 *
 * Concretely reachable: a portfolio workspace directory (`<home>/Projects/
 * <workspace>/`) is commonly a git repo with its own `.orchestrator/` state AND
 * an ancestor of every product repo checked out beneath it. Under pure
 * containment a probe of that parent from a child repo took the full path and
 * answered `live: false` from the CHILD's worktree list.
 *
 * So: same directory ⇒ same working copy (no identity question to ask);
 * otherwise containment is necessary but must be confirmed by IDENTITY — the
 * working-copy root the cwd belongs to has to BE `repoRootAbs`.
 *
 * A SIBLING worktree (`<base>/<repo>-<sessionId>/`) is deliberately NOT "the
 * same working copy": it is a different checkout with its own lock, so a probe
 * against it is a foreign-repo probe.
 *
 * @param {string} repoRootAbs
 * @param {string} cwdAbs
 * @returns {boolean}
 */
function _isOwnWorkingCopy(repoRootAbs, cwdAbs) {
  if (repoRootAbs === cwdAbs) return true;

  const contained = cwdAbs.startsWith(repoRootAbs + path.sep)
    || repoRootAbs.startsWith(cwdAbs + path.sep);
  if (!contained) return false;

  const cwdRoot = _workingCopyRootOf(cwdAbs);
  if (cwdRoot === null) return false; // cwd is in no working copy → nothing to own
  return _realpathOrResolved(cwdRoot) === repoRootAbs;
}

/**
 * Normalise a raw schema-v2 lock body into the verdict's `peer` shape.
 *
 * @param {object} lock          Parsed lock body.
 * @param {string} worktreePath  Absolute path the lock was read from.
 * @param {number} nowMs
 * @returns {object}
 */
function _peerFromLockBody(lock, worktreePath, nowMs) {
  const ageHours = _ageHoursFrom(lock.started_at, nowMs);
  return {
    source: SOURCE_DISCOVERED,
    sessionId: typeof lock.session_id === 'string' ? lock.session_id : null,
    semanticSessionId: typeof lock.semantic_session_id === 'string' ? lock.semantic_session_id : null,
    mode: lock.mode ?? null,
    host: lock.host ?? null,
    pid: typeof lock.pid === 'number' ? lock.pid : null,
    startedAt: typeof lock.started_at === 'string' ? lock.started_at : null,
    lastHeartbeat: typeof lock.last_heartbeat === 'string' ? lock.last_heartbeat : null,
    ageHours: ageHours === undefined ? null : ageHours,
    worktreePath,
  };
}

/**
 * Normalise a findPeers `source: 'discovered'` entry into the verdict's `peer`
 * shape. Fields that surface cannot supply are emitted as null rather than
 * omitted, so consumers never have to branch on shape.
 *
 * @param {object} p
 * @returns {object}
 */
function _peerFromFindPeersEntry(p) {
  return {
    source: SOURCE_DISCOVERED,
    sessionId: p.sessionId,
    semanticSessionId: null,
    mode: p.mode ?? null,
    host: p.host ?? null,
    pid: typeof p.pid === 'number' ? p.pid : null,
    startedAt: null,          // discoverActiveSessions does not thread startedAt through findPeers
    lastHeartbeat: null,
    ageHours: typeof p.ageHours === 'number' ? p.ageHours : null,
    worktreePath: p.worktreePath ?? null,
  };
}

/**
 * Build a verdict object. Central so every return path emits the same shape.
 *
 * @param {boolean} live
 * @param {string} reason
 * @param {string} probe
 * @param {{peerCount?: number, peer?: object|null}} [extra]
 * @returns {{live: boolean, reason: string, probe: string, peerCount: number, peer: object|null}}
 */
function _verdict(live, reason, probe, extra = {}) {
  return {
    live,
    reason,
    probe,
    peerCount: extra.peerCount ?? 0,
    peer: extra.peer ?? null,
  };
}

/**
 * Timeout for the #919.3 git-surface confirmation probe. Mirrors
 * session-discovery's DEFAULT_DISCOVERY_TIMEOUT_MS: a hung git must degrade
 * the verdict (fail-safe), never hang it.
 */
const WORKTREE_CONFIRM_TIMEOUT_MS = 2000;

/**
 * #919.3 — confirm that `git worktree list` can actually RUN in this process's
 * working copy. Called ONLY on the full path's residual branch (discovered
 * surface produced nothing AND no live own lock exists to canary against —
 * see the RESIDUAL GAP note on `checkLiveForeignSession`).
 *
 * Honours the same DI seam findPeers forwards (`opts.listWorktreesImpl`): a
 * seam that RESOLVES (any value) proves the surface functional; a seam that
 * throws/rejects reproduces the git failure. Without a seam,
 * `listWorktreesChecked()` supplies the real signal (`ok: false` = git did not
 * run — the exact state the bare `listWorktrees()` swallows into `[]`).
 *
 * Raced against a 2s timeout: a hung git resolves to `false` (not confirmed ⇒
 * fail safe). Never throws; never rejects.
 *
 * @param {object} opts  The `checkLiveForeignSession` opts (for the DI seam).
 * @returns {Promise<boolean>}  true ⇔ `git worktree list` demonstrably ran.
 */
async function _confirmWorktreeListRan(opts) {
  let timer;
  try {
    const probe = typeof opts.listWorktreesImpl === 'function'
      ? Promise.resolve().then(() => opts.listWorktreesImpl()).then(() => true, () => false)
      : listWorktreesChecked().then((r) => r?.ok === true, () => false);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), WORKTREE_CONFIRM_TIMEOUT_MS);
      if (typeof timer?.unref === 'function') timer.unref();
    });
    return (await Promise.race([probe, timeout])) === true;
  } catch {
    return false; // unmeasurable ⇒ not confirmed ⇒ the caller fails safe
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * checkLiveForeignSession — mechanically decide whether a LIVE FOREIGN session
 * is running in `repoRoot` (Issue #908, Baustein 3).
 *
 * Consumer contract: when this returns `live: true`, every fact harvested from
 * that repo is volatile BY DEFINITION — regardless of how recently it was
 * measured — because someone else may be committing into it right now. The
 * staleness-annotation consumer reads this as "threshold 0: state facts from
 * this repo as ASSERTED, not as established".
 *
 * ── Two probes, auto-selected (no knob the caller can set wrong) ────────────
 *
 * The right measurement depends on WHOSE working copy `repoRoot` is, and that
 * is derivable — so it is derived here rather than delegated to a parameter:
 *
 *   - `repoRoot` is MY working copy (same directory, or a containment relation
 *     CONFIRMED BY REPO IDENTITY — see `_isOwnWorkingCopy`): probe `'full'`.
 *     Sibling worktrees and host-registry entries are real peers here, so the
 *     full findPeers union runs — and self-exclusion becomes load-bearing (see
 *     below). Containment alone is explicitly NOT sufficient: `listWorktrees`
 *     runs `git worktree list` in `process.cwd()`, so the full probe can only
 *     measure the working copy this PROCESS is in; picking it for an ancestor
 *     or descendant directory that is a DIFFERENT repository measures the wrong
 *     repo and returns its emptiness as the target's verdict.
 *
 *   - `repoRoot` is a FOREIGN repo (the actual #908 case): probe `'lock-only'`.
 *     Two synchronous calls — `readLock` + `isLockLive` — with no `git worktree
 *     list`, no 2s race, no registry read. Self-exclusion is trivially
 *     satisfied (my session is not in that repo's lock). This mirrors
 *     `scripts/lib/dispatcher/enumerate.mjs :: resolveCandidate`, which makes
 *     exactly this trade for exactly this reason.
 *
 * There is deliberately NO probe override: an API in which the caller can pick
 * the wrong variant is an API in which the caller eventually will (this failure
 * mode was observed live — see the id-space note below). `opts.cwd` exists as a
 * test seam for the auto-detection input, not as a way to force a probe.
 *
 * KNOWN LIMIT (accepted, cost-driven): the `'lock-only'` probe reads only that
 * repo root's own lock. A foreign session running exclusively in a SIBLING
 * worktree of a foreign repo is not seen. Callers who need that coverage must
 * call `findPeers(<that repo>)` directly and pay the git cost.
 *
 * ── Self-exclusion is derived, never trusted (Falle 1) ──────────────────────
 *
 * `findPeers`'s `opts.mySessionId` self-excludes on Surface A+B ONLY when it is
 * the UUID from `session.lock` — a semantic id (`<branch>-<date>-<mode>-<n>`)
 * silently fails to exclude there, and the caller's own heartbeat comes back as
 * a "peer" of itself. That mistake was made live by a caller reading the very
 * JSDoc that documents it. So this function does not accept the id it needs:
 * it READS it, from `readLock({ repoRoot }).session_id` (the UUID) plus
 * `.semantic_session_id`, and post-filters BOTH id-spaces out of the result —
 * which also covers the id-space mismatch on Surface C (STATE.md `session:`)
 * and any registry entry a non-Claude harness wrote under a semantic id.
 * `opts.mySessionId` is accepted and IGNORED (see its param doc).
 *
 * ── Liveness is heartbeat-based, never PID-based (Falle 2) ──────────────────
 *
 * The canonical test is `isLockLive(lock, nowMs)` (heartbeat vs `ttl_hours`,
 * falling back to `started_at`). `process.kill(pid, 0)` / `isPidAliveOnHost`
 * are deliberately NOT in this decision tree: the recorded pid is the ephemeral
 * SessionStart-HOOK pid, not the session's, so a dead pid says nothing about
 * the session. A lock with a FRESH heartbeat and a DEAD pid therefore counts as
 * LIVE — that is the contract, not a bug (session-discovery.mjs module header;
 * #799 evaluated 2026-07-17 → explicit NO-GO, "do not re-attempt without new
 * evidence"). `tests/lib/peer-discovery.test.mjs` I3 pins it.
 *
 * ── Only `source: 'discovered'` counts (Falle 3) ────────────────────────────
 *
 * `findPeers` intentionally does NOT dedupe across sources, so one peer can
 * appear twice (once `'discovered'`, once `'state-md'`) — a raw `peers.length`
 * is double-counting AND over-triggering. Only `'discovered'` (live lock /
 * fresh registry heartbeat) is evidence of a RUNNING session; `'state-md'` is a
 * committed artifact that outlives its session (a crashed session leaves it
 * behind), so it is excluded from the liveness decision. Same filter as
 * `skills/_shared/parallel-aware-preamble.md` (`p.source !== 'state-md'`).
 * Within `'discovered'`, `discoverActiveSessions` has already deduped by
 * sessionId, so `peerCount` needs no further dedupe.
 *
 * ── Fail-safe direction: UNKNOWN ⇒ live: true ───────────────────────────────
 *
 * The two errors are not symmetric. A false `true` costs one redundant
 * re-measurement. A false `false` reprints 9-hour-old numbers as current fact —
 * the exact #908 incident. So the invariant is: **`live: false` is returned
 * ONLY after a measurement that succeeded and found nothing.** Anything that
 * prevents measurement — unusable `repoRoot` (`'invalid-repo-root'`), path gone
 * (`'repo-root-missing'`), lock present but unparseable (`'lock-unreadable'`),
 * or any unexpected throw (`'probe-error'`) — yields `live: true`.
 * A repo with NO lock is not "unknown": it is a successful measurement with a
 * negative result (`'no-lock'`, `live: false`).
 *
 * ── The full path needs its own liveness proof (Falle 4) ────────────────────
 *
 * `findPeers` fails open PER SURFACE and returns only `{ peers }` — there is no
 * degraded/error channel — so "both surfaces broke" and "measured, nobody home"
 * arrive as the same value. Left alone, the full path would answer `no-peers` →
 * `live: false` after measuring nothing, i.e. exactly the invariant above
 * inverted on the branch that runs most often.
 *
 * Decision (#908 F3): do NOT plumb a degraded flag through findPeers. The
 * fail-open behaviour that hides the failure lives one and two layers further
 * down (`discoverActiveSessions` catches and falls back; `listWorktrees`
 * returns `[]` on git failure), so a flag on findPeers would only ever report
 * failures injected through a test seam — green tests, zero production effect.
 * Instead the verdict is validated against a signal this function already
 * holds: **when our own lock is live, the discovered surface MUST have returned
 * our own entry.** `discoverActiveSessions` reads this worktree's lock either
 * via `git worktree list` or, when that throws/times out, via its A1
 * single-worktree fallback. Zero discovered entries under a live own lock is
 * therefore not a quiet repo — it is a surface that produced nothing at all →
 * `live: true`, `reason: 'probe-degraded'`, `probe: 'full-degraded'`. The
 * distinct probe value names the difference rather than hiding it inside
 * `'full'`. This is also why `findPeers` is called with `mySessionId: null`:
 * self-exclusion is done by the post-filter (which covers both id-spaces
 * anyway), and excluding our own entry upstream would erase the canary.
 *
 * RESIDUAL GAP — CLOSED (#919.3): the canary needs a live own lock to assert
 * against. When `repoRoot` is my own working copy and NO live lock exists
 * there, a total surface failure used to be indistinguishable from a quiet
 * repo and yielded `live: false`. The liveness contract that closing it
 * required now exists: `listWorktreesChecked()` (worktree/listing.mjs) reports
 * whether `git worktree list` actually RAN (`ok: false` = the git invocation
 * failed — previously swallowed into `[]`). So when the discovered surface
 * produced NOTHING and no live own lock can vouch for it, the full path runs
 * that check directly (raced against a 2s timeout, mirroring
 * session-discovery's own race): git demonstrably ran → `no-peers` stands as a
 * genuine measurement; git failed or hung → `live: true`,
 * `reason: 'probe-degraded'`, `probe: 'full-degraded'` — the same fail-safe
 * direction as every other unmeasurable state. Tests reach this confirmation
 * through the SAME `opts.listWorktreesImpl` seam findPeers forwards: a seam
 * that resolves proves the surface functional, a throwing/rejecting seam
 * reproduces the git failure.
 *
 * NEVER THROWS — like every other function in this module. All paths return a
 * verdict; the outermost catch maps the impossible case to `'probe-error'`.
 *
 * @param {string} repoRoot Absolute path to the repository root to probe.
 * @param {object} [opts]
 * @param {string} [opts.mySessionId] ACCEPTED AND IGNORED. Kept so the many
 *   existing `{ mySessionId }` call sites can be pointed at this function
 *   verbatim, and so passing the WRONG id-space (the observed live failure) is
 *   inert instead of silently wrong. Self-exclusion is derived from the lock —
 *   an id supplied by the caller is unverifiable, and trusting it could only
 *   ever REMOVE peers, i.e. push the verdict to the unsafe side.
 * @param {string} [opts.cwd] Test seam for the own-vs-foreign auto-detection
 *   (defaults to `process.cwd()`). Not a probe override.
 * @param {number} [opts.now] ms-since-epoch (test seam for heartbeat/age).
 * @param {number} [opts.freshnessMin] Forwarded to findPeers (full probe only).
 * @param {number} [opts.maxAgeHours] Forwarded to findPeers (full probe only).
 * @param {Function} [opts.listWorktreesImpl] DI seam, forwarded to findPeers.
 * @param {Function} [opts.registryReader] DI seam, forwarded to findPeers.
 * @param {Function} [opts.findPeersImpl] DI seam replacing findPeers (tests).
 * @returns {Promise<{
 *   live: boolean,
 *   reason: 'live-peer-lock'|'live-peer-discovered'|'no-lock'|'lock-expired'|'no-peers'
 *          |'invalid-repo-root'|'repo-root-missing'|'lock-unreadable'|'probe-degraded'
 *          |'probe-error',
 *   probe: 'none'|'lock-only'|'full'|'full-degraded',
 *   peerCount: number,
 *   peer: object|null
 * }>} `peer` is a representative live peer (the first) or null; `peerCount`
 *   carries the total, so a consumer can phrase "live foreign session, 2h old"
 *   without measuring a second time.
 */
export async function checkLiveForeignSession(repoRoot, opts = {}) {
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();

  try {
    // -- Pre-checks: anything that prevents measurement fails SAFE (live:true).
    if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
      return _verdict(true, 'invalid-repo-root', PROBE_NONE);
    }

    const rootAbs = _realpathOrResolved(repoRoot);
    if (!fs.existsSync(rootAbs)) {
      return _verdict(true, 'repo-root-missing', PROBE_NONE);
    }

    // readLock() collapses "absent" and "unparseable" into null. They are
    // opposite verdicts here (nobody-home vs cannot-tell), so split them: a
    // lock file that exists but does not parse means SOMETHING wrote it and we
    // cannot say whether that session is alive → fail safe.
    const lock = readLock({ repoRoot: rootAbs });
    if (lock === null && fs.existsSync(path.join(rootAbs, LOCK_PATH))) {
      return _verdict(true, 'lock-unreadable', PROBE_NONE);
    }

    const cwdAbs = _realpathOrResolved(
      typeof opts.cwd === 'string' && opts.cwd.trim() !== '' ? opts.cwd : process.cwd(),
    );

    // ------------------------------------------------------------------
    // Cheap probe — foreign repo. Two sync calls, no git, no registry.
    // ------------------------------------------------------------------
    if (!_isOwnWorkingCopy(rootAbs, cwdAbs)) {
      if (lock === null) {
        return _verdict(false, 'no-lock', PROBE_LOCK_ONLY);
      }
      if (!isLockLive(lock, nowMs)) {
        // Heartbeat older than ttl_hours — dead lease, not a live session.
        return _verdict(false, 'lock-expired', PROBE_LOCK_ONLY);
      }
      // Fresh heartbeat ⇒ live, whatever the recorded pid says (#799).
      return _verdict(true, 'live-peer-lock', PROBE_LOCK_ONLY, {
        peerCount: 1,
        peer: _peerFromLockBody(lock, rootAbs, nowMs),
      });
    }

    // ------------------------------------------------------------------
    // Full probe — my own working copy: sibling worktrees + registry count.
    // ------------------------------------------------------------------

    // Self-ids are READ, never accepted from the caller (see JSDoc, Falle 1).
    // `mySessionId: null` is passed DELIBERATELY: self-exclusion happens
    // entirely in the post-filter below (it covers both id-spaces, which
    // findPeers's single-id seam cannot), and suppressing our own entry INSIDE
    // findPeers would also destroy the canary — our own entry is the only
    // production-observable proof that the discovered surface functioned.
    const selfIds = new Set();
    if (lock && typeof lock.session_id === 'string') selfIds.add(lock.session_id);
    if (lock && typeof lock.semantic_session_id === 'string' && lock.semantic_session_id !== '') {
      selfIds.add(lock.semantic_session_id);
    }

    const findPeersFn = typeof opts.findPeersImpl === 'function' ? opts.findPeersImpl : findPeers;
    const result = await findPeersFn(rootAbs, {
      mySessionId: null,
      now: nowMs,
      freshnessMin: opts.freshnessMin,
      maxAgeHours: opts.maxAgeHours,
      listWorktreesImpl: opts.listWorktreesImpl,
      registryReader: opts.registryReader,
    });

    const allPeers = Array.isArray(result?.peers) ? result.peers : [];
    // Falle 3: filter by source — a raw count double-counts (no cross-source
    // dedup upstream, by design) and would treat a leftover STATE.md as a
    // running session. No extra sessionId dedupe: within 'discovered',
    // discoverActiveSessions already deduped.
    const discoveredAll = allPeers.filter((p) => (
      p && p.source === SOURCE_DISCOVERED && typeof p.sessionId === 'string'
    ));
    const livePeers = discoveredAll.filter((p) => !selfIds.has(p.sessionId));

    if (livePeers.length === 0) {
      // Falle 4 — the full path's negative verdict needs a liveness proof of
      // its own. findPeers fails open per surface and returns ONLY `{ peers }`,
      // so "both surfaces broke" and "measured, nobody home" are the same
      // value. Canary: when our own lock is live, the discovered surface MUST
      // have returned our own entry — `discoverActiveSessions` reads this
      // worktree's lock either through `git worktree list` or, on failure, the
      // A1 single-worktree fallback. Zero discovered entries under a live own
      // lock therefore means the surface produced nothing at all, not that the
      // repo is quiet → fail safe.
      if (discoveredAll.length === 0 && lock !== null && isLockLive(lock, nowMs)) {
        return _verdict(true, 'probe-degraded', PROBE_FULL_DEGRADED);
      }
      // #919.3 — the canary above needs a live own lock to assert against.
      // Without one, "total surface failure" and "quiet repo" still arrive as
      // the same empty list (the documented residual gap). Close it with a
      // direct liveness check of the git surface itself: did `git worktree
      // list` actually RUN? Only reached when the discovered surface produced
      // NOTHING — any discovered entry is already proof the surface
      // functioned, so the extra git spawn is paid solely on the branch that
      // needs it.
      if (discoveredAll.length === 0) {
        const gitRan = await _confirmWorktreeListRan(opts);
        if (!gitRan) {
          return _verdict(true, 'probe-degraded', PROBE_FULL_DEGRADED);
        }
      }
      return _verdict(false, 'no-peers', PROBE_FULL);
    }
    return _verdict(true, 'live-peer-discovered', PROBE_FULL, {
      peerCount: livePeers.length,
      peer: _peerFromFindPeersEntry(livePeers[0]),
    });
  } catch {
    // Unreachable by contract (every callee is documented never-throws), but a
    // regression here must not turn a probe into an exception at the call site.
    return _verdict(true, 'probe-error', PROBE_NONE);
  }
}

// ===========================================================================
// CLI entry (#908 Befund 3) — `checkLiveForeignSession` from a shell.
//
// The consumer of this function is the Fact-Staleness Annotation rule in
// `skills/wave-executor/wave-loop.md` (Trigger 3), which a COORDINATOR LLM
// evaluates once per wave. A coordinator has Bash, not an ESM module loader —
// documenting the call as an `import` made the trigger unevaluatable, so the
// rule shipped inert. This entry point is what makes it executable.
//
// Contract follows `.claude/rules/cli-design.md` and the in-repo precedent of
// `scripts/lib/fetch-baseline.mjs` (a lib module with a documented CLI invoked
// from a skill body): data → stdout, diagnostics → stderr, `--json` for
// machine-readable output, documented exit codes.
//
// NOTE on exit codes: a live peer is a RESULT, not an error. `live` is read
// from the payload; the exit code reports whether the probe RAN. Encoding the
// verdict in the exit code would collide with the usage-error code and would
// invert the fail-safe direction on any shell that treats non-zero as failure.
// ===========================================================================

const CLI_USAGE = `Usage: node scripts/lib/peer-discovery.mjs --check-live <repoRoot> [--cwd <dir>] [--json]

Probe whether a LIVE FOREIGN session is running in <repoRoot>.

Options:
  --check-live <repoRoot>  Repository root to probe (required).
  --cwd <dir>              Input for own-vs-foreign probe selection (default: process.cwd()).
  --json                   Emit the verdict as JSON on stdout.
  -h, --help               Print this help.

Output (stdout) — JSON shape with --json:
  { "live": bool, "reason": string, "probe": string, "peerCount": number, "peer": object|null }

Exit codes:
  0  the probe ran; a verdict was produced (read "live" from the payload —
     a live foreign session is a RESULT, not an error)
  1  usage error (missing or unknown argument)
  2  system error (the probe threw, which its contract forbids)
`;

/**
 * One-line human rendering of a verdict. Key=value so it stays greppable
 * without being mistaken for the machine format (`--json`).
 *
 * @param {{live:boolean,reason:string,probe:string,peerCount:number,peer:object|null}} v
 * @returns {string}
 */
function _formatVerdictHuman(v) {
  const parts = [
    `live=${v.live}`,
    `reason=${v.reason}`,
    `probe=${v.probe}`,
    `peerCount=${v.peerCount}`,
  ];
  if (v.peer && v.peer.sessionId) parts.push(`peer=${v.peer.sessionId}`);
  return parts.join(' ');
}

/**
 * CLI main. Never throws; sets `process.exitCode` and returns so a pending
 * stdout write can drain naturally (an explicit `process.exit()` races the
 * kernel pipe buffer — see the same note in `scripts/lib/description-surface.mjs`).
 *
 * @param {string[]} argv Arguments after `node <file>`.
 * @returns {Promise<void>}
 */
async function _cliMain(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        'check-live': { type: 'string' },
        cwd: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`peer-discovery: ${err.message}\n\n${CLI_USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.values.help) {
    process.stdout.write(CLI_USAGE);
    return;
  }

  const target = parsed.values['check-live'];
  if (typeof target !== 'string' || target.trim() === '') {
    process.stderr.write(`peer-discovery: --check-live <repoRoot> is required\n\n${CLI_USAGE}`);
    process.exitCode = 1;
    return;
  }

  let verdict;
  try {
    verdict = await checkLiveForeignSession(target, {
      cwd: typeof parsed.values.cwd === 'string' ? parsed.values.cwd : undefined,
    });
  } catch (err) {
    // Unreachable by contract — kept so a regression surfaces as exit 2 with a
    // one-line diagnostic instead of an unhandled rejection stack trace.
    process.stderr.write(`peer-discovery: probe failed unexpectedly: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  process.stdout.write(
    (parsed.values.json ? JSON.stringify(verdict) : _formatVerdictHuman(verdict)) + '\n',
  );
}

const __filename = fileURLToPath(import.meta.url);
const _isCliMain =
  typeof process !== 'undefined'
  && process.argv[1] !== null
  && process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(__filename);

// Called WITHOUT `await` on purpose: a top-level await would make this module
// async for every importer, and `_cliMain` cannot reject (all paths are caught
// internally). Node drains the event loop before exiting, so `process.exitCode`
// set inside still takes effect. Same shape as scripts/lib/description-surface.mjs.
if (_isCliMain) _cliMain(process.argv.slice(2));
