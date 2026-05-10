/**
 * session-schema/constants.mjs — pure data constants for session schema.
 *
 * Extracted from scripts/lib/session-schema.mjs (W1A3 split).
 * Leaf module — no imports from siblings or parent.
 *
 * Exports: CURRENT_SESSION_SCHEMA_VERSION, SESSION_KEY_ALIASES,
 *          VALID_SESSION_TYPES, REQUIRED_FIELDS, AGENT_SUMMARY_FIELDS
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Current session-record schema version. New writes are stamped with this
 * value by validateSession. Records read without `schema_version` are tagged
 * as 0 (pre-versioning legacy) by normalizeSession.
 */
export const CURRENT_SESSION_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Key aliases (safe renames — no value transformation)
// ---------------------------------------------------------------------------

/**
 * Safe key aliases — same-shape renames only (no value transformation).
 * Applied by normalizeSession on read so legacy records can be consumed by
 * canonical-key consumers without rewriting the file.
 *
 * Identity is frozen so callers can do strict-equality checks on the object
 * reference across re-imports.
 */
export const SESSION_KEY_ALIASES = Object.freeze({
  type: 'session_type',
  closed_issues: 'issues_closed',
  new_issues: 'issues_created',
  issues_filed: 'issues_created',
  issues_planned: 'planned_issues',
  files_changed: 'total_files_changed',
  snapshots: 'snapshots_created',
  learnings: 'learnings_added',
  waves_total: 'total_waves',
  waves_completed: 'total_waves',
  head_ref: 'branch',
  isolation_override: 'isolation',
});

// ---------------------------------------------------------------------------
// Enums / required field lists
// ---------------------------------------------------------------------------

/** Closed set of valid session_type values. */
export const VALID_SESSION_TYPES = Object.freeze(['feature', 'deep', 'housekeeping']);

/**
 * Required fields for a schema_version=1 record. Validated by validateSession
 * before any write reaches disk.
 */
export const REQUIRED_FIELDS = Object.freeze([
  'session_id',
  'session_type',
  'started_at',
  'completed_at',
  'total_waves',
  'waves',
  'agent_summary',
  'total_agents',
  'total_files_changed',
]);

/**
 * Required numeric counters inside the agent_summary object. All must be
 * non-negative numbers.
 */
export const AGENT_SUMMARY_FIELDS = Object.freeze(['complete', 'partial', 'failed', 'spiral']);

/**
 * Optional additive fields introduced for the remote-agent substrate (ADR-364 thin-slice).
 * These are NOT in REQUIRED_FIELDS — older entries lacking them validate cleanly.
 * Validator: see `_validateOptionalFields` in validator.mjs.
 */
export const OPTIONAL_FIELDS = Object.freeze([
  'agent_identity',
  'worktree_path',
  'parent_run_id',
  'lease_acquired_at',
  'lease_ttl_seconds',
  'expected_cost_tier',
]);
