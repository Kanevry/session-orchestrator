/**
 * lock-reaper.mjs — reconciliation for orphaned session.lock leases (Epic #724 C7).
 *
 * The complement to the deterministic release wired into hooks/on-session-end.mjs
 * (W2). That release covers the clean-exit path (readLock → ownership-match →
 * release). The reaper is the RECONCILIATION for leases that were left behind
 * anyway — a crash before SessionEnd, an old fleet-wide backlog, a lock a
 * different repo's process never cleaned up. Fleet evidence: 10 orphans (dead
 * PIDs) across ~/Projects, one of which blocked this repo's own session-start
 * this morning until it was force-taken-over by hand.
 *
 * Discovery reuses dispatcher/enumerate.mjs (host-wide candidate scan classifying
 * each repo's lease free | in-progress | force-closed). `force-closed` — a lock
 * present but with a heartbeat older than its TTL — is exactly the reap set.
 *
 * HARD SAFETY INVARIANTS (see reapStaleLocks / evaluateRepo):
 *   (a) NEVER reap a live lock (isLockLive true) — heartbeat-fresh means an
 *       active owner, regardless of anything else.
 *   (b) Defense-in-depth: own-host lock whose recorded PID is still alive is
 *       NEVER reaped, even past TTL (PID-recycle / genuinely-alive edge).
 *   (c) Cross-host locks are NEVER auto-reaped — we cannot signal a remote
 *       process, so they are only LISTED for an operator (reason
 *       'cross-host-requires-operator'), independent of any flag.
 *   (d) A reap is an ARCHIVE-MOVE (write a copy to
 *       <repo>/.orchestrator/tmp/reaped-locks/<sessionId>-<ts>.json, then unlink
 *       the original) — never an unlink-only. The archive is the audit trail.
 *   (e) TOCTOU defense: immediately before the destructive unlink, the lease is
 *       RE-READ and re-verified (still dead + same session_id as the lock this
 *       evaluation started from). A session that bootstraps and writes a FRESH
 *       lock in the window between the initial read and the unlink must not
 *       have its lease destroyed. A changed/live lease aborts the reap with
 *       reason 'lock-changed-during-reap' and best-effort undoes the archive
 *       write that was already made.
 *
 * No-throw contract: every path catches and degrades. Per-repo failures land in
 * `skipped` with an `error: …` reason; the sweep continues.
 *
 * Dependency-injected (the `deps` arg) exactly like enumerate.mjs so tests drive
 * tmp fixtures + spy on emitEvent without touching the real ~/Projects fleet.
 *
 * Plain Node ESM. Named exports. No external deps.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enumerateCandidates } from './dispatcher/enumerate.mjs';
import { readLock, isLockLive, isPidAliveOnHost, LOCK_PATH } from './session-lock.mjs';
import { emitEvent } from './events.mjs';

const REAPED_ARCHIVE_SUBDIR = '.orchestrator/tmp/reaped-locks';
const EVENTS_RELPATH = '.orchestrator/metrics/events.jsonl';
const REAPED_EVENT = 'orchestrator.session.lock.reaped';

/**
 * Resolve the dependency bundle, defaulting every seam to the real
 * implementation. Tests override the ones they need (hostname, isPidAliveOnHost,
 * emitEvent, fs, and enumerateDeps.getCrossRepoProjects for a []-stubbed scan).
 *
 * @param {object} [deps]
 * @returns {object}
 */
function resolveDeps(deps = {}) {
  const d = deps ?? {};
  return {
    enumerateCandidates: d.enumerateCandidates ?? enumerateCandidates,
    readLock: d.readLock ?? readLock,
    isLockLive: d.isLockLive ?? isLockLive,
    isPidAliveOnHost: d.isPidAliveOnHost ?? isPidAliveOnHost,
    hostname: d.hostname ?? (() => os.hostname()),
    emitEvent: d.emitEvent ?? emitEvent,
    fs: d.fs ?? { readFileSync, writeFileSync, unlinkSync, mkdirSync },
    // Passed straight through to enumerateCandidates for its own fs/config DI.
    // Tests set { getCrossRepoProjects: async () => [] } so the scan stays
    // confined to the tmp fixture and never unions in real ~/Projects paths.
    enumerateDeps: d.enumerateDeps,
  };
}

