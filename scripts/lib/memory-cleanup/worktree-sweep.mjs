/**
 * worktree-sweep.mjs — Stale auto-promoted worktree detection helpers.
 *
 * Implements Phase 4.5 of skills/memory-cleanup/SKILL.md (#575 P3.2):
 *   - listAutoPromotedWorktrees(repoRoot, mainCheckoutRoot)
 *   - isWorktreeStale(wtPath, staleBranchDays)
 *
 * Public API:
 *   - listAutoPromotedWorktrees(repoRoot, mainCheckoutRoot): Array<{wtPath, sessionId, branch}>
 *   - isWorktreeStale(wtPath, staleBranchDays): boolean
 *
 * PRD: docs/prd/2026-05-26-parallel-aware-sessions.md §3 P3 Gherkin row 4 + §3.A P3
 * Closes #575 P3.2
 */

import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { parseSessionId } from '../session-id.mjs';

/**
 * List all auto-promoted sibling worktrees for a given main checkout root.
 *
 * Auto-promoted worktrees follow the layout `<parentDir>/<repoName>-<sessionId>/`,
 * where `<sessionId>` is a semantic session-id (per `parseSessionId()` from
 * `scripts/lib/session-id.mjs`). Random-suffix worktrees (UUID-format) are NOT
 * auto-promoted and are excluded.
 *
 * @param {string} repoRoot - Current working directory (used as context; not directly
 *   passed to git — mainCheckoutRoot is used for git worktree list).
 * @param {string} mainCheckoutRoot - Absolute path to the main checkout (the primary
 *   worktree). This is the anchor from which sibling worktrees are resolved.
 * @param {object} [opts] - Optional dependency injection for testing.
 * @param {Function} [opts.execSyncFn] - Override for execSync (default: node:child_process execSync).
 * @returns {Array<{wtPath: string, sessionId: string, branch: string}>}
 *   Array of matching auto-promoted worktrees. Empty array on error or no candidates.
 */
export function listAutoPromotedWorktrees(repoRoot, mainCheckoutRoot, opts = {}) {
  const execSyncFn = opts.execSyncFn ?? execSync;
  const repoName = path.basename(mainCheckoutRoot);
  const candidates = [];

  try {
    const out = execSyncFn(`git -C ${mainCheckoutRoot} worktree list --porcelain`, {
      encoding: 'utf8',
    });
    const entries = out.split('\n\n').filter(Boolean);

    for (const entry of entries) {
      const wtMatch = entry.match(/^worktree (.+)$/m);
      if (!wtMatch) continue;
      const wtPath = wtMatch[1];

      // Skip the main checkout itself
      if (wtPath === mainCheckoutRoot) continue;

      // Match auto-promoted layout: <parentDir>/<repoName>-<sessionId>
      const basename = path.basename(wtPath);
      if (!basename.startsWith(`${repoName}-`)) continue;
      const sessionIdCandidate = basename.slice(repoName.length + 1);

      // Verify it's a semantic session-id (not a random suffix or UUID)
      const parsed = parseSessionId(sessionIdCandidate);
      if (!parsed || parsed.format !== 'semantic') continue;

      candidates.push({ wtPath, sessionId: sessionIdCandidate, branch: parsed.branch });
    }
  } catch {
    // git failure or any other error → return no candidates (conservative no-op)
    return [];
  }

  return candidates;
}

/**
 * Determine whether a worktree directory is stale based on its mtime.
 *
 * A worktree is stale iff `mtime(wtPath) < now - staleBranchDays × 86400 × 1000`.
 *
 * @param {string} wtPath - Absolute path to the worktree directory.
 * @param {number} staleBranchDays - Staleness threshold in days (from Session Config,
 *   default 7). A worktree older than this many days is considered stale.
 * @returns {boolean} `true` if the worktree exists and its mtime is older than the
 *   threshold; `false` if the path does not exist, is unreadable, or is within the
 *   threshold. Conservative no-op: missing paths return `false`.
 */
export function isWorktreeStale(wtPath, staleBranchDays) {
  try {
    const stat = statSync(wtPath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > staleBranchDays * 24 * 60 * 60 * 1000;
  } catch {
    // Missing or unreadable → conservative no-op
    return false;
  }
}
