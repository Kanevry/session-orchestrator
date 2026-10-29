/**
 * Where a ledger under `.orchestrator/` lives when its writer or reader runs
 * in a linked git worktree (#1722).
 *
 * A linked worktree has its own working tree, so `<worktree>/.orchestrator/
 * metrics/<x>.jsonl` is a different file from the main checkout's. Which one is
 * right depends on whether the repo versions the ledger:
 *
 *   - **gitignored** (this plugin repo, `.gitignore:57`): the worktree copy is
 *     lost when the worktree is removed, and every reader that maps to the main
 *     checkout never sees it. Measured 2026-10-22: `eval.jsonl` stranded in
 *     `_wt/session-orchestrator/so-66c`, `skill-invocations.jsonl` and
 *     `eval.jsonl` in `so-1e`. → the main checkout's copy.
 *   - **versioned** (27 fleet repos track `learnings`/`sessions`/… under
 *     `.orchestrator/metrics/`, counted 2026-10-21T23:06Z; the bootstrap
 *     template calls them durable project data): the worktree copy travels
 *     with the branch and reaches main through the merge. Writing the main
 *     checkout's copy instead would dirty another session's working tree and
 *     leave the branch without the record. → the worktree's own copy.
 *
 * `git check-ignore` (index-aware: a tracked file is never reported ignored)
 * decides between the two. It is spawned ONLY inside a linked worktree — a
 * plain checkout, a non-git dir and a test tmpdir resolve spawn-free to the
 * local path, as before — and memoised per process.
 *
 * Only a worktree's TOP LEVEL maps. A root below it (a caller's cwd in
 * `scripts/` or in an ignored `.orchestrator/tmp/…`) keeps the local path, as
 * before #1722: `git check-ignore` would answer for the ignored subdirectory,
 * not for the ledger, and the mapped path would land inside the main
 * checkout's copy of that subdirectory.
 *
 * Not used for `events.jsonl` and `sessions.jsonl`: those map unconditionally
 * through {@link resolveEventsLedgerRoot} (owner decision on #1514 point 1,
 * and #1584), versioned or not.
 *
 * Ceiling: a failed or timed-out `git check-ignore` (exit ≥ 128, no git, 2 s)
 * keeps the local path — the pre-#1722 behaviour, never a write into a foreign
 * working tree on an unmeasured answer. Revisit if a `*.jsonl` is found growing
 * inside a linked worktree of a repo that ignores it.
 *
 * @module scripts/lib/ledger-path
 */

import path from 'node:path';
import { dotGitAncestor, getProjectDir, resolveEventsLedgerRoot } from './platform.mjs';
import { spawnSync } from './native-command.mjs';

/** @type {Map<string, boolean>} `<root>\0<rel>` → ignored in that worktree */
const ignoredMemo = new Map();

/**
 * The `git` child must answer for `root`: an ambient `GIT_DIR` outranks `-C`
 * (see `scripts/lib/git-config-drift.mjs`), and a hook can run inside a git
 * hook that exports it.
 */
function gitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return env;
}

function isIgnoredIn(root, relPath) {
  const key = `${root}\0${relPath}`;
  if (ignoredMemo.has(key)) return ignoredMemo.get(key);
  const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', relPath], {
    env: gitEnv(),
    stdio: 'ignore',
    timeout: 2000,
  });
  const ignored = r.status === 0;
  ignoredMemo.set(key, ignored);
  return ignored;
}

/**
 * The repo root the ledger `relPath` lives under for a caller rooted at `root`:
 * the main checkout when `root` is a linked worktree that ignores the ledger,
 * else `root` itself (resolved). Path guards that require a target inside the
 * project validate against THIS root, so a mapped ledger passes and a path
 * outside it is still refused.
 *
 * @param {string} relPath  ledger path relative to the repo root
 * @param {string} [root]  repo root the caller works in; default {@link getProjectDir}
 * @returns {string}  absolute root
 */
export function resolveLedgerRoot(relPath, root) {
  const base = path.resolve(typeof root === 'string' && root.trim() !== '' ? root : getProjectDir());
  const mainRoot = resolveEventsLedgerRoot(base);
  if (mainRoot === base || dotGitAncestor(base) !== base) return base;
  return isIgnoredIn(base, relPath) ? mainRoot : base;
}

/**
 * Absolute path of the ledger `relPath` for a writer or reader rooted at `root`.
 *
 * @param {string} relPath  ledger path relative to the repo root, e.g.
 *   `.orchestrator/metrics/eval.jsonl`; an absolute path is returned unchanged
 *   (an explicit override stays exactly what the caller asked for)
 * @param {string} [root]  repo root the caller works in; default
 *   {@link getProjectDir} (the launch dir in a hook, the cwd's project in a CLI)
 * @returns {string}
 */
export function resolveLedgerPath(relPath, root) {
  if (path.isAbsolute(relPath)) return relPath;
  return path.join(resolveLedgerRoot(relPath, root), relPath);
}

/** Test seam: forget memoised `git check-ignore` answers. */
export function _resetLedgerPathMemo() {
  ignoredMemo.clear();
}
