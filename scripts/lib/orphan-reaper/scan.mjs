/**
 * orphan-reaper/scan.mjs — one orphan scan end to end: `ps` → decide → (unless
 * `dryRun`) re-verify identity before every signal → kill the group → audit.
 *
 * The IMPURE half of the reaper. Everything impure reaches the pure decision
 * (`reaper-decide.mjs`) through `deps` ({@link resolveDeps}), the
 * `lock-reaper.mjs` split of `evaluateRepo()` / `archiveLock()`.
 */

import {
  killProcessGroup,
  pruneGateProcessLedger,
  readGateProcessLedger,
  verifyProcessIdentity,
} from '../process-group.mjs';
import { REAPER_DEFAULTS } from './defaults.mjs';
import { parsePsSnapshot, parsePsSnapshotDetailed, runPs, runPsPid } from './ps-snapshot.mjs';
import {
  FALSE_ALARM_SUSPECT_RATE,
  appendAuditRecord,
  buildAuditRecord,
  falseAlarmRate,
  pruneReaperAudit,
  readAuditRecords,
} from './reaper-audit.mjs';
import { decideReapCandidates, verifyGroupMemberIdentity } from './reaper-decide.mjs';

/** Name const for the one event this module emits. @see docs/events-schema.md */
export const REAPER_SCAN_EVENT = 'orchestrator.reaper.scan_completed';

/** Default own-session-id reader. Lazily imported so the static import closure
 *  of this module stays small — it is destined for a hot-path hook (#1432).
 *  @param {string} repoRoot @returns {Promise<string|null>} */
async function defaultReadOwnSessionId(repoRoot) {
  try {
    const mod = await import('../session-identity/own-session.mjs');
    const ids = mod.readOwnSessionIds(repoRoot);
    for (const id of ids) return id;
    return null;
  } catch {
    return null;
  }
}

/**
 * Default live-peer probe. Lazily imported for the same reason as
 * {@link defaultReadOwnSessionId}.
 *
 * Returns `null` — never `[]` — when the registry cannot be read. The two mean
 * opposite things to `decideReapCandidates`: `[]` is a MEASUREMENT ("no
 * peer is alive", so a foreign session's leftovers are reapable), `null` is the
 * absence of one ("report it, do not touch it").
 *
 * @param {string|null} sessionId
 * @returns {Promise<string[]|null>}
 */
async function defaultDetectPeers(sessionId) {
  try {
    const mod = await import('../session-registry.mjs');
    const peers = await mod.detectPeers({ sessionId: sessionId ?? undefined });
    if (!Array.isArray(peers)) return null;
    return peers.map((p) => p?.session_id).filter((v) => typeof v === 'string' && v.length > 0);
  } catch {
    return null;
  }
}

/**
 * Default event emitter. Lazily imported for the same reason as
 * {@link defaultReadOwnSessionId}: `events.mjs` pulls in the schema validator,
 * the attribution chain and the webhook client, and this module is destined for
 * a hot-path hook (#1432) whose static import closure is measured.
 *
 * Never throws and never rejects — telemetry that can fail a scan would fail the
 * hook the scan runs in.
 *
 * @param {string} type
 * @param {object} payload
 * @param {{repoRoot?: string}} [opts]
 * @returns {Promise<boolean>} whether the record was written
 */
async function defaultEmitEvent(type, payload, opts = {}) {
  try {
    const mod = await import('../events.mjs');
    await mod.emitEvent(type, payload, opts);
    return true;
  } catch {
    return false;
  }
}

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Resolve the adapter, defaulting every seam to the real implementation — the
 * `resolveDeps()` pattern from `lock-reaper.mjs:77-100`.
 *
 * `killProcessGroup` HAS a real default, and that is safe only because
 * {@link runOrphanScan} defaults `dryRun: true`. Tests ALWAYS inject it
 * (`.claude/rules/testing.md`: never a real process as a kill target).
 *
 * @param {object} [deps]
 * @returns {object}
 */
