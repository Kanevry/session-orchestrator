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
 * CURRENT-SESSION.JSON ORPHAN SWEEP (Epic #724 follow-up): `evaluateRepo` also
 * sweeps an orphaned `.orchestrator/current-session.json` as part of the SAME
 * lease decision — never as an independent check. The file's fate is folded
 * into the per-repo result's `currentSession` field:
 *   { archived: true, archivePath } | { archived: false, reason }
 * The sweep only ever runs once the LOCK side has already been confirmed
 * dead/absent/reap-eligible (mirrors invariants a-c by construction — a live,
 * re-entrant, cross-host, or pid-alive lock short-circuits with the SAME
 * reason before the file is even read). Once eligible, the file itself is
 * still guarded by:
 *   (b) re-entrancy — never touch a file that references `currentSessionId`.
 *   (c) fresh-preservation — a file whose own age (its `timestamp` field,
 *       falling back to mtime) is within `DEFAULT_TTL_HOURS` is preserved,
 *       protecting a repo mid-bootstrap that wrote current-session.json
 *       before its lock (mirrors the mtime fallback in session-registry.mjs
 *       sweepZombies).
 *   (d) archive-move (same reaped-locks directory, `current-session-` prefix).
 *   (e) TOCTOU re-check immediately before the destructive unlink — aborts
 *       with reason 'current-session-changed-during-reap' if the file changed.
 *
 * No-throw contract: every path catches and degrades. Per-repo failures land in
 * `skipped` with an `error: …` reason; the sweep continues.
 *
 * Dependency-injected (the `deps` arg) exactly like enumerate.mjs so tests drive
 * tmp fixtures + spy on emitEvent without touching the real ~/Projects fleet.
 *
 * Plain Node ESM. Named exports. No external deps.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enumerateCandidates } from './dispatcher/enumerate.mjs';
import { readLock, isLockLive, isPidAliveOnHost, LOCK_PATH, DEFAULT_TTL_HOURS } from './session-lock.mjs';
import { emitEvent } from './events.mjs';

const REAPED_ARCHIVE_SUBDIR = '.orchestrator/tmp/reaped-locks';
const EVENTS_RELPATH = '.orchestrator/metrics/events.jsonl';
const REAPED_EVENT = 'orchestrator.session.lock.reaped';
const CURRENT_SESSION_RELPATH = '.orchestrator/current-session.json';

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
    fs: d.fs ?? { readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync },
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
 * Absolute path to a repo's current-session.json.
 * @param {string} repoRoot
 * @returns {string}
 */
function currentSessionPathFor(repoRoot) {
  return path.join(repoRoot, CURRENT_SESSION_RELPATH);
}

/**
 * Fractional hours since a current-session.json's own `timestamp` field.
 * Falls back to the file's mtime when `timestamp` is absent/unparseable —
 * mirrors the malformed-entry mtime fallback in session-registry.mjs
 * sweepZombies (fresh-preservation protects an in-flight write from being
 * swept before its author finishes bootstrapping).
 *
 * @param {object} parsed — the parsed current-session.json content.
 * @param {string} filePath
 * @param {number} nowMs
 * @param {object} fsDep — { statSync, … }.
 * @returns {number|null} null when neither the timestamp nor the mtime resolve.
 */
function currentSessionAgeHours(parsed, filePath, nowMs, fsDep) {
  const ts = typeof parsed?.timestamp === 'string' ? parsed.timestamp : null;
  const ms = ts ? Date.parse(ts) : NaN;
  if (!Number.isNaN(ms)) {
    return (nowMs - ms) / (3600 * 1000);
  }
  try {
    const info = fsDep.statSync(filePath);
    return (nowMs - info.mtimeMs) / (3600 * 1000);
  } catch {
    return null;
  }
}

/**
 * Whether a parsed current-session.json references the same session as
 * `lock` — either the UUID `session_id` or the `semantic_session_id`
 * matches. Both sides must be non-empty strings to count as a match; two
 * absent/undefined fields are never treated as "matching".
 *
 * @param {object} parsed
 * @param {object} lock
 * @returns {boolean}
 */
function currentSessionReferencesLock(parsed, lock) {
  const sameSessionId =
    typeof parsed.session_id === 'string' && parsed.session_id.length > 0 &&
    parsed.session_id === lock.session_id;
  const sameSemanticId =
    typeof parsed.semantic_session_id === 'string' && parsed.semantic_session_id.length > 0 &&
    parsed.semantic_session_id === lock.semantic_session_id;
  return sameSessionId || sameSemanticId;
}

/**
 * Archive-move current-session.json (mirrors archiveLock's invariants d/e for
 * the file sweep). Copies the original bytes into the SAME per-repo
 * reaped-locks archive directory (prefixed `current-session-` to
 * disambiguate from lock archives), then re-reads the live file immediately
 * before the destructive unlink and aborts if it changed to reference a
 * different session or the caller's own (fresh) session.
 *
 * @param {string} repoRoot
 * @param {string} filePath
 * @param {object} parsed — the content read at evaluation time.
 * @param {number} nowMs
 * @param {object} fsDep
 * @param {string} [currentSessionId] — abort if the file now belongs to the caller.
 * @returns {{ archived: true, archivePath: string } | { archived: false, reason: string }}
 */
