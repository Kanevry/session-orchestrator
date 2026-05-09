/**
 * worktree/lifecycle.mjs — git worktree lifecycle operations.
 *
 * Exports:
 *   createWorktree(suffix, baseRef, options)  — create a git worktree
 *   removeWorktree(wtPath)                    — remove a worktree + branch
 *   cleanupAllWorktrees()                     — remove all so-worktree-* worktrees
 *
 * Internal:
 *   _exists(p)                — path existence check
 *   _worktreeInfo(suffix)     — compute branch name + tmp path
 *
 * Import DAG (no cycles):
 *   lifecycle → listing (cleanupAllWorktrees calls listWorktrees)
 *   lifecycle → meta    (_writeWorktreeMeta)
 *   lifecycle → constants (WORKTREE_META_DIR, DEFAULT_EXCLUDE_PATTERNS)
 *   lifecycle → config.mjs (readConfigFile, parseSessionConfig)
 */

import { $, nothrow, ProcessOutput } from 'zx';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile, parseSessionConfig } from '../config.mjs';
import { WORKTREE_META_DIR, DEFAULT_EXCLUDE_PATTERNS } from './constants.mjs';
import { _writeWorktreeMeta } from './meta.mjs';
import { listWorktrees, applyWorktreeExcludes } from './listing.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the given path exists on disk (file or directory).
 * Uses try/catch — no TOCTOU widening.
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function _exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the standard branch name and tmp path for a given suffix.
 * @param {string} suffix
 * @returns {{ branch: string, wtPath: string }}
 */
function _worktreeInfo(suffix) {
  const branch = `so-worktree-${suffix}`;
  const wtPath = path.join(os.tmpdir(), 'so-worktrees', branch);
  return { branch, wtPath };
}

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

/**
 * Create a git worktree for isolated agent work.
 *
 * After a successful `git worktree add`, persists a meta JSON file at
 * `.orchestrator/tmp/worktree-meta/<suffix>.json` for the base-ref freshness
 * guard (issue #195). Meta write failures are non-fatal — they emit a warning
 * to stderr but never block worktree creation.
 *
 * @param {string} suffix   Unique suffix for the branch (e.g. "wave2-agent1").
 * @param {string} [baseRef="HEAD"]  Git ref to base the worktree on.
 * @param {{ excludePatterns?: string[] }} [options={}]
 *   Optional configuration.
 *   - `excludePatterns`: list of top-level directory names to remove after
 *     worktree creation. Overrides the Session Config `worktree-exclude` value
 *     and the hardcoded default. Pass `[]` to disable all exclusions.
 * @returns {Promise<string>}  Absolute path to the created worktree.
 */
