/**
 * worktree.mjs — cross-platform git worktree helpers for session-orchestrator.
 *
 * Node.js port of scripts/lib/worktree.sh. Uses os.tmpdir() instead of
 * ${TMPDIR:-/tmp} for Windows compatibility. Shell-outs via zx `$`.
 *
 * Part of v3.0.0 migration (Epic #124, issue #134).
 */

import { $, nothrow, ProcessOutput } from 'zx';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile, parseSessionConfig } from './config.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default list of top-level directory names to exclude from new worktrees.
 * Issue #192 — skip build artifacts to reduce RAM spikes on memory-constrained
 * sessions. Can be overridden per-call via options.excludePatterns or via
 * Session Config `worktree-exclude`.
 */
const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '.turbo', '.vercel', 'out',
];

// Do not spam stdout/stderr with git command echoes.
$.verbose = false;
$.quiet = true;

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

  // Ensure parent directory exists — path.join + recursive mkdir is cross-platform.
  await fs.mkdir(path.dirname(wtPath), { recursive: true });

  try {
    await $`git worktree add -b ${branch} ${wtPath} ${baseRef}`;
  } catch {
    // Branch or worktree may already exist from a previous failed run — force-cleanup and retry.
    await nothrow($`git worktree remove ${wtPath} --force`);
    await nothrow($`git branch -D ${branch}`);

    try {
      await $`git worktree add -b ${branch} ${wtPath} ${baseRef}`;
    } catch (secondErr) {
      const msg = secondErr instanceof ProcessOutput ? secondErr.stderr.trim() : String(secondErr);
      throw new Error(
        `createWorktree: failed to create worktree for branch '${branch}' at '${wtPath}' (base: ${baseRef}). ` +
        `git error: ${msg}`
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
    try {
      const content = await readConfigFile(process.cwd());
      const config = parseSessionConfig(content);
      const fromConfig = config['worktree-exclude'];
      excludePatterns = Array.isArray(fromConfig) ? fromConfig : DEFAULT_EXCLUDE_PATTERNS;
    } catch {
      excludePatterns = DEFAULT_EXCLUDE_PATTERNS;
    }
  }

  await applyWorktreeExcludes(wtPath, excludePatterns);

  return wtPath;
}

// ---------------------------------------------------------------------------
// applyWorktreeExcludes
// ---------------------------------------------------------------------------

/**
 * Remove top-level directories matching `patterns` from a worktree path.
 * Pure fs operation — no git, no zx. Exported for unit testing (issue #192).
 *
 * @param {string} wtPath  Absolute path to the worktree root.
 * @param {string[]} patterns  Top-level directory names to remove.
 * @returns {Promise<void>}
 */
export async function applyWorktreeExcludes(wtPath, patterns) {
  if (!patterns || patterns.length === 0) return;

  let anyRemoved = false;
  let allFailed = true;

  for (const pattern of patterns) {
    const targetPath = path.join(wtPath, pattern);
    let dirExists = false;
    try {
      const stat = await fs.stat(targetPath);
      dirExists = stat.isDirectory();
    } catch {
      // Pattern does not exist — silently skip.
      allFailed = false; // not a failure, just absent
      continue;
    }

    if (dirExists) {
      try {
        await fs.rm(targetPath, { recursive: true, force: true });
        process.stderr.write(`[worktree] excluded: ${pattern}\n`);
        anyRemoved = true;
        allFailed = false;
      } catch {
        // Individual removal failure — continue with remaining patterns.
      }
    }
  }

  if (anyRemoved === false && allFailed) {
    process.stderr.write(`[worktree] WARNING: all pattern removals failed for worktree at ${wtPath}\n`);
  }
}

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

/**
 * Remove a worktree and its associated branch.
 * Emits a warning to stderr (does not throw) if uncommitted changes exist.
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

  // Warn about uncommitted changes without throwing.
  try {
    const status = await $`git -C ${wtPath} status --porcelain`;
    if (status.stdout.trim().length > 0) {
      console.error(`WARNING: worktree at ${wtPath} has uncommitted changes`);
    }
  } catch {
    // Ignore — worktree may already be partially detached.
  }

  // Resolve the branch name, but only accept so-worktree-* names.
  let branch = '';
  try {
    const ref = await $`git -C ${wtPath} rev-parse --abbrev-ref HEAD`;
    const candidate = ref.stdout.trim();
    if (/^so-worktree-/.test(candidate)) {
      branch = candidate;
    }
  } catch {
    // Ignore — best-effort.
  }

  // Remove worktree (force so it works even with dirty state).
  await nothrow($`git worktree remove ${wtPath} --force`);

  // Clean up the temporary branch (best-effort).
  if (branch) {
    await nothrow($`git branch -D ${branch}`);
  }
}

// ---------------------------------------------------------------------------
// listWorktrees
// ---------------------------------------------------------------------------

/**
 * List all git worktrees in the current repository.
 *
 * @returns {Promise<Array<{path: string, branch: string, head: string}>>}
 *   Array of worktree descriptors; empty array if none or on parse error.
 */
export async function listWorktrees() {
  let output = '';
  try {
    const result = await $`git worktree list --porcelain`;
    output = result.stdout;
  } catch {
    return [];
  }

  const worktrees = [];
  let current = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();

    if (line.startsWith('worktree ')) {
      // Each new 'worktree' line starts a new record.
      if (current !== null) {
        worktrees.push(current);
      }
      current = { path: line.slice('worktree '.length), branch: '', head: '' };
    } else if (line.startsWith('HEAD ') && current !== null) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current !== null) {
      // Branch is stored as refs/heads/<name> — strip the prefix.
      const ref = line.slice('branch '.length);
      current.branch = ref.replace(/^refs\/heads\//, '');
    } else if (line === '' && current !== null) {
      // Blank line separates records in --porcelain output.
      worktrees.push(current);
      current = null;
    }
  }

  // Flush any trailing record (no trailing blank line at EOF).
  if (current !== null) {
    worktrees.push(current);
  }

  return worktrees;
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

  await nothrow($`git worktree prune`);
}
