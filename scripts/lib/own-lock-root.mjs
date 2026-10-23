/**
 * own-lock-root.mjs — the checkout whose `.orchestrator/session.lock` carries a
 * given RAW session id, for scripts that run outside a hook (#1730).
 *
 * A hook knows its session from the payload and asks `resolveOwnLockRoot`
 * (`hooks/_lib/hook-root.mjs`). A script run by the coordinator does not: it
 * gets a `cwd`, and the cwd is often the wrong tree. A session that works in a
 * linked worktree by `cd` keeps its lock in the main checkout; one that took its
 * lock in a worktree runs Bash from the main checkout, because the shell cwd
 * resets there. Reading at `process.cwd()` then answers "no lock" (#1730 Pkt 1:
 * `/close` released nothing and exited 0) or "no agents" (Pkt 2: the HUD).
 *
 * Candidates, in order; the first whose lock carries the id wins:
 *   1. `registry`      — the host registry entry's `session_root`, via the
 *                        hook readers' own `resolveOwnLockRoot`;
 *   2. `cwd`           — the checkout holding `cwd`;
 *   3. `main-checkout` — the main checkout of that repository;
 *   4. `worktree`      — a registered linked worktree of it (`registeredWorktreeRoots`).
 * No candidate → `{ root: <checkout of cwd>, source: 'none' }`: the pre-#1730
 * answer, so a caller that found nothing behaves as it did before.
 *
 * Only a lock that carries the id counts. A registry pointer, a STATE.md or a
 * `current-session.json` alone proves nothing: they can name a peer.
 *
 * Spawn-free (fs reads only), never throws.
 *
 * Exports: resolveOwnLockRootFor, registrySessionRoot.
 */

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { resolveOwnLockRoot } from '../../hooks/_lib/hook-root.mjs';
import { dotGitAncestor, registeredWorktreeRoots, resolveEventsLedgerRoot } from './platform.mjs';
import { activeDir } from './session-registry.mjs';
import { readLockDetailed } from './session-lock.mjs';
import { parseSessionId } from './session-id.mjs';

/** @param {string} root @param {string} id */
function lockCarries(root, id) {
  const detail = readLockDetailed({ repoRoot: root });
  return detail.status === 'ok' && detail.lock.session_id === id;
}

/** @param {string} p */
function canonical(p) {
  try { return realpathSync.native(p); } catch { return path.resolve(p); }
}

/**
 * `session_root` of the host registry entry of `id`, or `null` when there is
 * no entry, it cannot be read, or the value is no absolute path. A pointer
 * only — the caller decides whether a lock there belongs to `id`.
 *
 * @param {string} id  raw session id (UUID)
 * @returns {string|null}
 */
export function registrySessionRoot(id) {
  if (parseSessionId(id)?.format !== 'uuid') return null;
  try {
    const entry = JSON.parse(readFileSync(path.join(activeDir(), `${id}.json`), 'utf8'));
    const root = entry?.session_root;
    return typeof root === 'string' && path.isAbsolute(root) ? root : null;
  } catch { return null; }
}

/**
 * Where THIS session's lock is (see the module doc for the candidate order).
 *
 * @param {{ sessionId?: string|null, cwd?: string }} [opts]
 * @returns {{ root: string, source: 'registry'|'cwd'|'main-checkout'|'worktree'|'none' }}
 */
export function resolveOwnLockRootFor({ sessionId = null, cwd = process.cwd() } = {}) {
  const dir = path.resolve(typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd());
  const top = dotGitAncestor(dir) || dir;
  if (parseSessionId(sessionId)?.format !== 'uuid') return { root: top, source: 'none' };

  const viaHook = resolveOwnLockRoot({ session_id: sessionId, cwd: dir }, top);
  if (lockCarries(viaHook, sessionId)) {
    return { root: viaHook, source: canonical(viaHook) === canonical(top) ? 'cwd' : 'registry' };
  }

  const main = resolveEventsLedgerRoot(top);
  if (canonical(main) !== canonical(top) && lockCarries(main, sessionId)) {
    return { root: main, source: 'main-checkout' };
  }

  // Sorted, so two linked worktrees that both carry the id (an anomaly: one
  // raw session, two locks) always resolve to the same one.
  const { roots } = registeredWorktreeRoots(canonical(path.join(main, '.git')));
  for (const root of roots.sort()) {
    if (canonical(root) !== canonical(top) && lockCarries(root, sessionId)) return { root, source: 'worktree' };
  }
  return { root: top, source: 'none' };
}
