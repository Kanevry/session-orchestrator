/**
 * session-discovery.mjs — discover active sessions across all worktrees.
 *
 * Purpose: enumerate all active Claude sessions in the repo's worktree set
 * (P1.1 of the Parallel-Aware Sessions Epic #568, Issue #569).
 *
 * Cross-host policy:
 *   - Same-host + alive PID  → INCLUDE. Same-host + dead PID → EXCLUDE (stale).
 *   - Cross-host + any PID   → INCLUDE (liveness unverifiable across machines).
 *   - TTL expiry alone does NOT exclude — PRD §3 filters on dead PID, not TTL.
 *
 * Timeout + A1 fallback:
 *   - listWorktrees() is raced against DEFAULT_DISCOVERY_TIMEOUT_MS (2 s).
 *   - On timeout or throw → falls back to reading only the local session.lock.
 *   - Timer uses .unref() so it never keeps the Node event loop alive.
 *   - Stderr WARN: `[session-discovery] WARN: <reason> — falling back to single-worktree mode`
 *
 * DI hooks (for tests): opts.listWorktreesImpl, opts.timeoutMs.
 */

import os from 'node:os';
import { listWorktrees } from './worktree/listing.mjs';
import { readLock, isPidAlive } from './session-lock.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout in milliseconds for the listWorktrees race. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * A1 fallback — read only the local repoRoot's session.lock (0-or-1 result).
 * `branch` is left empty; callers treat it as "unknown — A1 fallback active".
 *
 * @param {string} repoRoot
 * @returns {Array<{worktreePath:string,sessionId:string,mode:string,startedAt:string,pid:number,host:string,branch:string}>}
 */
function readLocalSession(repoRoot) {
  const lock = readLock({ repoRoot });
  if (lock === null) return [];

  const sameHost = lock.host === os.hostname();
  if (sameHost && isPidAlive(lock.pid) === false) return [];

  return [{
    worktreePath: repoRoot,
    sessionId:    lock.session_id,
    mode:         lock.mode,
    startedAt:    lock.started_at,
    pid:          lock.pid,
    host:         lock.host,
    branch:       '',
  }];
}

// ---------------------------------------------------------------------------
// discoverActiveSessions
// ---------------------------------------------------------------------------

/**
 * Discover all active sessions across the repository's worktree set.
 *
 * Applies the cross-host decision table per worktree lock. On listWorktrees()
 * failure or timeout, falls back to A1 single-worktree mode and emits a WARN
 * to stderr.
 *
 * @param {string} repoRoot  Absolute path to the main repository root.
 * @param {object} [opts]
 * @param {number}   [opts.timeoutMs=2000]      Race timeout (ms). Default DEFAULT_DISCOVERY_TIMEOUT_MS.
 * @param {Function} [opts.listWorktreesImpl]   DI hook replacing listWorktrees() for tests.
 * @returns {Promise<Array<{worktreePath:string,sessionId:string,mode:string,startedAt:string,pid:number,host:string,branch:string}>>}
 */
export async function discoverActiveSessions(repoRoot, opts = {}) {
  const listWorktreesFn = opts.listWorktreesImpl ?? listWorktrees;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;

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

  const sessions = [];

  for (const worktree of worktrees) {
    // Read the lock for this worktree (returns null if absent or malformed).
    const lock = readLock({ repoRoot: worktree.path });

    // No lock → no session in this worktree.
    if (lock === null) {
      continue;
    }

    // Apply cross-host decision table.
    const sameHost = lock.host === os.hostname();
    if (sameHost && isPidAlive(lock.pid) === false) {
      // Same-host, confirmed dead PID — exclude (stale lock, not an active session).
      continue;
    }

    // INCLUDE: either same-host with live PID, or cross-host (unverifiable).
    sessions.push({
      worktreePath: worktree.path,
      sessionId:    lock.session_id,
      mode:         lock.mode,
      startedAt:    lock.started_at,
      pid:          lock.pid,
      host:         lock.host,
      branch:       worktree.branch,
    });
  }

  return sessions;
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
