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
 * PRD: "Parallel-aware sessions" (#568; archived in the private Meta-Vault) §3 P3 Gherkin row 4 + §3.A P3
 * Closes #575 P3.2
 *
 * DI seam (#580-DI-001): this module uses a SYNCHRONOUS `opts.execFileFn`
 * (default `execFileSync`) because the memory-cleanup Phase 4.5 sweep runs in a
 * synchronous coordinator step. Its sibling helper
 * `scripts/lib/session-end/worktree-cleanup.mjs` shares the same sync
 * `execFileFn` seam; the autopilot worktree driver
 * (`scripts/lib/autopilot/worktree-pipeline.mjs`) deliberately uses an ASYNC
 * `opts.$` (zx) seam instead because `enterWorktree()` is async. The seams are
 * kept divergent on purpose — unifying them would break the sync/async boundary.
 */

import { execFileSync } from 'node:child_process';
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
 * @param {Function} [opts.execFileFn] - Override for execFileSync (default: node:child_process execFileSync).
 *   Signature: (file: string, args: string[], options) => string.
 * @returns {Array<{wtPath: string, sessionId: string, branch: string}>}
 *   Array of matching auto-promoted worktrees. Empty array on error or no candidates.
 */
export function listAutoPromotedWorktrees(repoRoot, mainCheckoutRoot, opts = {}) {
  // #577 HARDEN-001: execFileSync + args ARRAY (no shell) — mainCheckoutRoot cannot inject.
  const execFileFn = opts.execFileFn ?? execFileSync;
  const repoName = path.basename(mainCheckoutRoot);
  const candidates = [];

  try {
    const out = execFileFn('git', ['-C', mainCheckoutRoot, 'worktree', 'list', '--porcelain'], {
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