/**
 * Absolute path to a repo's session.lock.
 * @param {string} repoRoot
 * @returns {string}
 */
function lockPathFor(repoRoot) {
  return path.join(repoRoot, LOCK_PATH);
}

/**
 * Fractional hours since a lock's last heartbeat (the liveness basis). Falls
 * back to started_at when last_heartbeat is absent (v1 lock). Returns null when
 * neither parses.
 *
 * @param {object} lock
 * @param {number} nowMs
 * @returns {number|null}
 */
function ageHoursOf(lock, nowMs) {
  const hb = (typeof lock.last_heartbeat === 'string' && lock.last_heartbeat.length > 0)
    ? lock.last_heartbeat
    : lock.started_at;
  const ms = Date.parse(hb);
  if (Number.isNaN(ms)) return null;
  return Number(((nowMs - ms) / (3600 * 1000)).toFixed(2));
}

/**
 * The stable session identifier for archive/event purposes: prefer the semantic
 * id, fall back to the UUID session_id, then a literal.
 * @param {object} lock
 * @returns {string}
 */
function lockSessionId(lock) {
  return lock.semantic_session_id ?? lock.session_id ?? 'unknown-session';
}

/**
 * Archive-move a lock file (invariant d): copy the original bytes to the
 * per-repo reaped-locks archive, THEN unlink the original. Never unlink-only —
 * if the archive write fails, the original stays on disk and the caller reports
 * an error instead of destroying the lease.
 *
 * TOCTOU re-check (invariant e): immediately before the destructive unlink, the
 * lease is re-read via `D.readLock` and re-verified — still dead (per
 * `D.isLockLive`) AND the same `session_id` as the `lock` this call started
 * from. A session that bootstraps and writes a fresh lock in the window
 * between evaluateRepo's initial read and this point must not be destroyed.
 * On a changed/live lease, the archive write already made is best-effort
 * undone and the caller reports `{ ok: false, reason: 'lock-changed-during-reap' }`
 * instead of unlinking.
 *
 * @param {string} repoRoot
 * @param {string} lockFile
 * @param {object} lock — the parsed lock (fallback content if the raw re-read fails).
 * @param {number} nowMs
 * @param {object} fsDep — { readFileSync, writeFileSync, unlinkSync, mkdirSync }.
 * @param {object} D — resolved deps (needs `readLock` + `isLockLive` for the re-check).
 * @returns {{ ok: true, archivePath: string } | { ok: false, reason: string }}
 */
function archiveLock(repoRoot, lockFile, lock, nowMs, fsDep, D) {
  const safeId = String(lockSessionId(lock)).replace(/[^A-Za-z0-9._-]/g, '_');
  const ts = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(repoRoot, REAPED_ARCHIVE_SUBDIR);
  fsDep.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `${safeId}-${ts}.json`);

  // Preserve the exact original bytes; fall back to the serialised parsed lock
  // if the re-read fails (e.g. it vanished between readLock and here).
  let raw;
  try {
    raw = fsDep.readFileSync(lockFile, 'utf8');
  } catch {
    raw = JSON.stringify(lock, null, 2) + '\n';
  }
  fsDep.writeFileSync(archivePath, raw, 'utf8');

  // Invariant (e) — TOCTOU re-check, immediately before the destructive unlink.
  let recheck;
  try {
    recheck = D.readLock({ repoRoot });
  } catch {
    recheck = null;
  }
  const sameLease = recheck !== null && recheck.session_id === lock.session_id;
  const stillDead = recheck !== null && !D.isLockLive(recheck, nowMs);
  if (!sameLease || !stillDead) {
    // Best-effort undo of the archive write — the original lease is untouched
    // either way, but leaving a stray archive copy around is misleading.
    try { fsDep.unlinkSync(archivePath); } catch { /* best-effort */ }
    return { ok: false, reason: 'lock-changed-during-reap' };
  }

  // Only after the archive is durably written AND the re-check confirms the
  // lease is unchanged do we remove the original.
  fsDep.unlinkSync(lockFile);
  return { ok: true, archivePath };
}

