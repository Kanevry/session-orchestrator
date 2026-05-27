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
import { writeJsonAtomicSync } from '../../scripts/lib/io.mjs';

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
    // quiet: true suppresses the unknown-mode stderr WARN in acquire() (#592 MED-2).
    // The hook is informational-only and tests assert stderr is empty.
    acquireResult = acquireFn({ sessionId, mode, ttlHours, repoRoot, quiet: true });
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
    // semantic_session_id is ALWAYS the semantic form, even when session_id is
    // a UUID-v4 (closes D4 #587). Fallback to mirroring session_id if no
    // semantic was provided.
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
