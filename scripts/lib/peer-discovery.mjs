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
 * @module peer-discovery
 */

import { discoverActiveSessions } from './session-discovery.mjs';
import { checkPeerStateMd } from './state-md-peer-guard.mjs';

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
 * @param {string|null} [opts.mySessionId]      Current session id (UUID or semantic).
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
        if (s && typeof s.sessionId === 'string') {
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
