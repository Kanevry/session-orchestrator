/**
 * worktree-orphan-sweep.mjs — Phase 4b Worktree-Orphan Sweep (#831 / B5).
 *
 * Identifies worktree branches with 0 commits ahead of the base branch —
 * orphans left behind by finished sessions — and returns them as DATA.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THE IRON RULE: this module PROPOSES, it never DISPOSES.               │
 * │ It executes ZERO mutating commands — no `git worktree remove`, no     │
 * │ `git worktree prune`, no `git branch -d/-D`, no `git push --delete`,  │
 * │ no rm/rmSync/unlinkSync, no reset/clean/checkout --/stash. The only   │
 * │ two git invocations it makes are read-only: `worktree list            │
 * │ --porcelain` and `rev-list --count`.                                  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Grounding: `.claude/rules/parallel-sessions.md` § PSA-003 ("Never Destroy
 * What You Didn't Create") — the test is *"Did I create this file/commit/
 * change? If not, it is not mine to touch."* A sweep probe created none of the
 * worktrees it inspects, so removal is categorically not its call. The return
 * field is deliberately named `candidates` (not `orphans`, not `toDelete`, not
 * `removals`): the name itself encodes "the coordinator decides". The operator
 * AUQ is rendered by the coordinator at session-end Phase 4b, never here.
 *
 * CONSERVATIVE DEFAULT (safety-critical): any git error, unparseable output,
 * detached HEAD, unresolvable branch, or ambiguity of any kind → the worktree
 * is NOT reported as a candidate. Silence must never be read as "safe to
 * delete". Precedent: `isWorktreeClean()` in ./worktree-cleanup.mjs returns
 * false on any git error, documented as "conservative PSA-003 default: never
 * auto-remove a worktree we could not verify".
 *
 * Banner contract: mirrors the other `checkXxx()` probes
 * (`scripts/lib/peer-cards/staleness-banner.mjs`,
 * `scripts/lib/vault-staleness-banner.mjs`) — a single entry point returning
 * `null` (silent no-op) or one `{ severity, message, ... }` object. Never an
 * array, never `undefined`, never a throw.
 *
 * DI seam (#580-DI-001): SYNCHRONOUS `execFileFn` (default `execFileSync`),
 * matching its Phase 4a sibling ./worktree-cleanup.mjs and
 * scripts/lib/memory-cleanup/worktree-sweep.mjs, because session-end Phase 4b
 * runs in a synchronous coordinator step. The autopilot worktree driver
 * (scripts/lib/autopilot/worktree-pipeline.mjs) deliberately uses an ASYNC
 * `opts.$` (zx) seam instead; the seams are kept divergent on purpose —
 * unifying them would break the sync/async boundary.
 *
 * #577 HARDEN-001: every git call is `execFileFn('git', [args…])` with an args
 * ARRAY and no shell. Branch and path values are attacker-influenceable and are
 * never interpolated into a shell string.
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Strip a `<mainRepoName>-` prefix from a worktree directory basename to
 * recover the session id, mirroring the auto-promoted layout
 * `<basePath>/<repo-name>-<sessionId>/` used by `enterWorktree()`.
 *
 * Falls back to the full basename when the prefix does not match — a worktree
 * created by hand still deserves a stable identifier in the report.
 *
 * @param {string} wtPath
 * @param {string} mainRepoName
 * @returns {string}
 */
function deriveSessionId(wtPath, mainRepoName) {
  const basename = path.basename(wtPath);
  if (mainRepoName && basename.startsWith(`${mainRepoName}-`)) {
    return basename.slice(mainRepoName.length + 1);
  }
  return basename;
}

/**
 * Sweep for worktree branches with 0 commits ahead of the base branch.
 *
 * @param {object} [opts]
 * @param {string} opts.repoRoot - REQUIRED absolute path to the repo root.
 * @param {string} [opts.mainCheckoutRoot] - Absolute path to the main checkout.
 *   When omitted it is derived from the FIRST `worktree ` line of the porcelain
 *   output. (`path.basename(repoRoot)` is explicitly NOT a correct derivation —
 *   see the W3 T2 finding documented in ./worktree-cleanup.mjs.)
 * @param {object} [opts.config] - Parsed `worktree-orphans` config block:
 *   `{ enabled, 'base-branch', mode }`.
 * @param {Function} [opts.execFileFn] - Injectable execFileSync seam for tests.
 *   Signature: (file: string, args: string[], options) => string.
 * @returns {null | {severity: 'warn', message: string,
 *   candidates: Array<{wtPath: string, branch: string, sessionId: string, aheadCount: 0}>}}
 *   `null` on bad input, when disabled, on any failure, or when nothing is
 *   found. Otherwise ONE object whose `candidates` are proposals only —
 *   nothing has been, or will be, removed by this module.
 */