function archiveCurrentSessionFile(repoRoot, filePath, parsed, nowMs, fsDep, currentSessionId) {
  const safeId = String(parsed.semantic_session_id ?? parsed.session_id ?? 'unknown-session')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  const ts = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(repoRoot, REAPED_ARCHIVE_SUBDIR);
  fsDep.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `current-session-${safeId}-${ts}.json`);

  // Preserve the exact original bytes; fall back to the serialised parsed
  // content if the re-read fails (e.g. it vanished between read and here).
  let raw;
  try {
    raw = fsDep.readFileSync(filePath, 'utf8');
  } catch {
    raw = JSON.stringify(parsed, null, 2) + '\n';
  }
  fsDep.writeFileSync(archivePath, raw, 'utf8');

  // TOCTOU re-check (invariant e) — re-read immediately before the unlink.
  let recheck;
  try {
    recheck = JSON.parse(fsDep.readFileSync(filePath, 'utf8'));
  } catch {
    recheck = null;
  }
  const stillSame =
    recheck !== null &&
    recheck.session_id === parsed.session_id &&
    recheck.semantic_session_id === parsed.semantic_session_id;
  const nowReferencesCaller =
    recheck !== null &&
    typeof currentSessionId === 'string' && currentSessionId.length > 0 &&
    (recheck.session_id === currentSessionId || recheck.semantic_session_id === currentSessionId);

  if (!stillSame || nowReferencesCaller) {
    // Best-effort undo of the archive write — the original file is untouched
    // either way, but leaving a stray archive copy around is misleading.
    try { fsDep.unlinkSync(archivePath); } catch { /* best-effort */ }
    return { archived: false, reason: 'current-session-changed-during-reap' };
  }

  fsDep.unlinkSync(filePath);
  return { archived: true, archivePath };
}

/**
 * Evaluate + (under !dryRun) sweep an orphaned current-session.json for one
 * repo. The caller only invokes this once the LOCK side of the SAME lease
 * decision has already been confirmed dead/absent/reap-eligible — invariants
 * (a) live-lease, cross-host, and own-host-pid-alive are therefore enforced
 * by the CALLER (evaluateRepo) short-circuiting with a matching reason before
 * this function is ever reached, not by a redundant check here.
 *
 * Orphan predicate: the file is orphaned when `lock` is null (no lease exists
 * at all for the repo — subject only to the freshness guard below) OR the
 * file references `lock` (its `session_id`/`semantic_session_id` matches the
 * already-confirmed-dead lock this evaluation is running against).
 *
 * Guards:
 *   (b) re-entrancy — never touch a file that references `currentSessionId`
 *       (the caller's own fresh write).
 *   (c) fresh-preservation — a file whose own age (timestamp, falling back to
 *       mtime) is within `DEFAULT_TTL_HOURS` is preserved.
 *   (d) archive-move, never unlink-only.
 *   (e) TOCTOU re-check immediately before the destructive unlink.
 *
 * @param {string} repoRoot
 * @param {object} args
 * @param {number} args.nowMs
 * @param {boolean} args.dryRun
 * @param {string} [args.currentSessionId]
 * @param {object|null} args.lock — the confirmed-dead lock this file is being
 *   evaluated against, or null when no lock exists at all for the repo.
 * @param {object} args.fs — resolved fs dep bundle (readFileSync, statSync, …).
 * @returns {{ archived: boolean, archivePath?: string, reason?: string }}
 */