export async function createWorktree(suffix, baseRef = 'HEAD', options = {}) {
  const { branch, wtPath } = _worktreeInfo(suffix);
  // Capture cwd at call time so git commands run in the correct repo even if
  // zx's module-level default cwd differs (e.g. during tests with chdir).
  const cwd = process.cwd();
  const git = $({ cwd });

  // Resolve baseSha BEFORE creating the worktree so we capture the exact sha used.
  let baseSha = null;
  try {
    const result = await git`git rev-parse ${baseRef}`;
    baseSha = result.stdout.trim();
  } catch {
    // Non-fatal: freshness guard will treat missing baseSha as no-meta.
  }

  // Ensure parent directory exists — path.join + recursive mkdir is cross-platform.
  await fs.mkdir(path.dirname(wtPath), { recursive: true });

  try {
    await git`git worktree add -b ${branch} ${wtPath} ${baseRef}`;
  } catch {
    // Branch or worktree may already exist from a previous failed run — force-cleanup and retry.
    await nothrow(git`git worktree remove ${wtPath} --force`);
    await nothrow(git`git branch -D ${branch}`);

    try {
      await git`git worktree add -b ${branch} ${wtPath} ${baseRef}`;
    } catch (secondErr) {
      const msg = secondErr instanceof ProcessOutput ? secondErr.stderr.trim() : String(secondErr);
      throw new Error(
        `createWorktree: failed to create worktree for branch '${branch}' at '${wtPath}' (base: ${baseRef}). ` +
        `git error: ${msg}`,
        { cause: secondErr }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Exclude build artifacts (issue #192)
  // -------------------------------------------------------------------------

  // Resolve exclude patterns: explicit options > Session Config > hardcoded default.
  let excludePatterns;
  if (options.excludePatterns !== undefined) {
    excludePatterns = options.excludePatterns;
  } else {
    // Attempt to read from Session Config; fall back to hardcoded default.
    // Semantics:
    //   key absent (undefined)  → fall back to DEFAULT_EXCLUDE_PATTERNS
    //   key explicit null       → empty array (disable all excludes)
    //   key is an array         → use that array
    try {
      const content = await readConfigFile(process.cwd());
      const config = parseSessionConfig(content);
      const fromConfig = config['worktree-exclude'];
      if (fromConfig === null) {
        // Explicit `worktree-exclude: null` (YAML null) — user opted out of excludes.
        excludePatterns = [];
      } else if (Array.isArray(fromConfig)) {
        excludePatterns = fromConfig;
      } else {
        // Key missing (undefined) or unrecognised value — use hardcoded default.
        excludePatterns = DEFAULT_EXCLUDE_PATTERNS;
      }
    } catch {
      excludePatterns = DEFAULT_EXCLUDE_PATTERNS;
    }
  }

  await applyWorktreeExcludes(wtPath, excludePatterns);

  // Persist meta for freshness guard (issue #195). Non-fatal on failure.
  await _writeWorktreeMeta(suffix, { branch, wtPath, baseRef, baseSha, repoRoot: cwd }).catch((err) => {
    console.warn(`createWorktree: meta write failed for '${suffix}' — freshness guard will be skipped: ${err.message}`);
  });

  return wtPath;
}

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

/**
 * Remove a worktree and its associated branch.
 * Emits a warning to stderr (does not throw) if uncommitted changes exist.
 * Also cleans up the meta file written by createWorktree (issue #195).
 * Always resolves — never throws.
 *
 * @param {string} wtPath  Absolute path to the worktree to remove.
 * @returns {Promise<void>}
 */
export async function removeWorktree(wtPath) {
  // No-op if path does not exist.
  if (!(await _exists(wtPath))) {
    return;
  }

  // Capture cwd at call time for the same reason as createWorktree.
  const cwd = process.cwd();
  const git = $({ cwd });

  // Warn about uncommitted changes without throwing.
  try {
    const status = await git`git -C ${wtPath} status --porcelain`;
    if (status.stdout.trim().length > 0) {
      console.error(`WARNING: worktree at ${wtPath} has uncommitted changes`);
    }
  } catch {
    // Ignore — worktree may already be partially detached.
  }

  // Resolve the branch name, but only accept so-worktree-* names.
  let branch = '';
  try {
    const ref = await git`git -C ${wtPath} rev-parse --abbrev-ref HEAD`;
    const candidate = ref.stdout.trim();
    if (/^so-worktree-/.test(candidate)) {
      branch = candidate;
    }
  } catch {
    // Ignore — best-effort.
  }

  // Remove worktree (force so it works even with dirty state).
  await nothrow(git`git worktree remove ${wtPath} --force`);

  // Clean up the temporary branch (best-effort).
  if (branch) {
    await nothrow(git`git branch -D ${branch}`);
  }

  // Clean up meta file (issue #195). Derive suffix from branch name.
  // branch is "so-worktree-<suffix>"; if branch is empty, fall back to wtPath basename.
  const suffix = branch
    ? branch.replace(/^so-worktree-/, '')
    : path.basename(wtPath).replace(/^so-worktree-/, '');

  if (suffix) {
    const metaPath = path.join(cwd, WORKTREE_META_DIR, `${suffix}.json`);
    await fs.unlink(metaPath).catch((err) => {
      if (err.code !== 'ENOENT') {
        console.warn(`removeWorktree: meta cleanup failed for '${suffix}': ${err.message}`);
      }
      // ENOENT — already gone or never written; silently ignore.
    });
  }
}

// ---------------------------------------------------------------------------
// cleanupAllWorktrees
// ---------------------------------------------------------------------------

/**
 * Remove all session-orchestrator worktrees (branches matching so-worktree-*),
 * then prune stale worktree references.
 * Always resolves — never throws.
 *
 * @returns {Promise<void>}
 */
export async function cleanupAllWorktrees() {
  try {
    const worktrees = await listWorktrees();
    const soWorktrees = worktrees.filter(wt => /^so-worktree-/.test(wt.branch));

    for (const wt of soWorktrees) {
      await removeWorktree(wt.path);
    }
  } catch {
    // Best-effort — swallow any unexpected errors.
  }

  await nothrow($({ cwd: process.cwd() })`git worktree prune`);
}
