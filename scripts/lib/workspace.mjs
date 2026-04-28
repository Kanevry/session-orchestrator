/**
 * workspace.mjs — workspace resolution and path-validation helpers.
 *
 * Extracted from worktree.mjs (issue #287) so that workspace concerns
 * are separate from git worktree lifecycle operations.
 *
 * Contains:
 *  - resolveWorkspaceRoot   — canonical repo-root resolution via git + walk-up fallback
 *  - restoreCoordinatorCwd  — chdir guard: detects worktree drift and restores CWD
 *  - validatePathInWorkspace — path-containment check with worktree-subtree exclusion
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { $ } from 'zx';
import { listWorktrees } from './worktree.mjs';

// Do not spam stdout/stderr with git command echoes.
$.verbose = false;
$.quiet = true;

// ---------------------------------------------------------------------------
// resolveWorkspaceRoot
// ---------------------------------------------------------------------------

/**
 * Return the canonical workspace root path — the directory containing the main
 * .git/worktrees/ (i.e. the coordinator's tree), NOT any agent worktree.
 *
 * Resolution order:
 *   1. `git rev-parse --git-common-dir` → parent directory (this returns the
 *      SAME path whether called from the main tree or any worktree, unlike
 *      --show-toplevel which returns the current worktree's tree).
 *   2. Fallback: walk up from process.cwd() looking for `.git` (directory or file).
 *   3. If both fail → throw Error with message starting "resolveWorkspaceRoot:".
 *
 * Does NOT change process.cwd(). Pure resolution.
 *
 * @returns {Promise<string>} absolute path
 */
export async function resolveWorkspaceRoot() {
  const cwd = process.cwd();
  const git = $({ cwd });

  // Strategy 1: git rev-parse --git-common-dir
  try {
    const result = await git`git rev-parse --git-common-dir`;
    const commonDir = result.stdout.trim();
    if (commonDir) {
      // May be relative (when inside a linked worktree) or absolute.
      const absCommonDir = path.resolve(cwd, commonDir);
      return path.dirname(absCommonDir);
    }
  } catch {
    // Fall through to walk-up fallback.
  }

  // Strategy 2: walk up from cwd looking for .git (directory or worktree link file).
  let p = cwd;
  let levels = 0;
  while (levels < 20) {
    const gitEntry = path.join(p, '.git');
    if (fsSync.existsSync(gitEntry)) {
      // Check if .git is a file (worktree link) or a directory.
      try {
        const stat = await fs.stat(gitEntry);
        if (stat.isDirectory()) {
          return p;
        }
        // .git is a file — worktree link. Read it to find gitdir.
        const content = await fs.readFile(gitEntry, 'utf8');
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          // gitdir points to e.g. /repo/.git/worktrees/agent1
          // common dir would be /repo/.git — go up to /repo
          const gitdir = path.resolve(p, match[1].trim());
          // Walk up to find the real .git directory (not a worktrees subdir).
          let candidate = gitdir;
          while (path.dirname(candidate) !== candidate) {
            const base = path.basename(candidate);
            const parentBase = path.basename(path.dirname(candidate));
            if (base !== 'worktrees' && parentBase !== 'worktrees' && fsSync.existsSync(path.join(candidate, 'config'))) {
              return path.dirname(candidate);
            }
            candidate = path.dirname(candidate);
          }
        }
      } catch {
        // Could not stat or read — treat as found anyway.
        return p;
      }
    }
    const parent = path.dirname(p);
    if (parent === p) break; // filesystem root
    p = parent;
    levels++;
  }

  throw new Error(`resolveWorkspaceRoot: could not locate workspace root from '${cwd}'`);
}

// ---------------------------------------------------------------------------
// restoreCoordinatorCwd
// ---------------------------------------------------------------------------

/**
 * Check whether CWD is inside a worktree (anything under .git/worktrees/ or a
 * registered linked-worktree path), and if so, chdir back to the workspace root.
 *
 * Idempotent — when CWD already equals the workspace root, returns without
 * calling process.chdir().
 *
 * @returns {Promise<{restored: boolean, from: string|null, to: string}>}
 *   restored=true when chdir happened; from is the previous CWD (only when restored);
 *   to is always the workspace root.
 */
export async function restoreCoordinatorCwd() {
  const cwd = process.cwd();
  const root = await resolveWorkspaceRoot();

  // Normalize both for comparison (handles trailing slash differences, etc.)
  const normCwd = path.resolve(cwd);
  const normRoot = path.resolve(root);

  if (normCwd === normRoot) {
    return { restored: false, from: null, to: normRoot };
  }

  // Check if CWD is inside a worktree by listing registered worktrees.
  let insideWorktree = false;
  try {
    const worktrees = await listWorktrees();
    for (const wt of worktrees) {
      const wtResolved = path.resolve(wt.path);
      if (wtResolved === normRoot) continue; // skip main worktree
      // CWD is inside this linked worktree if it equals or is a descendant.
      const rel = path.relative(wtResolved, normCwd);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        insideWorktree = true;
        break;
      }
    }
  } catch {
    // If listing fails, fall back to checking if CWD differs from root.
    // Any divergence from root is treated as suspect when git-common-dir already
    // resolved to a different root, so we still restore.
    insideWorktree = true;
  }

  if (insideWorktree) {
    process.chdir(normRoot);
    return { restored: true, from: normCwd, to: normRoot };
  }

  return { restored: false, from: null, to: normRoot };
}

// ---------------------------------------------------------------------------
// validatePathInWorkspace
// ---------------------------------------------------------------------------

/**
 * Return true IFF filePath resolves to a location inside the workspace root AND
 * NOT inside any .claude/worktrees/* (or .codex/worktrees, .cursor/worktrees) subtree.
 *
 * Accepts absolute or relative paths. Relative paths resolve against process.cwd().
 * Does NOT touch the filesystem beyond reading the workspace root.
 *
 * @param {string} filePath
 * @param {string} [workspaceRoot] optional — if omitted, resolves via resolveWorkspaceRoot()
 * @returns {Promise<boolean>}
 */
export async function validatePathInWorkspace(filePath, workspaceRoot) {
  const root = workspaceRoot !== undefined ? workspaceRoot : await resolveWorkspaceRoot();
  const absRoot = path.resolve(root);
  const absFile = path.resolve(process.cwd(), filePath);

  // Must be inside workspace root (descendant — not equal to root itself).
  const relToRoot = path.relative(absRoot, absFile);
  const isInside = relToRoot !== '' && !relToRoot.startsWith('..') && !path.isAbsolute(relToRoot);
  if (!isInside) return false;

  // Normalize separator to forward-slash for cross-platform startsWith checks.
  const relNorm = relToRoot.split(path.sep).join('/');

  // Reject paths inside known worktree subtrees.
  const worktreeSubtrees = [
    '.claude/worktrees/',
    '.codex/worktrees/',
    '.cursor/worktrees/',
  ];
  for (const subtree of worktreeSubtrees) {
    if (relNorm.startsWith(subtree)) return false;
  }

  return true;
}
