/**
 * session-schema.mjs — canonical schema lock for sessions.jsonl entries.
 *
 * Issues #249, #304. Companion to `scripts/lib/learnings.mjs`. Plain-JS
 * validator + normalizer for session records written to
 * `.orchestrator/metrics/sessions.jsonl`. No Zod — plain-JS matches the
 * repo convention for script-layer utilities.
 *
 * ── CANONICAL SCHEMA (schema_version: 1) ─────────────────────────────────
 *
 * Two historical shapes coexist in sessions.jsonl on disk (#304: 73% of
 * records were mirror-invalid before the migration helper shipped):
 *
 *   OLD SHAPE (pre-v3, schema_version: 0 or absent):
 *     agents_dispatched   number   — total agents scheduled (scalar)
 *     agents_complete     number   — succeeded
 *     agents_partial      number   — partial success
 *     agents_failed       number   — failed
 *     waves_completed     number   — scalar wave count (no array)
 *
 *   NEW SHAPE (v3+, schema_version: 1) — THIS IS THE CANONICAL SHAPE:
 *     total_agents        number   — sum of all dispatched agents
 *     total_files_changed number   — total files touched across all waves
 *     agent_summary       object   — { complete, partial, failed, spiral }
 *     waves               array    — [{ wave, role, ...waveMetrics }]
 *
 * Required fields for a valid schema_version=1 record:
 *   session_id, session_type, started_at, completed_at,
 *   total_waves, waves, agent_summary, total_agents, total_files_changed
 *
 * Migration: `scripts/migrate-sessions-jsonl.mjs` maps old → new shape.
 * Backfill (apply to entire file): `scripts/backfill-sessions.mjs`.
 *
 * ── CONTRACT SUMMARY ─────────────────────────────────────────────────────
 *
 *   validateSession(entry):
 *     Throws ValidationError on required-field/type/range violations.
 *     Returns a NEW object with `schema_version` stamped to
 *     CURRENT_SESSION_SCHEMA_VERSION (1) if absent. Unknown fields pass
 *     through (additive contract). Does NOT apply SESSION_KEY_ALIASES.
 *     Used by scripts/emit-session.mjs as the write-path gate — any entry
 *     that fails validation is rejected before it reaches disk.
 *
 *   normalizeSession(entry):
 *     Never throws. Applies SAFE key aliases (same-shape renames only).
 *     Missing `schema_version` on read is tagged as 0 (pre-versioning
 *     legacy, distinct from CURRENT_SESSION_SCHEMA_VERSION=1 stamped on
 *     new writes). Emits a deduplicated WARN per session_id per process.
 *
 * Unsafe value-transforming aliases (e.g., `waves_executed` scalar →
 * `waves` array, `duration_min` → `duration_seconds`) are explicitly OUT
 * of scope here and belong in the migration / backfill scripts.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Current session-record schema version. New writes are stamped with this
 * value by validateSession. Records read without `schema_version` are tagged
 * as 0 (pre-versioning legacy) by normalizeSession.
 */
export const CURRENT_SESSION_SCHEMA_VERSION = 1;

/**
 * Safe key aliases — same-shape renames only (no value transformation).
 * Applied by normalizeSession on read so legacy records can be consumed by
 * canonical-key consumers without rewriting the file.
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

const VALID_SESSION_TYPES = Object.freeze(['feature', 'deep', 'housekeeping']);

const REQUIRED_FIELDS = Object.freeze([
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

const AGENT_SUMMARY_FIELDS = Object.freeze(['complete', 'partial', 'failed', 'spiral']);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Pre-validation repair helpers (issue #321)
// ---------------------------------------------------------------------------

/**
 * Clamp `completed_at` to be >= `started_at` when an inversion is detected.
 *
 * Defends against clock skew, manual STATE.md frontmatter edits, and any
 * other writer that produces a `completed_at < started_at` violation. Rather
 * than throw and lose the session record entirely, we mathematically clamp
 * `completed_at` to equal `started_at` (duration = 0) and tag the entry with
 * forensics fields so the original timestamp is recoverable.
 *
 * Behaviour:
 *   - If either field is absent, return the entry unchanged (let validate
 *     surface the missing-field error).
 *   - If either field is unparsable, return the entry unchanged (validate
 *     will surface the parse error with a clearer message).
 *   - If `completed_at >= started_at`, return the entry unchanged.
 *   - Otherwise return a NEW object with:
 *       completed_at: <started_at>
 *       _clamped: true
 *       _original_completed_at: <orig completed_at>
 *
 * Never throws. Caller is responsible for emitting any warning log.
 *
 * @param {object} entry — session record (may be the raw input)
 * @returns {object} either the original entry (no clamp needed) or a NEW
 *                   object with clamp applied + forensics fields
 */
