/**
 * worktree.mjs — thin barrel re-exporting the worktree public API.
 *
 * All implementation lives in scripts/lib/worktree/:
 *   constants.mjs  — WORKTREE_META_DIR, DEFAULT_EXCLUDE_PATTERNS, zx config
 *   meta.mjs       — metaPathFor, _writeWorktreeMeta
 *   listing.mjs    — listWorktrees, applyWorktreeExcludes
 *   lifecycle.mjs  — createWorktree, removeWorktree, cleanupAllWorktrees
 *   index.mjs      — re-export hub
 *
 * Part of v3.0.0 migration (Epic #124, issue #134).
 * Split into submodules: issue #W1A5.
 */

export * from './worktree/index.mjs';