/**
 * Evaluate a single repo's lease and — under !dryRun — reap it if eligible.
 *
 * Returns exactly one of:
 *   { action: 'none', repo, reason }        — no lock present.
 *   { action: 'skipped', repo, reason, … }  — protected by an invariant.
 *   { action: 'candidate', repo, … }        — reap-eligible, dry-run (not touched).
 *   { action: 'reaped', repo, …, archivePath } — reap-eligible, archived + emitted.
 *
 * @param {string} repoRoot
 * @param {object} args
 * @param {number} args.nowMs
 * @param {boolean} args.dryRun
 * @param {string} [args.currentSessionId] — never reap the caller's own session.
 * @param {string} args.reapMode — event tag: 'cli' | 'auto-own-repo'.
 * @param {object} args.D — resolved deps.
 * @returns {Promise<object>}
 */
async function evaluateRepo(repoRoot, { nowMs, dryRun, currentSessionId, reapMode, D }) {
  let lock;
  try {
    lock = D.readLock({ repoRoot });
  } catch {
    lock = null;
  }
  if (!lock || typeof lock !== 'object') {
    return { action: 'none', repo: repoRoot, reason: 'no-lock' };
  }

  // Invariant (a): a live lock (fresh heartbeat) is NEVER reaped.
  if (D.isLockLive(lock, nowMs)) {
    return { action: 'skipped', repo: repoRoot, reason: 'live' };
  }

  // Re-entrancy guard: never reap the current session's own lease. Protects the
  // hook splice, where lock-bootstrap just wrote our fresh lock in the same run.
  if (
    currentSessionId &&
    (lock.session_id === currentSessionId || lock.semantic_session_id === currentSessionId)
  ) {
    return { action: 'skipped', repo: repoRoot, reason: 'current-session' };
  }

  const ownHost = lock.host === D.hostname();

  // Invariant (c): cross-host leases are NEVER auto-reaped — only listed.
  if (!ownHost) {
    return {
      action: 'skipped',
      repo: repoRoot,
      reason: 'cross-host-requires-operator',
      host: lock.host ?? null,
    };
  }

  // Invariant (b): own-host + live PID → NEVER reap, even past TTL. The recorded
  // pid is the ephemeral hook subprocess (dead in the common orphan case); a
  // still-alive pid means either a genuinely-live owner or a recycled pid — the
  // conservative choice is to defer to the operator rather than risk a false reap.
  let pidAlive;
  try {
    pidAlive = D.isPidAliveOnHost(lock.pid) === true;
  } catch {
    pidAlive = false;
  }
  if (pidAlive) {
    return { action: 'skipped', repo: repoRoot, reason: 'own-host-pid-alive', pid: lock.pid ?? null };
  }

  // Reap-eligible: own-host, dead lease (heartbeat past TTL), dead PID.
  const ageHours = ageHoursOf(lock, nowMs);
  const base = {
    repo: repoRoot,
    repoName: path.basename(repoRoot),
    sessionId: lockSessionId(lock),
    host: lock.host ?? null,
    pid: lock.pid ?? null,
    ageHours,
  };

  if (dryRun) {
    return { action: 'candidate', ...base };
  }

  // Apply: archive-move (invariant d) then best-effort event.
  let archiveResult;
  try {
    archiveResult = archiveLock(repoRoot, lockPathFor(repoRoot), lock, nowMs, D.fs, D);
  } catch (err) {
    return { action: 'skipped', repo: repoRoot, reason: `error: ${err?.message ?? String(err)}` };
  }
  if (!archiveResult.ok) {
    // Invariant (e) — the re-check found a changed/live lease. Never unlink.
    return { action: 'skipped', repo: repoRoot, reason: archiveResult.reason };
  }
  const archivePath = archiveResult.archivePath;

  try {
    await D.emitEvent(
      REAPED_EVENT,
      {
        session_id: lock.session_id ?? null,
        semantic_session_id: lock.semantic_session_id ?? null,
        host: lock.host ?? null,
        pid: lock.pid ?? null,
        age_hours: ageHours,
        reap_mode: reapMode,
      },
      { filePath: path.join(repoRoot, EVENTS_RELPATH) },
    );
  } catch {
    // Observability is best-effort — the archive-move already succeeded.
  }

  return { action: 'reaped', ...base, archivePath };
}

