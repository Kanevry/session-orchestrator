/**
 * session-schema/validator.mjs — ValidationError class + validateSession.
 *
 * Extracted from scripts/lib/session-schema.mjs (W1A3 split).
 * Imports: constants.mjs (leaf). No imports from siblings (normalizer,
 * timestamps, aliases) or parent barrel.
 *
 * Exports: ValidationError, validateSession
 * Module-private: isPlainObject, _validateSchemaVersion,
 *   _validateRequiredFields, _validateSessionId, _validateSessionType,
 *   _validateTimestamps, _validateWaves, _validateAgentSummary,
 *   _validateOptionalFields
 */

import {
  CURRENT_SESSION_SCHEMA_VERSION,
  VALID_SESSION_TYPES,
  REQUIRED_FIELDS,
  AGENT_SUMMARY_FIELDS,
} from './constants.mjs';

// ---------------------------------------------------------------------------
// Module-private enums + regex
// ---------------------------------------------------------------------------

/** Valid values for the optional `expected_cost_tier` field (ADR-364). */
const EXPECTED_COST_TIERS = Object.freeze(['quick', 'standard', 'deep']);

/**
 * Valid values for the optional `status` field (Epic #724 C1).
 * `completed` — record written by a normal /close flow.
 * `abandoned` — stub backfilled by the SessionEnd hook because the session
 *               terminated without running /close.
 */
const SESSION_STATUS = Object.freeze(['completed', 'abandoned']);

/**
 * Canonical ISO-8601 UTC timestamp regex — accepts `YYYY-MM-DDTHH:MM:SSZ`
 * and `YYYY-MM-DDTHH:MM:SS.SSSZ` (exactly 3 fractional digits).
 *
 * Issue #540 defense-in-depth layer (b): block malformed timestamp strings
 * that `Date.parse` accepts as NaN OR (worse) accepts as valid but
 * non-canonical (e.g. `.3NZ`, `.3Z`, `.300000Z`). The strict regex closes
 * the gap left by `Date.parse` alone, which returned NaN for `.3NZ` in some
 * inputs and silently coerced others.
 */
const ISO_8601_UTC_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Sub-validators (module-private)
// ---------------------------------------------------------------------------
//
// Each helper throws ValidationError on the first violation it detects,
// preserving the original error message + ordering of the monolithic
// validateSession() body. Helpers are intentionally not exported; the
// public contract is validateSession() alone.

/**
 * Validate session entry's schema_version field.
 *
 * Accepted versions: 0 (legacy / pre-versioning), 1 (pre-#372 writes),
 * 2 (current writes per CURRENT_SESSION_SCHEMA_VERSION, bumped via #372),
 * 3 (ADR-364 follow-ups, commit eb820ca).
 *
 * Additive contract: as the schema evolves, older historical entries must remain readable.
 * #576 expanded this from `0 | 1` to `0 | 1 | 2 | 3` after discovering schema_version=3 entries
 * in production data (.orchestrator/metrics/sessions.jsonl line 11, session main-2026-05-24-0510-housekeeping).
 * #372 bumped CURRENT_SESSION_SCHEMA_VERSION from 1 to 2 — the accepted set here was already
 * wide enough (#576), so no change to ACCEPTED_VERSIONS was required for the bump itself.
 *
 * Cross-references:
 * - Issue: #576, #372
 * - Constant: CURRENT_SESSION_SCHEMA_VERSION in ./constants.mjs (current=2; bump when adding fields)
 * - PRD: docs/prd/<future-schema-evolution> when v4 is introduced
 *
 * @throws {ValidationError} when schema_version is set but not in [0, 1, 2, 3]
 */
function _validateSchemaVersion(entry) {
  if ('schema_version' in entry && entry.schema_version !== undefined) {
    const ACCEPTED_VERSIONS = [0, 1, 2, 3];
    if (!ACCEPTED_VERSIONS.includes(entry.schema_version)) {
      throw new ValidationError(
        `schema_version must be one of [0 (legacy), 1, 2, 3], got: ${entry.schema_version}`
      );
    }
  }
}

function _validateRequiredFields(entry) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in entry)) {
      throw new ValidationError(`session missing required field: ${field}`);
    }
  }
}

function _validateSessionId(entry) {
  if (typeof entry.session_id !== 'string' || entry.session_id.length === 0) {
    throw new ValidationError('session_id must be a non-empty string');
  }
}

function _validateSessionType(entry) {
  if (!VALID_SESSION_TYPES.includes(entry.session_type)) {
    throw new ValidationError(
      `session_type must be one of ${VALID_SESSION_TYPES.join('|')}, got: ${entry.session_type}`
    );
  }
}

