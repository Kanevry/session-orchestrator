/**
 * worktree/meta.mjs — meta-file persistence for the base-ref freshness guard.
 *
 * Exports:
 *   metaPathFor(suffix)       — return the absolute path of the meta JSON file
 *
 * Internal (not exported):
 *   _writeWorktreeMeta(...)   — atomic tmp+rename write of the meta file
 *
 * Issue #195 — meta persistence for base-ref freshness guard.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKTREE_META_DIR } from './constants.mjs';

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

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
 * Write the worktree meta JSON file atomically (tmp + rename).
 * Creates the meta directory if it does not exist.
 *
 * @param {string} suffix
 * @param {{ branch: string, wtPath: string, baseRef: string, baseSha: string|null, repoRoot?: string }} info
 * @returns {Promise<void>}
 */
export async function _writeWorktreeMeta(suffix, { branch, wtPath, baseRef, baseSha, repoRoot }) {
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
