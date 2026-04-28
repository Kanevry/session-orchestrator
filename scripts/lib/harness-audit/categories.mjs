/**
 * categories.mjs — Re-export aggregator for harness-audit category checks.
 *
 * Each category lives in its own module under categories/. This file is a
 * thin barrel so callers (`scripts/harness-audit.mjs`) continue to work
 * with the same import surface after the split (#285).
 *
 * Stdlib only: none (delegates to per-category modules).
 */

export { runCategory1 } from './categories/category1.mjs';
export { runCategory2 } from './categories/category2.mjs';
export { runCategory3 } from './categories/category3.mjs';
export { runCategory4 } from './categories/category4.mjs';
export { runCategory5 } from './categories/category5.mjs';
export { runCategory6 } from './categories/category6.mjs';
export { runCategory7 } from './categories/category7.mjs';