function _validateTimestamps(entry) {
  if (typeof entry.started_at !== 'string') {
    throw new ValidationError('started_at must be an ISO timestamp string');
  }
  const startedMs = Date.parse(entry.started_at);
  if (Number.isNaN(startedMs)) {
    throw new ValidationError(`started_at is not a parsable timestamp: ${entry.started_at}`);
  }
  // Issue #540 defense-in-depth layer (b): strict canonical ISO-8601 UTC
  // format guard. `Date.parse` alone accepted malformed inputs like `.3NZ`
  // as NaN, but the failure mode is the same as a non-canonical accepted
  // shape. Require explicit `YYYY-MM-DDTHH:MM:SS[.SSS]Z`.
  if (!ISO_8601_UTC_MS_RE.test(entry.started_at)) {
    throw new ValidationError(
      `started_at must match ISO-8601 UTC ms format (YYYY-MM-DDTHH:MM:SS[.SSS]Z), got: ${entry.started_at}`
    );
  }
  if (typeof entry.completed_at !== 'string') {
    throw new ValidationError('completed_at must be an ISO timestamp string');
  }
  const completedMs = Date.parse(entry.completed_at);
  if (Number.isNaN(completedMs)) {
    throw new ValidationError(`completed_at is not a parsable timestamp: ${entry.completed_at}`);
  }
  if (!ISO_8601_UTC_MS_RE.test(entry.completed_at)) {
    throw new ValidationError(
      `completed_at must match ISO-8601 UTC ms format (YYYY-MM-DDTHH:MM:SS[.SSS]Z), got: ${entry.completed_at}`
    );
  }
  if (completedMs < startedMs) {
    throw new ValidationError(
      `completed_at (${entry.completed_at}) must be >= started_at (${entry.started_at})`
    );
  }
}

function _validateWaves(entry) {
  // total_waves — non-negative number.
  if (typeof entry.total_waves !== 'number' || entry.total_waves < 0) {
    throw new ValidationError(
      `total_waves must be a non-negative number, got: ${entry.total_waves}`
    );
  }

  // waves — array, entries shape-checked.
  if (!Array.isArray(entry.waves)) {
    throw new ValidationError(`waves must be an array, got: ${typeof entry.waves}`);
  }
  for (let i = 0; i < entry.waves.length; i++) {
    const w = entry.waves[i];
    if (!isPlainObject(w)) {
      throw new ValidationError(`waves[${i}] must be an object`);
    }
    if (typeof w.wave !== 'number' || w.wave < 1) {
      throw new ValidationError(`waves[${i}].wave must be a number >= 1, got: ${w.wave}`);
    }
    if (typeof w.role !== 'string' || w.role.length === 0) {
      throw new ValidationError(`waves[${i}].role must be a non-empty string`);
    }
  }
}

function _validateAgentSummary(entry) {
  if (!isPlainObject(entry.agent_summary)) {
    throw new ValidationError('agent_summary must be an object');
  }
  for (const f of AGENT_SUMMARY_FIELDS) {
    if (!(f in entry.agent_summary)) {
      throw new ValidationError(`agent_summary missing required field: ${f}`);
    }
    const v = entry.agent_summary[f];
    if (typeof v !== 'number' || v < 0) {
      throw new ValidationError(`agent_summary.${f} must be a non-negative number, got: ${v}`);
    }
  }

  // total_agents / total_files_changed — non-negative numbers.
  if (typeof entry.total_agents !== 'number' || entry.total_agents < 0) {
    throw new ValidationError(
      `total_agents must be a non-negative number, got: ${entry.total_agents}`
    );
  }
  if (typeof entry.total_files_changed !== 'number' || entry.total_files_changed < 0) {
    throw new ValidationError(
      `total_files_changed must be a non-negative number, got: ${entry.total_files_changed}`
    );
  }
}

