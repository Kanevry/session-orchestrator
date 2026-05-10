/**
 * worktree/listing.mjs — list and filter worktrees.
 *
 * Exports:
 *   listWorktrees()                            — list all git worktrees
 *   applyWorktreeExcludes(wtPath, patterns)    — remove top-level dirs from worktree
 *
 * No imports from lifecycle.mjs — this module is intentionally a leaf of the
 * lifecycle import chain (lifecycle imports listing, not the reverse).
 */

import { $ as defaultDollar } from 'zx';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// listWorktrees
// ---------------------------------------------------------------------------

/**
 * List all git worktrees in the current repository.
 *
 * @param {object} [opts]
 * @param {Function} [opts.$]  Optional zx-compatible executor. Defaults to real zx.$.
 *   Tests pass a mock here to avoid vi.mock('zx') under fork pool.
 * @returns {Promise<Array<{path: string, branch: string, head: string}>>}
 *   Array of worktree descriptors; empty array if none or on parse error.
 */
export async function listWorktrees(opts = {}) {
  const dollar = opts.$ ?? defaultDollar;
  const git = dollar({ cwd: process.cwd() });
  let output;
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
    let dirExists;
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
