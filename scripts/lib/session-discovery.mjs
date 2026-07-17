/**
 * session-discovery.mjs — discover active sessions across all worktrees.
 *
 * Purpose: enumerate all active Claude sessions in the repo's worktree set
 * (P1.1 of the Parallel-Aware Sessions Epic #568, Issue #569).
 *
 * Liveness rule (Epic #583, W2-I3 — REPLACES PID-liveness):
 *   - A lock is "live" when (now - last_heartbeat) < ttl_hours.
 *   - PID-liveness is no longer the discovery-time filter; the writer-process
 *     PID is the *hook* PID, not the session PID, so PID-liveness incorrectly
 *     filtered out locks whose semantic owner (Claude harness) was still
 *     alive (D2 defect from Epic #583 audit).
 *   - `isPidAliveOnHost` is preserved in session-lock.mjs as a forensic helper
 *     but is not called from the discovery decision tree.
 *   - #799 evaluated (2026-07-17): dead-PID stale-marking for source=discovered
 *     registry entries is an explicit NO-GO — the recorded PID is the ephemeral
 *     hook-subprocess PID (see above), so a same-host dead-PID filter would
 *     misclassify nearly every entry as stale seconds after write; even a
 *     corroborating PID *label* adds zero detection power over heartbeat
 *     freshness (it could only ever annotate entries the heartbeat gate has
 *     already excluded). Do not re-attempt without new evidence.
 *
 * Cross-host policy:
 *   - Same-host: heartbeat freshness rules.
 *   - Cross-host: heartbeat freshness rules (PID-liveness was already skipped
 *     across hosts; nothing changes here).
 *
 * Registry fallback (Epic #583, W2-I3 — Merged Source-of-Truth):
 *   - When a worktree's lock is null OR not live, the discovery path consults
 *     the host registry as a fallback. Entries matching the current repo's
 *     `repo_path_hash` and within `freshnessMin` are merged into the result.
 *   - Lock takes precedence over registry (more detail per session); registry
 *     supplements missing per-worktree entries (e.g., when the hook ran but
 *     the prose Phase 1.2 acquire was skipped).
 *
 * Timeout + A1 fallback:
 *   - listWorktrees() is raced against DEFAULT_DISCOVERY_TIMEOUT_MS (2 s).
 *   - On timeout or throw → falls back to reading only the local session.lock.
 *   - Timer uses .unref() so it never keeps the Node event loop alive.
 *   - Stderr WARN: `[session-discovery] WARN: <reason> — falling back to single-worktree mode`
 *
 * DI hooks (for tests): opts.listWorktreesImpl, opts.timeoutMs, opts.registryReader.
 */

import os from 'node:os';
import { listWorktrees } from './worktree/listing.mjs';
import { readLock, isLockLive } from './session-lock.mjs';
import { readRegistry, repoPathHash, isRegistryEntryFresh } from './session-registry.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout in milliseconds for the listWorktrees race. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Convert a lock object + worktree path/branch into the session-shape that
 * discoverActiveSessions returns. Centralised so the in-tree + fallback paths
 * emit identical shapes.
 *
 * @param {object} lock          Parsed lock body (schema v2).
 * @param {string} worktreePath  Absolute worktree path.
 * @param {string} [branch]      Branch from worktree object (falsy → '').
 * @returns {{worktreePath:string,sessionId:string,mode:string,startedAt:string,pid:number,host:string,branch:string}}
 */
function sessionFromLock(lock, worktreePath, branch = '') {
  return {
    worktreePath,
    sessionId:    lock.session_id,
    mode:         lock.mode,
    startedAt:    lock.started_at,
    pid:          lock.pid,
    host:         lock.host,
    branch:       typeof branch === 'string' ? branch : '',
  };
}

/**
 * Convert a registry entry into the same session-shape. `worktreePath` is set
 * to the repoRoot under which the discovery is running, since the registry
 * does not record per-worktree paths — only repo-path-hashes. Branch is
 * passed through from the registry entry when available.
 *
 * @param {object} entry    Registry entry.
 * @param {string} repoRoot Discovery repoRoot (used as worktreePath fallback).
 */
function sessionFromRegistryEntry(entry, repoRoot) {
  return {
    worktreePath: repoRoot,
    sessionId:    entry.session_id,
    mode:         typeof entry.mode === 'string' ? entry.mode : 'session',
    startedAt:    entry.started_at,
    pid:          typeof entry.pid === 'number' ? entry.pid : 0,
    // Registry entries do not currently record `host` (hostname); use the
    // local hostname as the default since registry entries are host-scoped
    // by design (see ~/.config/session-orchestrator/sessions/).
    host:         os.hostname(),
    branch:       typeof entry.branch === 'string' ? entry.branch : '',
  };
}

/**
 * A1 fallback — read only the local repoRoot's session.lock (0-or-1 result).
 * `branch` is left empty; callers treat it as "unknown — A1 fallback active".
 *
 * Liveness rule: heartbeat freshness via isLockLive (Epic #583, W2-I3).
 *
 * @param {string} repoRoot
 * @returns {Array<{worktreePath:string,sessionId:string,mode:string,startedAt:string,pid:number,host:string,branch:string}>}
 */
function readLocalSession(repoRoot) {
  const lock = readLock({ repoRoot });
  if (lock === null) return [];
  if (!isLockLive(lock)) return [];
  return [sessionFromLock(lock, repoRoot, '')];
}

