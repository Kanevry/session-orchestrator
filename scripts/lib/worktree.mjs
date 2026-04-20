/**
 * worktree.mjs — cross-platform git worktree helpers for session-orchestrator.
 *
 * Node.js port of scripts/lib/worktree.sh. Uses os.tmpdir() instead of
 * ${TMPDIR:-/tmp} for Windows compatibility. Shell-outs via zx `$`.
 *
 * Part of v3.0.0 migration (Epic #124, issue #134).
 * Meta-persistence added for base-ref freshness guard (issue #195).
 */

import { $, nothrow, ProcessOutput } from 'zx';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Do not spam stdout/stderr with git command echoes.
$.verbose = false;
$.quiet = true;

// ---------------------------------------------------------------------------
// Meta-file constants (issue #195)
// ---------------------------------------------------------------------------

/**
 * Relative path (from repo root) where worktree meta JSON files are stored.
 * Each file is named `<suffix>.json`.
 */
export const WORKTREE_META_DIR = '.orchestrator/tmp/worktree-meta';

/**
 * Return the absolute path of the meta JSON file for a given suffix.
 * Uses process.cwd() as the repo root (same as all other helpers in this module).
 *
 * @param {string} suffix
 * @returns {string}
 */
export function metaPathFor(suffix) {
  return path.join(process.cwd(), WORKTREE_META_DIR, `${suffix}.json`);
}

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
 * @returns {Promise<string>}  Absolute path to the created worktree.
 */
export async function createWorktree(suffix, baseRef = 'HEAD') {
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
        `git error: ${msg}`
      );
    }
  }

  // Persist meta for freshness guard (issue #195). Non-fatal on failure.
  await _writeWorktreeMeta(suffix, { branch, wtPath, baseRef, baseSha, repoRoot: cwd }).catch((err) => {
    console.warn(`createWorktree: meta write failed for '${suffix}' — freshness guard will be skipped: ${err.message}`);
  });

  return wtPath;
}

/**
 * Write the worktree meta JSON file atomically (tmp + rename).
 * Creates the meta directory if it does not exist.
 *
 * @param {string} suffix
 * @param {{ branch: string, wtPath: string, baseRef: string, baseSha: string|null, repoRoot?: string }} info
 * @returns {Promise<void>}
 */
async function _writeWorktreeMeta(suffix, { branch, wtPath, baseRef, baseSha, repoRoot }) {
  // Use explicit repoRoot when provided (avoids stale module-level cwd capture).
  const root = repoRoot ?? process.cwd();
  const metaPath = path.join(root, WORKTREE_META_DIR, `${suffix}.json`);
  const metaDir = path.dirname(metaPath);

  await fs.mkdir(metaDir, { recursive: true });

  const meta = {
    suffix,
    baseRef,
    baseSha,
    branch,
    wtPath,
    createdAt: new Date().toISOString(),
  };

  const tmpPath = `${metaPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), 'utf8');
  await fs.rename(tmpPath, metaPath);
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
// listWorktrees
// ---------------------------------------------------------------------------

/**
 * List all git worktrees in the current repository.
 *
 * @returns {Promise<Array<{path: string, branch: string, head: string}>>}
 *   Array of worktree descriptors; empty array if none or on parse error.
 */
export async function listWorktrees() {
  const git = $({ cwd: process.cwd() });
  let output = '';
  try {
    const result = await git`git worktree list --porcelain`;
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

  await nothrow($({ cwd: process.cwd() })`git worktree prune`);
}