/**
 * Host-wide reconciliation: enumerate candidate repos under `startDir`, and for
 * each `force-closed` (dead-lease) repo evaluate + (under !dryRun) reap it.
 *
 * @param {object} [opts]
 * @param {string} [opts.startDir] — scan root; defaults to the confinement root
 *   (via enumerateCandidates). Tests pass a tmp fixture dir.
 * @param {number} [opts.now] — clock seam (ms).
 * @param {boolean} [opts.dryRun=true] — SAFE DEFAULT: classify without mutating.
 * @param {boolean} [opts.ownHostOnly=true] — reaping is restricted to own-host
 *   leases. Cross-host leases are NEVER reaped regardless (invariant c); this
 *   flag is echoed in the result for auditability and cannot loosen invariant c.
 * @param {object} [opts.deps] — DI seam (see resolveDeps).
 * @returns {Promise<{ scanned:number, candidates:object[], reaped:object[], skipped:object[], dryRun:boolean, ownHostOnly:boolean }>}
 */
export async function reapStaleLocks({ startDir, now, dryRun = true, ownHostOnly = true, deps } = {}) {
  const D = resolveDeps(deps);
  const nowMs = typeof now === 'number' ? now : Date.now();

  let enumerated;
  try {
    enumerated = await D.enumerateCandidates({ startDir, now: nowMs, deps: D.enumerateDeps });
  } catch {
    enumerated = [];
  }
  if (!Array.isArray(enumerated)) enumerated = [];

  const scanned = enumerated.length;
  const candidates = [];
  const reaped = [];
  const skipped = [];

  const forceClosed = enumerated.filter((c) => c && c.status === 'force-closed' && typeof c.repoRoot === 'string');

  for (const cand of forceClosed) {
    let result;
    try {
      result = await evaluateRepo(cand.repoRoot, { nowMs, dryRun, reapMode: 'cli', D });
    } catch (err) {
      skipped.push({ repo: cand.repoRoot, reason: `error: ${err?.message ?? String(err)}` });
      continue;
    }
    switch (result.action) {
      case 'reaped':
        reaped.push(result);
        candidates.push(result);
        break;
      case 'candidate':
        candidates.push(result);
        break;
      case 'skipped':
        skipped.push({ repo: result.repo, reason: result.reason });
        break;
      // 'none' (no-lock) cannot occur for a force-closed candidate; ignore.
    }
  }

  return { scanned, candidates, reaped, skipped, dryRun, ownHostOnly };
}

/**
 * Single-repo reconciliation — the own-repo path used by the SessionStart hook.
 * Reads ONE repo's lease directly (no host-wide scan → hook stays cheap) and
 * reaps it only when eligible. The live-lock + current-session guards mean the
 * caller's own freshly-bootstrapped lock is always left untouched.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {number} [opts.now]
 * @param {boolean} [opts.dryRun=true]
 * @param {string} [opts.currentSessionId] — the caller's session id (guard).
 * @param {string} [opts.reapMode='auto-own-repo']
 * @param {object} [opts.deps]
 * @returns {Promise<object>} a single evaluateRepo result.
 */
export async function reapRepoLock({ repoRoot, now, dryRun = true, currentSessionId, reapMode = 'auto-own-repo', deps } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return { action: 'none', repo: repoRoot ?? null, reason: 'no-repo-root' };
  }
  const D = resolveDeps(deps);
  const nowMs = typeof now === 'number' ? now : Date.now();
  try {
    return await evaluateRepo(repoRoot, { nowMs, dryRun, currentSessionId, reapMode, D });
  } catch (err) {
    return { action: 'skipped', repo: repoRoot, reason: `error: ${err?.message ?? String(err)}` };
  }
}