/**
 * Deduplicate a session list by sessionId, preferring earlier entries. The
 * discovery path constructs the result with lock-sourced entries first
 * (which carry more detail — exact worktreePath, branch from git) and
 * appends registry-sourced entries; this dedupe keeps the lock-sourced one.
 *
 * @param {Array<{sessionId:string}>} sessions
 * @returns {Array<{sessionId:string}>}
 */
function dedupeBySessionId(sessions) {
  const seen = new Set();
  const out = [];
  for (const s of sessions) {
    if (seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// discoverActiveSessions
// ---------------------------------------------------------------------------

/**
 * Discover all active sessions across the repository's worktree set.
 *
 * Liveness rule (Epic #583, W2-I3): heartbeat-based — `isLockLive(lock)`
 * returns true when `(now - last_heartbeat) < ttl_hours`. Replaces the
 * previous PID-liveness rule which incorrectly filtered out locks whose
 * writer-process (hook PID) had exited.
 *
 * Registry fallback: after iterating worktree locks, registry entries with
 * matching `repo_path_hash` that pass `isRegistryEntryFresh()` are merged
 * into the result. Lock entries take precedence (they carry per-worktree
 * detail); registry entries supplement when locks are absent or stale.
 *
 * On listWorktrees() failure or timeout, falls back to A1 single-worktree
 * mode and emits a WARN to stderr.
 *
 * @param {string} repoRoot  Absolute path to the main repository root.
 * @param {object} [opts]
 * @param {number}   [opts.timeoutMs=2000]      Race timeout (ms). Default DEFAULT_DISCOVERY_TIMEOUT_MS.
 * @param {Function} [opts.listWorktreesImpl]   DI hook replacing listWorktrees() for tests.
 * @param {Function} [opts.registryReader]      DI hook replacing readRegistry() for tests.
 * @param {number}   [opts.freshnessMin=15]     Registry-entry freshness threshold in minutes.
 * @param {number}   [opts.now]                 ms-since-epoch (test seam for heartbeat freshness).
 * @returns {Promise<Array<{worktreePath:string,sessionId:string,mode:string,startedAt:string,pid:number,host:string,branch:string}>>}
 */
export async function discoverActiveSessions(repoRoot, opts = {}) {
  const listWorktreesFn = opts.listWorktreesImpl ?? listWorktrees;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const registryReaderFn = opts.registryReader ?? readRegistry;
  const freshnessMin = typeof opts.freshnessMin === 'number' ? opts.freshnessMin : 15;
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();

  let worktrees;
  try {
    worktrees = await Promise.race([
      listWorktreesFn(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch (err) {
    // Either listWorktrees threw, or our timeout fired. Either way: A1 fallback.
    const reason = err.message === 'timeout'
      ? `git worktree list timed out at ${timeoutMs}ms`
      : `git worktree list failed: ${err.message}`;
    process.stderr.write(`[session-discovery] WARN: ${reason} — falling back to single-worktree mode\n`);
    return readLocalSession(repoRoot);
  }

  const lockSessions = [];

  for (const worktree of worktrees) {
    // Read the lock for this worktree (returns null if absent or malformed).
    const lock = readLock({ repoRoot: worktree.path });

    // No lock → no session in this worktree (registry fallback handled below).
    if (lock === null) {
      continue;
    }

    // Liveness rule (Epic #583, W2-I3): heartbeat freshness, not PID-liveness.
    if (!isLockLive(lock, nowMs)) {
      // Stale by heartbeat — exclude. (Registry fallback may still recover the
      // session id if the registry entry is fresh.)
      continue;
    }

    lockSessions.push(sessionFromLock(lock, worktree.path, worktree.branch));
  }

  // Registry fallback (Merged Source-of-Truth, Epic #583, W2-I3).
  // Filter to entries that (a) match this repo's repo_path_hash and (b) pass
  // the freshness gate. Failures are swallowed — registry is advisory.
  let registrySessions;
  try {
    const allEntries = await registryReaderFn();
    const myRepoHash = repoPathHash(repoRoot);
    registrySessions = allEntries
      .filter((e) => e && e.repo_path_hash === myRepoHash)
      .filter((e) => isRegistryEntryFresh(e, { freshnessMin, now: nowMs }))
      .map((e) => sessionFromRegistryEntry(e, repoRoot));
  } catch {
    // Registry read failure → keep going with lock-only results.
    registrySessions = [];
  }

  // Merge: lock-sourced first (more detail), then registry. Dedupe by
  // sessionId so a session that has both a lock and a registry entry only
  // appears once with the richer lock detail.
  return dedupeBySessionId([...lockSessions, ...registrySessions]);
}

// ---------------------------------------------------------------------------
// findWorktrees
// ---------------------------------------------------------------------------

/**
 * Thin namespace-cohesion wrapper around listWorktrees().
 *
 * The `repoRoot` parameter is reserved for future per-worktree filtering
 * (Issue #569 P1.2) and is currently passed through without effect.
 *
 * @param {string} _repoRoot  Absolute path to the main repository root (reserved).
 * @returns {Promise<Array<{path: string, branch: string, head: string}>>}
 *   Same shape as listWorktrees(); empty array on git failure.
 */
export async function findWorktrees(_repoRoot) {
  return listWorktrees();
}
