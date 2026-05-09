/**
 * worktree/index.mjs — re-export hub for all public worktree symbols.
 *
 * Public API (7 exports):
 *   WORKTREE_META_DIR       (constants)
 *   metaPathFor             (meta)
 *   listWorktrees           (listing)
 *   applyWorktreeExcludes   (listing)
 *   createWorktree          (lifecycle)
 *   removeWorktree          (lifecycle)
 *   cleanupAllWorktrees     (lifecycle)
 */

export { WORKTREE_META_DIR } from './constants.mjs';
export { metaPathFor } from './meta.mjs';
export { listWorktrees, applyWorktreeExcludes } from './listing.mjs';
export { createWorktree, removeWorktree, cleanupAllWorktrees } from './lifecycle.mjs';
