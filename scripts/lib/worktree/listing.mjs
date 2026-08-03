/**
 * worktree/listing.mjs — list and filter worktrees.
 *
 * Exports:
 *   listWorktrees()                            — list all git worktrees (bare array; swallows git failure)
 *   listWorktreesChecked()                     — same listing WITH a "git actually ran" signal (#919.3)
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
 * List all git worktrees WITH an explicit "git actually ran" signal (#919.3).
 *
 * The bare `listWorktrees()` below swallows a failing `git worktree list` into
 * an empty array — indistinguishable from "git ran, repo has no extra
 * worktrees". That collapse is the last fail-open gap in the
 * `checkLiveForeignSession` full path (peer-discovery.mjs, #906/#908 residual):
 * a total surface failure read as "nobody home". This variant keeps the listing
 * contract but makes the failure DISTINGUISHABLE, so callers that need the
 * distinction can make the fail-safe call themselves.
 *
 * @param {object} [opts]
 * @param {Function} [opts.$]  Optional zx-compatible executor. Defaults to real zx.$.
 *   Tests pass a mock here to avoid vi.mock('zx') under fork pool.
 * @returns {Promise<{ok: boolean, worktrees: Array<{path: string, branch: string, head: string}>, error?: string}>}
 *   `ok: true`  — `git worktree list` ran; `worktrees` is the (possibly empty)
 *                 parsed listing. An empty list here is a MEASUREMENT.
 *   `ok: false` — the git invocation itself failed (spawn error, non-zero
 *                 exit, not a repo, …); `worktrees` is `[]` and `error` carries
 *                 the failure message. An empty list here is NOT a measurement.
 */
export async function listWorktreesChecked(opts = {}) {
  const dollar = opts.$ ?? defaultDollar;
  const git = dollar({ cwd: process.cwd() });
  let output;
  try {
    const result = await git`git worktree list --porcelain`;
    output = result.stdout;
  } catch (err) {
    return {
      ok: false,
      worktrees: [],
      error: err instanceof Error ? err.message : String(err),
    };
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

  return { ok: true, worktrees };
}

/**
 * List all git worktrees in the current repository.
 *
 * Thin backward-compatible wrapper over `listWorktreesChecked()`: existing
 * callers get the bare array they always got, INCLUDING the historical
 * swallow-to-`[]` on git failure. Callers that must distinguish "git ran,
 * empty" from "git failed" use `listWorktreesChecked()` instead (#919.3).
 *
 * @param {object} [opts]
 * @param {Function} [opts.$]  Optional zx-compatible executor. Defaults to real zx.$.
 *   Tests pass a mock here to avoid vi.mock('zx') under fork pool.
 * @returns {Promise<Array<{path: string, branch: string, head: string}>>}
 *   Array of worktree descriptors; empty array if none OR on git failure
 *   (the two are indistinguishable here — by design, see wrapper note).
 */
export async function listWorktrees(opts = {}) {
  const { worktrees } = await listWorktreesChecked(opts);
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