export function resolveDeps(deps = {}) {
  const d = deps ?? {};
  return {
    runPs: d.runPs ?? runPs,
    runPsPid: d.runPsPid ?? runPsPid,
    readLedger: d.readLedger ?? readGateProcessLedger,
    verifyIdentity: d.verifyIdentity ?? verifyProcessIdentity,
    killProcessGroup: d.killProcessGroup ?? killProcessGroup,
    detectPeers: d.detectPeers ?? defaultDetectPeers,
    readOwnSessionId: d.readOwnSessionId ?? defaultReadOwnSessionId,
    appendAudit: d.appendAudit ?? appendAuditRecord,
    readAuditRecords: d.readAuditRecords ?? readAuditRecords,
    emitEvent: d.emitEvent ?? defaultEmitEvent,
    now: d.now ?? Date.now,
    sleep: d.sleep ?? defaultSleep,
  };
}

/**
 * Map an identity verdict's reason to the audit's `reason` vocabulary.
 *
 * Three outcomes, never two: `gone` (measured, the process is not there),
 * `signature-mismatch` / `identity-mismatch` (measured, it is a DIFFERENT
 * process) and `unmeasured` (the probe itself could not answer). The third is
 * the one a two-state mapping loses, and losing it is how an absent measurement
 * starts reading like a clean verdict.
 *
 * @param {string|null|undefined} identityReason
 * @returns {'gone'|'signature-mismatch'|'identity-mismatch'|'unmeasured'}
 */
function rejectReasonFor(identityReason) {
  if (identityReason === 'gone') return 'gone';
  if (identityReason === 'unmeasured') return 'unmeasured';
  if (identityReason === 'signature-mismatch') return 'signature-mismatch';
  return 'identity-mismatch';
}

/**
 * Run one orphan scan: `ps` → decide → (unless `dryRun`) re-verify identity
 * against a FRESH snapshot → kill the group → audit.
 *
 * NO-THROW contract: every failure degrades into `skipped: '<reason>'` or a
 * `rejected` entry, because this runs from a hook and must never fail it
 * (PRD FA4: "bei jedem Fehler degradiert er lautlos").
 *
 * The pre-signal re-check is the TOCTOU defence and the whole point of FA3: a
 * PID recycled between decision and signal must NOT be signalled. It runs a
 * TARGETED `ps` (`psPidArgs`, `ps-snapshot.mjs`) through `deps.runPsPid` and feeds the row to
 * {@link verifyProcessIdentity} — immediately before SIGTERM **and** immediately
 * before SIGKILL, via `killProcessGroup`'s `beforeSignal` gate, because the
 * ladder's 10 s grace is itself a recycling window. On any mismatch no further
 * signal is sent and the candidate is recorded as `decision: 'reject'` with the
 * reason that withdrew it. Such a candidate stays in `candidates` (that WAS the
 * decision) and additionally appears in `rejected` (that is the withdrawal) —
 * the two arrays answer different questions and collapsing them would lose the
 * TOCTOU event.
 *
 * Success is proven the same way, never from an exit code: after the ladder the
 * scan waits `verifyWaitMs` and re-measures (B6). `ok` is true only for a
 * process that is GONE; one that outlived SIGKILL is booked
 * `survivedSigkill: true`, and one the probe could not measure is `verified:
 * 'unmeasured'` — neither is ever a success.
 *
 * `dryRun` defaults to TRUE: arming happens at the CALL SITE (#1432), so a
 * caller that forgets the flag scans and reports instead of killing.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {number} [opts.now]
 * @param {boolean} [opts.dryRun]
 * @param {object} [opts.deps]
 * @param {number} [opts.minAgeSeconds]
 * @param {number} [opts.killGraceMs]
 * @param {number} [opts.verifyWaitMs]
 * @param {number} [opts.falseAlarmWindow]  Rolling window of audit DECISIONS the
 *   HR-101 rate is judged over (`reaper.false-alarm-window`).
 * @returns {Promise<{scanned: number, candidates: object[], reported: object[],
 *   rejected: object[], killed: object[], unattributed: number,
 *   peerLiveness: 'measured'|'unmeasured'|null, skipped?: string, malformed: number,
 *   durationMs: number, instrumentSuspect: boolean|null, falseAlarmRate: number|null,
 *   falseAlarmWindowN: number}>}
 *   `instrumentSuspect`/`falseAlarmRate` are `null` on a degraded (`skipped`) scan
 *   and `falseAlarmRate` is `null` below the 10-decision floor — in both cases a
 *   measurement that does not exist, never a measured zero. `peerLiveness` is the
 *   same distinction for the peer probe, and `null` only on a degraded scan.
 */
