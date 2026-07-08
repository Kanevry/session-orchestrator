/**
 * worktree-cleanup.mjs — Phase 4a Auto-Promoted Worktree Cleanup helpers (#575 P3.2).
 *
 * Public API:
 *   - detectAutoPromotedWorktree(repoRoot, sessionId, opts): { wtPath, sessionId, branch } | null
 *   - isWorktreeClean(wtPath, opts): boolean
 *     (opts.execFileFn — injectable execFileSync seam for tests; #577 HARDEN-001)
 *
 * Closes #575 — Epic #568 Phase 3.2 (Parallel-Aware Sessions Auto-Promoted Worktree Cleanup)
 * PRD: "Parallel-aware sessions" (#568; archived in the private Meta-Vault) §3 P3 Gherkin rows 2-3
 *
 * Lifted verbatim from skills/session-end/SKILL.md Phase 4a so that the helpers
 * are unit-testable and reusable (instruction-text → executable extraction).
 *
 * DI seam (#580-DI-001): this module uses a SYNCHRONOUS `opts.execFileFn`
 * (default `execFileSync`) because session-end Phase 4a runs in a synchronous
 * coordinator step. Its sibling helper `scripts/lib/memory-cleanup/worktree-sweep.mjs`
 * shares the same sync `execFileFn` seam; the autopilot worktree driver
 * (`scripts/lib/autopilot/worktree-pipeline.mjs`) deliberately uses an ASYNC
 * `opts.$` (zx) seam instead because `enterWorktree()` is async. The seams are
 * kept divergent on purpose — unifying them would break the sync/async boundary.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSessionId } from '../session-id.mjs';

/**
 * Detect whether the given repoRoot is an auto-promoted sibling worktree
 * created by `enterWorktree()` during the Phase 0.5 PROMOTION_OFFER path.
 *
 * Auto-promoted layout: <basePath>/<repo-name>-<sessionId>/
 *
 * Returns:
 *   { wtPath, sessionId, branch } on match
 *   null on non-match (UUID session, non-promoted path, or git error)
 *
 * @param {string} repoRoot - Absolute path to the candidate worktree
 * @param {string} sessionId - Session ID (semantic or UUID)
 * @returns {{wtPath: string, sessionId: string, branch: string} | null}
 */
export function detectAutoPromotedWorktree(repoRoot, sessionId, opts = {}) {
  // #577 HARDEN-001: execFileSync + args ARRAY (no shell) is structurally
  // injection-proof — repoRoot can never be interpreted as shell metacharacters.
  const execFileFn = opts.execFileFn ?? execFileSync;
  const parsed = parseSessionId(sessionId);
  if (!parsed || parsed.format !== 'semantic') return null; // UUID-format sessions are never auto-promoted

  // Derive the MAIN checkout root from `git worktree list --porcelain` (first entry).
  // Bug-fix (W3 T2 finding): the original logic compared `path.basename(repoRoot) === ${repoName}-${sessionId}`
  // where repoName WAS basename(repoRoot) itself — structurally impossible. The correct repo-name comes
  // from the main checkout (worktree list entry 0), not from the promoted worktree we're checking.
  let mainCheckoutRoot;
  try {
    const out = execFileFn('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    const lines = out.split('\n');
    const firstWorktreeLine = lines.find((l) => l.startsWith('worktree '));
    if (!firstWorktreeLine) return null;
    mainCheckoutRoot = firstWorktreeLine.slice('worktree '.length);
  } catch {
    return null; // not a git repo, treat as not promoted
  }

  // If repoRoot IS the main checkout, this session is NOT in an auto-promoted worktree.
  if (path.resolve(repoRoot) === path.resolve(mainCheckoutRoot)) return null;

  // Auto-promoted layout: <basePath>/<main-repo-name>-<sessionId>/
  // Where <basePath> = path.dirname(mainCheckoutRoot).
  const mainRepoName = path.basename(mainCheckoutRoot);
  const expectedBasename = `${mainRepoName}-${sessionId}`;
  const isPromotedPath = path.basename(repoRoot) === expectedBasename;

  if (isPromotedPath) {
    return { wtPath: repoRoot, sessionId, branch: parsed.branch };
  }
  return null;
}

/**
 * Determine whether the worktree at the given path is clean.
 *
 * A worktree is clean iff ALL three conditions hold:
 *   1. No uncommitted changes (`git status --porcelain` is empty)
 *   2. No untracked files (implicit in #1 — porcelain includes `??` entries)
 *   3. No unpushed commits (`git status --short --branch` lacks `ahead`)
 *
 * On any git error, returns `false` (safer per PSA-003 — conservative default
 * means we never auto-remove a worktree we couldn't verify).
 *
 * @param {string} wtPath - Absolute path to the worktree
 * @returns {boolean}
 */
export function isWorktreeClean(wtPath, opts = {}) {
  // #577 HARDEN-001: execFileSync + args ARRAY (no shell) — wtPath cannot inject.
  const execFileFn = opts.execFileFn ?? execFileSync;
  try {
    const status = execFileFn('git', ['-C', wtPath, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    if (status.trim().length > 0) return false; // dirty (modified, untracked, or staged)

    const branchStatus = execFileFn('git', ['-C', wtPath, 'status', '--short', '--branch'], {
      encoding: 'utf8',
    });
    if (branchStatus.match(/\bahead\b/)) return false; // unpushed

    return true;
  } catch {
    return false; // any error → treat as dirty (safer per PSA-003)
  }
}
