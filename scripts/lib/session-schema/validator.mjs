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

function _validateSchemaVersion(entry) {
  if ('schema_version' in entry && entry.schema_version !== undefined) {
    if (entry.schema_version !== 0 && entry.schema_version !== 1) {
      throw new ValidationError(
        `schema_version must be 0 (legacy) or 1, got: ${entry.schema_version}`
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
  if (typeof entry.completed_at !== 'string') {
    throw new ValidationError('completed_at must be an ISO timestamp string');
  }
  const completedMs = Date.parse(entry.completed_at);
  if (Number.isNaN(completedMs)) {
    throw new ValidationError(`completed_at is not a parsable timestamp: ${entry.completed_at}`);
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
