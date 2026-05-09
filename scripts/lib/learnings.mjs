/**
 * learnings.mjs — barrel module for the learnings JSONL schema and operations.
 *
 * After the issue #358 split (and the Q3 follow-up extraction of the schema
 * leaf), this file is a thin re-export surface preserving the historical
 * public API. All implementation lives in three sibling modules:
 *
 *   - learnings/schema.mjs   — schema constants, validators, migration, normalization
 *   - learnings/io.mjs       — read/append/rewrite operations on JSONL files
 *   - learnings/filters.mjs  — filter helpers (by scope, host_class, type)
 *
 * Dependency direction is unidirectional and acyclic:
 *
 *   learnings/schema.mjs   ← (leaf, imports only stdlib)
 *           ↑
 *   learnings/io.mjs ──────┤
 *           ↑              │
 *   learnings/filters.mjs ─┤
 *           ↑              │
 *   learnings.mjs (this file) — re-exports only; no logic
 *
 * Callers continue to import from `scripts/lib/learnings.mjs`. Sibling
 * modules import directly from `./schema.mjs` to avoid the circular
 * topology that the previous barrel-then-import pattern produced
 * (Q3 architect-review HIGH finding, fixed in 2026-05-09 deep-2).
 */

export {
  VALID_SCOPES,
  CURRENT_ANONYMIZATION_VERSION,
  LEARNING_TTL_DAYS,
  deriveExpiresAt,
  CURRENT_SCHEMA_VERSION,
  ValidationError,
  validateLearning,
  migrateLegacyLearning,
  normalizeLearning,
} from './learnings/schema.mjs';

export { readLearnings, appendLearning, rewriteLearnings } from './learnings/io.mjs';
export { filterByScope, filterByHostClass, filterByType } from './learnings/filters.mjs';
