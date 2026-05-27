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
 *     session_id:           string,  // semantic OR UUID — whatever resolveSessionId returned
 *     semantic_session_id:  string,  // ALWAYS the semantic form (closes D4)
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
import crypto from 'node:crypto';

/**
 * Bootstrap the session.lock for this hook invocation.
 *
 * Best-effort: every internal failure is swallowed, the helper returns null
 * instead of throwing. Callers (the SessionStart hook) wrap this in a
 * try/catch anyway, but the helper itself never propagates.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot — absolute path to the repository root.
 * @param {string} opts.sessionId — the resolved session id (semantic OR UUID).
 * @param {string} [opts.semanticSessionId] — the semantic form, ALWAYS surfaced
 *   even when sessionId is a UUID (closes D4 issue #587). When omitted, the
 *   field is populated by mirroring sessionId.
 * @param {string} opts.mode — session mode (e.g. "deep", "feature").
 * @param {number} [opts.ttlHours=4] — lock TTL in hours.
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
  _acquireImpl,
  _forceAcquireImpl,
  _emitEventImpl,
} = {}) {
  // Sanity-check required inputs. Anything missing → bail silently.
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof mode !== 'string' || mode.length === 0) return null;

  // Normalize mode to a value known by exclusivity-matrix.mjs so acquire()
  // does not emit a stderr WARN. Hook is informational-only and MUST NOT
  // pollute stderr (existing tests in tests/hooks/on-session-start.test.mjs
  // assert stderr is empty on register-failure paths). The actual mode is
  // still preserved on the lock body via the rawMode passed in — only the
  // mode handed to acquire() is normalized.
  const lockMode = mapToKnownMode(mode);

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
  // If a stale-PID-dead/-alive lock exists, force-overwrite it (the prior
  // session has died; we own the worktree now).
  // If the existing lock has the same sessionId, force-overwrite so the
  // last_heartbeat gets refreshed.
  let acquireResult;
  try {
    acquireResult = acquireFn({ sessionId, mode: lockMode, ttlHours, repoRoot });
  } catch {
    return null;
  }

  if (!acquireResult || typeof acquireResult !== 'object') return null;

  const shouldForce =
    acquireResult.ok !== true && (
      acquireResult.reason === 'stale-pid-dead' ||
      acquireResult.reason === 'stale-pid-alive' ||
      (acquireResult.reason === 'active' &&
        acquireResult.existingLock &&
        acquireResult.existingLock.session_id === sessionId)
    );

  if (!acquireResult.ok && shouldForce) {
    try {
      acquireResult = forceAcquireFn({ sessionId, mode: lockMode, ttlHours, repoRoot });
    } catch {
      return null;
    }
  }

  // Any other non-ok reason (parallel-conflict, fs-error, other-session-active)
  // → bail without enriching. The hook stays non-blocking.
  if (!acquireResult || acquireResult.ok !== true) return null;

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
    // semantic_session_id is ALWAYS the semantic form, even when session_id is
    // a UUID-v4 (closes D4 #587). Fallback to mirroring session_id if no
    // semantic was provided.
    semantic_session_id:
      typeof semanticSessionId === 'string' && semanticSessionId.length > 0
        ? semanticSessionId
        : (typeof baseLock.session_id === 'string' ? baseLock.session_id : sessionId),
  };

  try {
    writeJsonAtomic(lockFile, enriched);
  } catch {
    // Failed to overwrite — base lock is still on disk, so we degrade
    // gracefully. Return null so the caller logs no spurious success.
    return null;
  }

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
 * Map an arbitrary mode string to a value known by exclusivity-matrix.mjs.
 *
 * Why: acquire() in scripts/lib/session-lock.mjs emits a `console.warn` to
 * stderr when it encounters an unknown mode (catch on classifyMode throw).
 * The SessionStart hook is informational-only and existing tests assert
 * `result.stderr === ''` — see tests/hooks/on-session-start.test.mjs
 * `register-failed observability breadcrumb > does not write to stderr`.
 *
 * Strategy: pass-through any mode the matrix already knows; for unknowns,
 * default to "feature" (parallel-ok) which is the safest catch-all — it
 * matches `/session` (no explicit subtype) and `/session deep` semantics
 * without claiming exclusivity. Operators who actually run `/housekeeping`
 * or `/memory-cleanup` will have the exact mode propagated upstream by the
 * skill before any session-end action takes effect.
 *
 * Documented modes (cross-reference exclusivity-matrix.mjs):
 *   exclusive    — bootstrap, housekeeping, memory-cleanup
 *   parallel-ok  — deep, feature
 *   always-ok    — discovery, evolve, plan, repo-audit, portfolio
 *
 * @param {string} rawMode
 * @returns {string} a mode name known to classifyMode().
 */
function mapToKnownMode(rawMode) {
  const KNOWN = new Set([
    'bootstrap', 'housekeeping', 'memory-cleanup',
    'deep', 'feature',
    'discovery', 'evolve', 'plan', 'repo-audit', 'portfolio',
  ]);
  const m = String(rawMode).trim().toLowerCase();
  if (KNOWN.has(m)) return m;
  return 'feature';
}

/**
 * Atomic JSON write via tmp file + rename. Mirrors the helper used by
 * scripts/lib/session-lock.mjs:writeLockAtomic — we duplicate the pattern
 * here rather than importing the private function to keep the helper
 * dependency-light and to avoid coupling to an internal symbol.
 *
 * @param {string} target — absolute path to write.
 * @param {object} obj — JSON-serializable body.
 */
function writeJsonAtomic(target, obj) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmpSuffix = crypto.randomBytes(6).toString('hex');
  const tmpFile = path.join(dir, `.session.lock.boot.tmp.${tmpSuffix}`);
  fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8' });
  fs.renameSync(tmpFile, target);
}