export function clampTimestampsMonotonic(entry) {
  if (!isPlainObject(entry)) return entry;
  if (typeof entry.started_at !== 'string' || typeof entry.completed_at !== 'string') {
    return entry;
  }
  const startedMs = Date.parse(entry.started_at);
  const completedMs = Date.parse(entry.completed_at);
  if (Number.isNaN(startedMs) || Number.isNaN(completedMs)) return entry;
  if (completedMs >= startedMs) return entry;
  return {
    ...entry,
    completed_at: entry.started_at,
    _clamped: true,
    _original_completed_at: entry.completed_at,
  };
}

/**
 * Migrate legacy `ended_at` + `duration_ms` shape to canonical
 * `completed_at` (issue #321). Some pre-canonical writers produced records
 * with `ended_at` instead of `completed_at`; this helper aliases the field
 * so the canonical validator does not reject the record on a missing
 * required field.
 *
 * Behaviour:
 *   - If `completed_at` is absent and `ended_at` is a string, alias
 *     `completed_at <- ended_at`.
 *   - If both `completed_at` and `ended_at` are present and DIFFER, prefer
 *     `completed_at` (do not overwrite) and tag `_completed_at_conflict: true`
 *     for forensics.
 *   - If both `completed_at` and `started_at` end up present, drop the now-
 *     redundant `duration_ms` (derivable; canonical schema uses
 *     `duration_seconds`).
 *
 * Never throws. Returns either the original entry (no migration needed) or
 * a NEW object with the migration applied.
 *
 * @param {object} entry — session record
 * @returns {object} either the original entry or a NEW object
 */
export function aliasLegacyEndedAt(entry) {
  if (!isPlainObject(entry)) return entry;
  const hasCompleted = typeof entry.completed_at === 'string';
  const hasEnded = typeof entry.ended_at === 'string';
  if (!hasCompleted && !hasEnded) return entry;

  let next = entry;

  if (!hasCompleted && hasEnded) {
    next = { ...entry, completed_at: entry.ended_at };
  } else if (hasCompleted && hasEnded && entry.completed_at !== entry.ended_at) {
    next = { ...entry, _completed_at_conflict: true };
  }

  // Drop derivable duration_ms once we have both start + completed.
  if (
    'duration_ms' in next &&
    typeof next.completed_at === 'string' &&
    typeof next.started_at === 'string'
  ) {
    if (next === entry) next = { ...entry };
    delete next.duration_ms;
  }

  return next;
}

// ---------------------------------------------------------------------------
// validateSession sub-validators (module-private)
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
    throw new ValidationError(`total_waves must be a non-negative number, got: ${entry.total_waves}`);
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
    if (!Array.isArray(entry.issues_closed) || entry.issues_closed.some((n) => typeof n !== 'number')) {
      throw new ValidationError('issues_closed must be an array of numbers');
    }
  }
  if (entry.issues_created !== undefined) {
    if (!Array.isArray(entry.issues_created) || entry.issues_created.some((n) => typeof n !== 'number')) {
      throw new ValidationError('issues_created must be an array of numbers');
    }
  }
}

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

// ---------------------------------------------------------------------------
// Normalization (read path)
// ---------------------------------------------------------------------------

// Module-level dedupe for missing-schema_version warnings.
// Keyed by session_id (or '<unknown>'). Each unique id warns at most once
// per process, preventing log-spam on large sessions.jsonl files.
const _warnedMissingSchemaVersion = new Set();

/**
 * Normalize a session entry read from disk. Applies SAFE key aliases, tags
 * legacy entries without `schema_version` as 0 (distinct from
 * CURRENT_SESSION_SCHEMA_VERSION=1 which is stamped on new writes).
 *
 * Never throws. Malformed input (null, non-object, array) is passed through
 * unchanged. Original keys are preserved alongside their canonical alias for
 * debugging.
 *
 * @param {any} entry
 * @returns {any} normalized entry (or original if non-object)
 */
export function normalizeSession(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;

  const next = { ...entry };

  // Apply safe key aliases (same-shape renames). Preserve the old key.
  for (const [oldKey, newKey] of Object.entries(SESSION_KEY_ALIASES)) {
    if (oldKey in next && !(newKey in next)) {
      next[newKey] = next[oldKey];
    }
  }

  // schema_version — legacy entries tagged as 0 (NOT CURRENT_SESSION_SCHEMA_VERSION).
  if ('schema_version' in next && next.schema_version !== undefined) {
    // Preserve existing version.
  } else {
    next.schema_version = 0;
    const warnKey = next.session_id ?? '<unknown>';
    if (!_warnedMissingSchemaVersion.has(warnKey)) {
      _warnedMissingSchemaVersion.add(warnKey);
      console.error(
        `[sessions] WARN: record missing schema_version (session_id=${warnKey}); treating as schema_version=0 (pre-versioning legacy)`
      );
    }
  }

  return next;
}