function _validateOptionalFields(entry) {
  if (entry.effectiveness !== undefined && entry.effectiveness !== null) {
    if (!isPlainObject(entry.effectiveness)) {
      throw new ValidationError('effectiveness must be an object or null');
    }
  }
  if (entry.discovery_stats !== undefined && entry.discovery_stats !== null) {
    if (!isPlainObject(entry.discovery_stats)) {
      throw new ValidationError('discovery_stats must be an object or null');
    }
  }
  if (entry.review_stats !== undefined && entry.review_stats !== null) {
    if (!isPlainObject(entry.review_stats)) {
      throw new ValidationError('review_stats must be an object or null');
    }
  }
  if (entry.platform !== undefined && entry.platform !== null) {
    if (typeof entry.platform !== 'string') {
      throw new ValidationError('platform must be a string or null');
    }
  }
  if (entry.branch !== undefined && entry.branch !== null) {
    if (typeof entry.branch !== 'string') {
      throw new ValidationError('branch must be a string or null');
    }
  }
  if (entry.base_branch !== undefined && entry.base_branch !== null) {
    if (typeof entry.base_branch !== 'string') {
      throw new ValidationError('base_branch must be a string or null');
    }
  }
  if (entry.notes !== undefined && entry.notes !== null) {
    if (typeof entry.notes !== 'string') {
      throw new ValidationError('notes must be a string or null');
    }
  }
  if (entry.duration_seconds !== undefined && entry.duration_seconds !== null) {
    if (typeof entry.duration_seconds !== 'number' || entry.duration_seconds < 0) {
      throw new ValidationError(
        `duration_seconds must be a non-negative number or null, got: ${entry.duration_seconds}`
      );
    }
  }
  if (entry.issues_closed !== undefined) {
    if (
      !Array.isArray(entry.issues_closed) ||
      entry.issues_closed.some((n) => typeof n !== 'number')
    ) {
      throw new ValidationError('issues_closed must be an array of numbers');
    }
  }
  if (entry.issues_created !== undefined) {
    if (
      !Array.isArray(entry.issues_created) ||
      entry.issues_created.some((n) => typeof n !== 'number')
    ) {
      throw new ValidationError('issues_created must be an array of numbers');
    }
  }

  // ADR-364 optional additive fields — remote-agent substrate thin-slice.
  // All are nullable; null is treated as "not provided" and passes without
  // further checks. Only non-null present values are type/range validated.

  if (entry.agent_identity !== undefined && entry.agent_identity !== null) {
    if (typeof entry.agent_identity !== 'string' || entry.agent_identity.length === 0) {
      throw new ValidationError('agent_identity must be a non-empty string or null');
    }
  }
  if (entry.worktree_path !== undefined && entry.worktree_path !== null) {
    if (typeof entry.worktree_path !== 'string' || entry.worktree_path.length === 0) {
      throw new ValidationError('worktree_path must be a non-empty string or null');
    }
  }
  if (entry.parent_run_id !== undefined && entry.parent_run_id !== null) {
    if (typeof entry.parent_run_id !== 'string' || entry.parent_run_id.length === 0) {
      throw new ValidationError('parent_run_id must be a non-empty string or null');
    }
  }
  if (entry.lease_acquired_at !== undefined && entry.lease_acquired_at !== null) {
    if (typeof entry.lease_acquired_at !== 'string') {
      throw new ValidationError('lease_acquired_at must be an ISO 8601 timestamp string or null');
    }
    if (Number.isNaN(Date.parse(entry.lease_acquired_at))) {
      throw new ValidationError(
        `lease_acquired_at is not a parsable timestamp: ${entry.lease_acquired_at}`
      );
    }
    // Issue #540 defense-in-depth layer (b): strict canonical guard for the
    // ADR-364 optional lease timestamp. Matches the `started_at` / `completed_at`
    // policy enforced above.
    if (!ISO_8601_UTC_MS_RE.test(entry.lease_acquired_at)) {
      throw new ValidationError(
        `lease_acquired_at must match ISO-8601 UTC ms format (YYYY-MM-DDTHH:MM:SS[.SSS]Z), got: ${entry.lease_acquired_at}`
      );
    }
  }
  if (entry.lease_ttl_seconds !== undefined && entry.lease_ttl_seconds !== null) {
    if (!Number.isFinite(entry.lease_ttl_seconds) || entry.lease_ttl_seconds < 0) {
      throw new ValidationError(
        `lease_ttl_seconds must be a non-negative finite number or null, got: ${entry.lease_ttl_seconds}`
      );
    }
  }
  if (entry.expected_cost_tier !== undefined && entry.expected_cost_tier !== null) {
    if (!EXPECTED_COST_TIERS.includes(entry.expected_cost_tier)) {
      throw new ValidationError(
        `expected_cost_tier must be one of ${EXPECTED_COST_TIERS.join('|')} or null, got: ${entry.expected_cost_tier}`
      );
    }
  }

  // Epic #644 — session-level token rollup fields (additive, v1-compatible).
  // total_token_input / total_token_output: non-negative finite number or null.
  // Number.isFinite rejects NaN/Infinity (mirrors lease_ttl_seconds above) — a typeof-only
  // guard let NaN through because NaN < 0 is false (W4 session-review WARN, #644).
  if (entry.total_token_input !== undefined && entry.total_token_input !== null) {
    if (!Number.isFinite(entry.total_token_input) || entry.total_token_input < 0) {
      throw new ValidationError(
        `total_token_input must be a non-negative finite number or null, got: ${entry.total_token_input}`
      );
    }
  }
  if (entry.total_token_output !== undefined && entry.total_token_output !== null) {
    if (!Number.isFinite(entry.total_token_output) || entry.total_token_output < 0) {
      throw new ValidationError(
        `total_token_output must be a non-negative finite number or null, got: ${entry.total_token_output}`
      );
    }
  }
  // subagents_with_tokens: non-negative integer (never null — it is always a count, defaulting to 0).
  if (entry.subagents_with_tokens !== undefined && entry.subagents_with_tokens !== null) {
    if (
      typeof entry.subagents_with_tokens !== 'number' ||
      !Number.isInteger(entry.subagents_with_tokens) ||
      entry.subagents_with_tokens < 0
    ) {
      throw new ValidationError(
        `subagents_with_tokens must be a non-negative integer, got: ${entry.subagents_with_tokens}`
      );
    }
  }

  // Epic #724 C1 — SessionEnd close-through backfill provenance fields.
  // All additive-optional; null/absent passes without further checks so that
  // pre-#724 records (and every normally-closed record) validate cleanly.
  if (entry.status !== undefined && entry.status !== null) {
    if (!SESSION_STATUS.includes(entry.status)) {
      throw new ValidationError(
        `status must be one of ${SESSION_STATUS.join('|')} or null, got: ${entry.status}`
      );
    }
  }
  if (entry._backfill_source !== undefined && entry._backfill_source !== null) {
    if (typeof entry._backfill_source !== 'string' || entry._backfill_source.length === 0) {
      throw new ValidationError('_backfill_source must be a non-empty string or null');
    }
  }
  if (entry._backfill_incomplete_fields !== undefined && entry._backfill_incomplete_fields !== null) {
    if (
      !Array.isArray(entry._backfill_incomplete_fields) ||
      entry._backfill_incomplete_fields.some((f) => typeof f !== 'string')
    ) {
      throw new ValidationError('_backfill_incomplete_fields must be an array of strings or null');
    }
  }
  if (entry._session_type_inferred !== undefined && entry._session_type_inferred !== null) {
    if (typeof entry._session_type_inferred !== 'boolean') {
      throw new ValidationError('_session_type_inferred must be a boolean or null');
    }
  }
  if (entry._synthetic_session_id !== undefined && entry._synthetic_session_id !== null) {
    if (typeof entry._synthetic_session_id !== 'boolean') {
      throw new ValidationError('_synthetic_session_id must be a boolean or null');
    }
  }

  // Issue #773 — Handover-Alignment-Gate open-question telemetry (additive,
  // v1-compatible). Each field is a non-negative integer count surfaced by the
  // session-end Phase 1.65 gate: how many open questions were surfaced in the
  // triage AUQ (`_asked`), how many the operator answered (`_answered`), and how
  // many stayed unanswered / over-cap and roundtripped to the next session
  // (`_deferred`). Absent/null = the gate did not run or the session was not
  // measured (fail-open skip, headless, pre-#773 record) — never coerced to 0,
  // so "not measured" stays distinguishable from "zero questions". Same
  // non-negative-integer contract as subagents_with_tokens above.
  for (const field of ['open_questions_asked', 'open_questions_answered', 'open_questions_deferred']) {
    if (entry[field] !== undefined && entry[field] !== null) {
      if (
        typeof entry[field] !== 'number' ||
        !Number.isInteger(entry[field]) ||
        entry[field] < 0
      ) {
        throw new ValidationError(
          `${field} must be a non-negative integer, got: ${entry[field]}`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a session entry for writing. Throws ValidationError on any
 * required-field/type/range violation. Returns a NEW object (input is not
 * mutated) with `schema_version` stamped to CURRENT_SESSION_SCHEMA_VERSION
 * if absent. Does NOT apply SESSION_KEY_ALIASES — aliasing is the read-path
 * concern of normalizeSession.
 *
 * @param {object} entry
 * @returns {object} validated entry (new object)
 */
export function validateSession(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ValidationError('session must be an object');
  }

  _validateSchemaVersion(entry);
  _validateRequiredFields(entry);
  _validateSessionId(entry);
  _validateSessionType(entry);
  _validateTimestamps(entry);
  _validateWaves(entry);
  _validateAgentSummary(entry);
  _validateOptionalFields(entry);

  // Return a NEW object — stamp schema_version if missing.
  return {
    ...entry,
    schema_version: entry.schema_version ?? CURRENT_SESSION_SCHEMA_VERSION,
  };
}
