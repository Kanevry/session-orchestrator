/**
 * worktree/constants.mjs — shared constants for the worktree module.
 *
 * Leaf module: imports only stdlib and zx. No imports from other
 * worktree/* submodules.
 *
 * Side effect: configures zx to suppress git command echoes on load.
 */

import { $ } from 'zx';

// Do not spam stdout/stderr with git command echoes.
$.verbose = false;
$.quiet = true;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default list of top-level directory names to exclude from new worktrees.
 * Issue #192 — skip build artifacts to reduce RAM spikes on memory-constrained
 * sessions. Can be overridden per-call via options.excludePatterns or via
 * Session Config `worktree-exclude`.
 */
export const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '.turbo', '.vercel', 'out',
];

/**
 * Relative path (from repo root) where worktree meta JSON files are stored.
 * Each file is named `<suffix>.json`.
 */
export const WORKTREE_META_DIR = '.orchestrator/tmp/worktree-meta';