function evaluateCurrentSessionFile(repoRoot, { nowMs, dryRun, currentSessionId, lock, fs: fsDep }) {
  const filePath = currentSessionPathFor(repoRoot);
  let raw;
  try {
    raw = fsDep.readFileSync(filePath, 'utf8');
  } catch {
    return { archived: false, reason: 'no-file' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { archived: false, reason: 'malformed' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { archived: false, reason: 'malformed' };
  }

  // Guard (b): re-entrancy — the file itself belongs to the caller's own session.
  if (
    typeof currentSessionId === 'string' && currentSessionId.length > 0 &&
    (parsed.session_id === currentSessionId || parsed.semantic_session_id === currentSessionId)
  ) {
    return { archived: false, reason: 'current-session' };
  }

  // Orphan predicate: when a (confirmed-dead) lock exists, the file must
  // reference IT to count as orphaned. Unrelated content is left alone.
  if (lock && !currentSessionReferencesLock(parsed, lock)) {
    return { archived: false, reason: 'not-orphaned' };
  }

  // Guard (c): fresh-preservation — protects a repo mid-bootstrap that wrote
  // current-session.json before its lock.
  const ageHours = currentSessionAgeHours(parsed, filePath, nowMs, fsDep);
  if (ageHours === null || ageHours < DEFAULT_TTL_HOURS) {
    return { archived: false, reason: 'fresh' };
  }

  if (dryRun) {
    return { archived: false, reason: 'candidate' };
  }

  try {
    return archiveCurrentSessionFile(repoRoot, filePath, parsed, nowMs, fsDep, currentSessionId);
  } catch (err) {
    return { archived: false, reason: `error: ${err?.message ?? String(err)}` };
  }
}

/**
 * Evaluate a single repo's lease and — under !dryRun — reap it if eligible.
 * As part of the SAME lease decision, also evaluates + (under !dryRun) sweeps
 * an orphaned `.orchestrator/current-session.json` (see evaluateCurrentSessionFile).
 * Every branch below attaches a `currentSession` field to its result; a
 * lock-side guard (live / lock-level re-entrancy / cross-host / pid-alive /
 * lock-changed-during-reap) short-circuits the file sweep with the SAME
 * reason, without even reading the file — the file is only actually
 * evaluated once the lock side is dead/absent/reap-eligible.
 *
 * Returns exactly one of:
 *   { action: 'none', repo, reason, currentSession }        — no lock present.
 *   { action: 'skipped', repo, reason, …, currentSession }  — protected by an invariant.
 *   { action: 'candidate', repo, …, currentSession }        — reap-eligible, dry-run (not touched).
 *   { action: 'reaped', repo, …, archivePath, currentSession } — reap-eligible, archived + emitted.
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
  const csArgs = { nowMs, dryRun, currentSessionId, fs: D.fs };

  let lock;
  try {
    lock = D.readLock({ repoRoot });
  } catch {
    lock = null;
  }
  if (!lock || typeof lock !== 'object') {
    // No lease at all — the current-session.json sweep is still eligible
    // (predicate branch 2: no lock exists, subject only to the freshness guard).
    const currentSession = evaluateCurrentSessionFile(repoRoot, { ...csArgs, lock: null });
    return { action: 'none', repo: repoRoot, reason: 'no-lock', currentSession };
  }

  // Invariant (a): a live lock (fresh heartbeat) is NEVER reaped — and the
  // current-session.json sweep is the SAME lease decision, so it is left
  // entirely untouched too (never even read).
  if (D.isLockLive(lock, nowMs)) {
    return {
      action: 'skipped',
      repo: repoRoot,
      reason: 'live',
      currentSession: { archived: false, reason: 'live' },
    };
  }

  // Re-entrancy guard: never reap the current session's own lease. Protects the
  // hook splice, where lock-bootstrap just wrote our fresh lock in the same run.
  if (
    currentSessionId &&
    (lock.session_id === currentSessionId || lock.semantic_session_id === currentSessionId)
  ) {
    return {
      action: 'skipped',
      repo: repoRoot,
      reason: 'current-session',
      currentSession: { archived: false, reason: 'current-session' },
    };
  }

  const ownHost = lock.host === D.hostname();

  // Invariant (c): cross-host leases are NEVER auto-reaped — only listed.
  if (!ownHost) {
    return {
      action: 'skipped',
      repo: repoRoot,
      reason: 'cross-host-requires-operator',
      host: lock.host ?? null,
      currentSession: { archived: false, reason: 'cross-host-requires-operator' },
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
    return {
      action: 'skipped',
      repo: repoRoot,
      reason: 'own-host-pid-alive',
      pid: lock.pid ?? null,
      currentSession: { archived: false, reason: 'own-host-pid-alive' },
    };
  }

  // Reap-eligible: own-host, dead lease (heartbeat past TTL), dead PID. The
  // current-session.json sweep is now eligible too — same lease decision.
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
    const currentSession = evaluateCurrentSessionFile(repoRoot, { ...csArgs, lock });
    return { action: 'candidate', ...base, currentSession };
  }

  // Apply: archive-move (invariant d) then best-effort event.
  let archiveResult;
  try {
    archiveResult = archiveLock(repoRoot, lockPathFor(repoRoot), lock, nowMs, D.fs, D);
  } catch (err) {
    // The lock predicate was already confirmed dead/eligible above — the file
    // sweep still runs; only the LOCK's own archive mechanics failed.
    const currentSession = evaluateCurrentSessionFile(repoRoot, { ...csArgs, lock });
    return { action: 'skipped', repo: repoRoot, reason: `error: ${err?.message ?? String(err)}`, currentSession };
  }
  if (!archiveResult.ok) {
    // Invariant (e) — the re-check found a changed/live lease. Never unlink.
    // A 'lock-changed-during-reap' means the TRUE state is no longer
    // dead/absent, so the file sweep must NOT proceed either — a fresh
    // session may already own both files.
    const currentSession = archiveResult.reason === 'lock-changed-during-reap'
      ? { archived: false, reason: 'lock-changed-during-reap' }
      : evaluateCurrentSessionFile(repoRoot, { ...csArgs, lock });
    return { action: 'skipped', repo: repoRoot, reason: archiveResult.reason, currentSession };
  }
  const archivePath = archiveResult.archivePath;

  const currentSession = evaluateCurrentSessionFile(repoRoot, { ...csArgs, lock });

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
        current_session: currentSession,
      },
      { filePath: path.join(repoRoot, EVENTS_RELPATH) },
    );
  } catch {
    // Observability is best-effort — the archive-move already succeeded.
  }

  return { action: 'reaped', ...base, archivePath, currentSession };
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