export function checkWorktreeOrphans({ repoRoot, mainCheckoutRoot, config, execFileFn } = {}) {
  // Silent no-op on bad input (consistent with the other Phase 4/4b banners).
  if (!repoRoot || typeof repoRoot !== 'string') return null;

  try {
    const cfg = config && typeof config === 'object' ? config : {};

    // Config gate BEFORE any git invocation — a disabled sweep costs nothing.
    if (cfg.enabled === false || cfg.mode === 'off') return null;

    const exec = typeof execFileFn === 'function' ? execFileFn : execFileSync;

    const rawBase = cfg['base-branch'];
    const baseBranch = typeof rawBase === 'string' && rawBase.trim() ? rawBase.trim() : 'main';

    // Anchor for `git worktree list`: the injected main checkout when provided,
    // otherwise repoRoot (git reports the same worktree set from any member).
    const listAnchor =
      mainCheckoutRoot && typeof mainCheckoutRoot === 'string' ? mainCheckoutRoot : repoRoot;

    // ── READ-ONLY GIT CALL 1 of 2 ───────────────────────────────────────────
    let out;
    try {
      out = exec('git', ['-C', listAnchor, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
      });
    } catch {
      // Not a git repo, or git unavailable → conservative no-op.
      return null;
    }
    if (typeof out !== 'string' || out.trim().length === 0) return null;

    const entries = out.split('\n\n').filter(Boolean);

    // Derive the canonical main checkout from the FIRST `worktree ` line.
    let resolvedMain = mainCheckoutRoot;
    if (!resolvedMain || typeof resolvedMain !== 'string') {
      const firstLine = out.split('\n').find((l) => l.startsWith('worktree '));
      if (!firstLine) return null;
      resolvedMain = firstLine.slice('worktree '.length).trim();
    }
    if (!resolvedMain) return null;

    const mainRepoName = path.basename(resolvedMain);
    const candidates = [];

    for (const entry of entries) {
      const wtMatch = entry.match(/^worktree (.+)$/m);
      if (!wtMatch) continue;
      const wtPath = wtMatch[1].trim();
      if (!wtPath) continue;

      // The main checkout is never a candidate.
      let isMain = false;
      try {
        isMain = path.resolve(wtPath) === path.resolve(resolvedMain);
      } catch {
        // Unresolvable path → conservative: treat as main (i.e. skip it).
        isMain = true;
      }
      if (isMain) continue;

      // Branch must be resolvable. A detached HEAD has no `branch` line →
      // conservative: not a candidate.
      const branchMatch = entry.match(/^branch refs\/heads\/(.+)$/m);
      if (!branchMatch) continue;
      const branch = branchMatch[1].trim();
      if (!branch) continue;

      // ── READ-ONLY GIT CALL 2 of 2 ─────────────────────────────────────────
      let countOut;
      try {
        countOut = exec(
          'git',
          ['-C', resolvedMain, 'rev-list', '--count', `${baseBranch}..${branch}`],
          { encoding: 'utf8' },
        );
      } catch {
        // Unknown base branch, missing ref, or any git error → conservative:
        // not a candidate. A sibling worktree is unaffected by this failure.
        continue;
      }

      if (typeof countOut !== 'string') continue;
      const aheadCount = parseInt(countOut.trim(), 10);
      // Unparseable output → conservative: not a candidate.
      if (!Number.isFinite(aheadCount)) continue;
      // Any work ahead of the base branch → definitively NOT an orphan.
      if (aheadCount !== 0) continue;

      candidates.push({
        wtPath,
        branch,
        sessionId: deriveSessionId(wtPath, mainRepoName),
        aheadCount: 0,
      });
    }

    if (candidates.length === 0) return null;

    const listed = candidates.map((c) => `${path.basename(c.wtPath)} (${c.branch})`).join(', ');
    const subject =
      candidates.length === 1
        ? '1 worktree branch has 0 commits ahead of the base branch'
        : `${candidates.length} worktree branches have 0 commits ahead of the base branch`;

    // The trailing "nothing was removed" clause is MANDATORY — it is the
    // operator-visible proof of the no-delete invariant above.
    const message =
      `⚠ worktree-orphans: ${subject} — ${listed} — ` +
      `review via the cleanup prompt; nothing was removed.`;

    return { severity: 'warn', message, candidates };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}