export async function runOrphanScan({
  repoRoot,
  now,
  dryRun = true,
  deps,
  minAgeSeconds = REAPER_DEFAULTS.minAgeSeconds,
  killGraceMs = REAPER_DEFAULTS.killGraceMs,
  verifyWaitMs = REAPER_DEFAULTS.verifyWaitMs,
  falseAlarmWindow = REAPER_DEFAULTS.falseAlarmWindow,
} = {}) {
  const d = resolveDeps(deps);
  const startedAt = typeof now === 'number' ? now : d.now();
  // A degraded scan measured NOTHING — including the instrument's own health.
  // `null` rather than `false`/`0` for both instrument fields: a scan that never
  // ran must not report a healthy instrument it never looked at.
  const empty = (skipped, malformed = 0) => ({
    scanned: 0,
    candidates: [],
    reported: [],
    rejected: [],
    killed: [],
    unattributed: 0,
    // Nothing was measured, so peer liveness was not measured either — `null`
    // rather than the string, because "unmeasured" is a MEASUREMENT OUTCOME and
    // a degraded scan never got as far as the probe.
    peerLiveness: null,
    skipped,
    malformed,
    durationMs: Math.max(0, d.now() - startedAt),
    instrumentSuspect: null,
    falseAlarmRate: null,
    falseAlarmWindowN: 0,
  });

  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return empty('no-repo-root');

  let text;
  try {
    text = await d.runPs();
  } catch {
    return empty('ps-failed');
  }
  if (text === null || text === undefined) return empty('ps-failed');

  const { rows, malformed } = parsePsSnapshotDetailed(text);

  let ledger;
  try {
    ledger = d.readLedger(repoRoot, { nowMs: startedAt });
  } catch {
    return empty('ledger-unreadable', malformed);
  }

  let ownSessionId = null;
  try {
    ownSessionId = await d.readOwnSessionId(repoRoot);
  } catch {
    ownSessionId = null;
  }

  /** @type {string[]|null} */
  let livePeerSessionIds;
  try {
    livePeerSessionIds = await d.detectPeers(ownSessionId);
  } catch {
    // null = unmeasured, NOT "no peers" — see decideReapCandidates.
    livePeerSessionIds = null;
  }

  const { candidates, reported, rejected } = decideReapCandidates(
    rows,
    ledger?.records ?? [],
    startedAt,
    { ownSessionId, livePeerSessionIds, minAgeSeconds },
  );

  const timestamp = new Date(startedAt).toISOString();
  const audit = (entry, decision, extra = {}) => {
    try {
      d.appendAudit(repoRoot, buildAuditRecord(entry, decision, {
        timestamp, sessionId: ownSessionId, ...extra,
      }));
    } catch {
      /* the audit is an aid, never a precondition */
    }
  };

  for (const entry of reported) audit(entry, 'report');

  /** @type {object[]} */
  const killed = [];

  /**
   * Close the scan: measure the instrument's own health (HR-101), emit at most
   * one event, return the result. Both real exits go through here so the rate
   * and the event can never be computed twice or forgotten once.
   * @returns {Promise<object>}
   */
  const complete = async () => {
    let auditRecords;
    try {
      auditRecords = (await d.readAuditRecords(repoRoot, falseAlarmWindow)) ?? [];
    } catch {
      auditRecords = [];
    }
    const fa = falseAlarmRate(auditRecords, falseAlarmWindow);
    // HR-101: the rate re-aims the instrument, it never re-thresholds it — so
    // this flag is REPORTED and nothing here branches on it.
    const instrumentSuspect = typeof fa.rate === 'number' && fa.rate > FALSE_ALARM_SUSPECT_RATE;
    const survivedSigkill = killed.filter((k) => k.survivedSigkill === true).length;
    const durationMs = Math.max(0, d.now() - startedAt);
    // Two counts that must not hide inside `reported`: an unattributed record is
    // a PRODUCER defect (the gate runner passed no session id), and an
    // unmeasured peer probe is an INSTRUMENT gap. Folded into the generic
    // `reported` number, both are invisible — which is how the foreign-session
    // guard stayed inert across 377 of 377 records without anything saying so.
    const unattributed = reported.filter((r) => r.reason === 'unattributed').length;
    const peerLiveness = livePeerSessionIds === null ? 'unmeasured' : 'measured';

    // HR-101 again, in the other direction: a signal that fires on every hook
    // is noise nobody reads. A scan that found nothing emits nothing — the
    // absence of a record IS the healthy state, and `instrumentSuspect` is the
    // one finding that must surface even from an empty scan.
    if (candidates.length + reported.length + killed.length > 0 || instrumentSuspect) {
      try {
        await d.emitEvent(REAPER_SCAN_EVENT, {
          scanned: rows.length,
          candidates: candidates.length,
          reported: reported.length,
          rejected: rejected.length,
          killed: killed.length,
          unattributed,
          peer_liveness: peerLiveness,
          survived_sigkill: survivedSigkill,
          dry_run: dryRun === true,
          duration_ms: durationMs,
          instrument_suspect: instrumentSuspect,
          // OMITTED below the 10-decision floor, never 0: absence means "no
          // population yet", and a fabricated zero would read as a clean
          // instrument (`falseAlarmRate` returns `{rate: null}` there).
          ...(typeof fa.rate === 'number' ? { false_alarm_rate: fa.rate } : {}),
        }, { repoRoot });
      } catch {
        /* telemetry that can fail a scan would fail the hook the scan runs in */
      }
    }

    // Housekeeping, last and best-effort: the ledger is append-only and grew
    // monotonically (measured 2026-09-22: 369 lines/day) because nothing in
    // production ever called the pruner.
    try {
      pruneGateProcessLedger(repoRoot);
      // The audit is pruned AFTER it was read for the rate above, so a prune
      // can never shrink the population this scan judged itself on.
      pruneReaperAudit(repoRoot);
    } catch {
      /* housekeeping, never a precondition of a scan */
    }

    return {
      scanned: rows.length,
      candidates,
      reported,
      rejected,
      killed,
      unattributed,
      peerLiveness,
      malformed,
      durationMs,
      instrumentSuspect,
      falseAlarmRate: fa.rate,
      falseAlarmWindowN: fa.n,
    };
  };

  if (dryRun) {
    for (const c of candidates) audit(c, 'dry-run');
    return complete();
  }

  /**
   * ONE fresh, targeted identity measurement for one candidate (B3).
   *
   * There is deliberately no second, bulk `ps` pass any more: two TOCTOU
   * instruments measuring the same property at different freshness is how the
   * stale one silently wins. This is the only pre-signal measurement, and it is
   * taken immediately before each signal rather than once for the whole pass.
   *
   * @param {object} c
   * @returns {Promise<{match: boolean, reason: string, observed?: object}>}
   */
  const freshIdentity = async (c) => {
    let text;
    try {
      text = await d.runPsPid(c.pid);
    } catch {
      text = null;
    }
    // `ps -p` cannot distinguish "gone" from "could not run"; both must refuse
    // the signal, and only the second is an instrument gap worth its own reason.
    if (text === null || text === undefined) return { match: false, reason: 'unmeasured' };
    const row = parsePsSnapshot(text).find((r) => r.pid === c.pid) ?? null;
    try {
      // A group MEMBER is re-verified the way it was decided — by the leader's
      // seam it would fail every time (its own start time, its own command),
      // and a pre-signal check that always refuses is a disarmed feature, not a
      // strict one.
      if (c.isLeader === false) {
        return verifyGroupMemberIdentity(row, c.ledgerRecord, { nowMs: d.now() });
      }
      return d.verifyIdentity(
        c.pid,
        { startTime: c.ledgerRecord.startTime, commandSignature: c.ledgerRecord.commandSignature },
        { snapshotLine: row, nowMs: d.now() },
      );
    } catch {
      return { match: false, reason: 'gone' };
    }
  };

  // ONE ladder per GROUP, not per row: with the pgid join a single group can
  // contribute several candidate rows (leader + descendants), and they all name
  // the same kill target. Leaders first, so the target of a group is the process
  // the ledger actually recorded whenever it is still alive.
  const killTargets = [];
  const coveredPgids = new Set();
  for (const c of [...candidates.filter((x) => x.isLeader), ...candidates.filter((x) => !x.isLeader)]) {
    if (coveredPgids.has(c.pgid)) continue;
    coveredPgids.add(c.pgid);
    killTargets.push(c);
  }

  for (const c of killTargets) {
    /** Set by the gate below when it refuses; `null` means every signal was permitted. */
    let withdrawal = null;
    const beforeSignal = async (signal) => {
      const identity = await freshIdentity(c);
      if (identity?.match === true) return true;
      withdrawal = { signal, identity, reason: rejectReasonFor(identity?.reason) };
      return false;
    };

    let result;
    try {
      result = await d.killProcessGroup(c.pgid, {
        killGraceMs, verifyWaitMs, sleepFn: d.sleep, beforeSignal,
      });
    } catch (err) {
      result = { ok: false, signalsSent: [], survivors: [c.pgid], error: err?.code ?? null, aborted: null };
    }
    const signalsSent = Array.isArray(result?.signalsSent) ? result.signalsSent : [];

    if (withdrawal !== null) {
      // The candidate was withdrawn between decision and signal. It stays in
      // `candidates` (that WAS the decision) and appears in `rejected` (that is
      // the withdrawal) — collapsing the two would lose the TOCTOU event.
      // `signalsSent` is carried even here: a withdrawal before the ESCALATION
      // still means a SIGTERM went out, and an audit that hid it would
      // under-report what this reaper did to the host.
      rejected.push({
        ...c, reason: withdrawal.reason, identity: withdrawal.identity, signalsSent,
      });
      audit(c, 'reject', {
        reason: withdrawal.reason,
        result: {
          ok: false,
          signalsSent,
          survivors: [],
          survivedSigkill: false,
          verifiedAfterMs: 0,
          verified: 'withdrawn',
        },
      });
      continue;
    }

    // B6: prove the EFFECT, after a wait, from a fresh measurement of the
    // process table. An exit code and a sent signal prove nothing — on
    // 2026-09-20 a probe with no wait reported "still alive" for dead processes.
    let verified = 'unverified';
    if (signalsSent.length > 0) {
      await d.sleep(verifyWaitMs);
      const after = await freshIdentity(c);
      if (after?.match === true) verified = 'alive';
      else if (after?.reason === 'unmeasured') verified = 'unmeasured';
      else verified = 'gone';
    }
    const ok = verified === 'gone';
    const survivedSigkill = verified === 'alive' && signalsSent.includes('SIGKILL');
    const survivors = ok ? [] : [c.pgid];
    const verifiedAfterMs = signalsSent.length > 0 ? verifyWaitMs : 0;

    killed.push({
      pid: c.pid,
      pgid: c.pgid,
      // Every candidate row this one ladder covers — the group join means one
      // signal can end several candidates, and a `killed` list that named only
      // the target would under-report what the reaper did to the host.
      groupMemberPids: candidates.filter((x) => x.pgid === c.pgid).map((x) => x.pid),
      ok,
      signalsSent,
      survivors,
      survivedSigkill,
      verified,
      verifiedAfterMs,
    });
    audit(c, 'kill', {
      result: { ok, signalsSent, survivors, survivedSigkill, verifiedAfterMs, verified },
    });
  }

  return complete();
}
