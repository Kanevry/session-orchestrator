/**
 * learnings/schema.mjs — schema, validators, and migration for learnings entries.
 *
 * Extracted from scripts/lib/learnings.mjs (issue #358 Q3 follow-up).
 * Pure leaf module — imports only stdlib. No imports from sibling modules
 * (io.mjs, filters.mjs) or parent (../learnings.mjs). This breaks the
 * circular-import topology flagged by Q3 architect review.
 *
 * The parent ../learnings.mjs re-exports symbols from this module to
 * preserve the public API. Sibling modules (io.mjs, filters.mjs) import
 * directly from this file, NOT from ../learnings.mjs.
 *
 * Canonical schema (schema_version: 1) — ALL required fields:
 *   id            UUID v4 string (crypto.randomUUID())
 *   type          string — e.g. 'fragile-file', 'effective-sizing', 'recurring-issue'
 *   subject       string — pattern subject
 *   insight       string — human-readable description (NOT 'description'/'recommendation')
 *   evidence      string — data points supporting the pattern
 *   confidence    number [0, 1]
 *   source_session string — non-empty kebab-slug (e.g. 'main-2026-04-27-1942')
 *   created_at    ISO 8601 string
 *   expires_at    ISO 8601 string
 *   schema_version 1
 *
 * Extended fields (optional, defaulted on read):
 *   scope:                 'local' | 'private' | 'public'  (default: 'local')
 *   host_class:            string | null                   (default: null)
 *   anonymized:            boolean                         (default: false)
 *   anonymization_version: number | undefined              (bumped when redaction rules change)
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_SCOPES = Object.freeze(['local', 'private', 'public']);

/** Current anonymization ruleset version. Bump when C3 redaction rules change. */
export const CURRENT_ANONYMIZATION_VERSION = 1;

/**
 * Per-type TTL policy (in days) for `expires_at` derivation.
 * See parent module documentation for tier rationale and policy lookup contract.
 */
export const LEARNING_TTL_DAYS = Object.freeze({
  'mode-selector-accuracy': 30,
  'hardware-pattern': 60,
  'fragile-file': 45,
  'effective-sizing': 45,
  'recurring-issue': 45,
  'workflow-pattern': 90,
  'proven-pattern': 90,
  'anti-pattern': 90,
  'autopilot-effectiveness': 90,
  default: 60,
});

/**
 * Derive an ISO 8601 `expires_at` timestamp from `created_at` + type-specific TTL.
 *
 * Policy lookup: `LEARNING_TTL_DAYS[type] ?? LEARNING_TTL_DAYS.default`.
 * If `createdAt` is missing or unparseable, falls back to `new Date()`
 * (so a derivable expiry is always returned — the caller never gets undefined).
 *
 * @param {string|undefined} createdAt — ISO 8601 string or any Date.parse-able input
 * @param {string|undefined} type — learning record type
 * @returns {string} ISO 8601 expires_at
 */
export function deriveExpiresAt(createdAt, type) {
  const ttlDays = LEARNING_TTL_DAYS[type] ?? LEARNING_TTL_DAYS.default;
  let baseMs = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(baseMs)) {
    baseMs = Date.now();
  }
  return new Date(baseMs + ttlDays * 86400 * 1000).toISOString();
}

/**
 * Current learnings-record schema version.
 *
 * History:
 *  - 0: legacy pre-versioning shape (no `schema_version` field). Still accepted
 *       on read for backward compatibility. Treated as implicit v0.
 *  - 1: current shape. All NEW appends are stamped with `schema_version: 1`.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** Legacy schema fields expected on every learning (pre-v1). */
const LEGACY_REQUIRED_FIELDS = Object.freeze([
  'id',
  'type',
  'subject',
  'insight',
  'evidence',
  'confidence',
  'source_session',
  'created_at',
  'expires_at',
]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate a learning entry for writing. Enforces the privacy contract plus
 * basic shape checks on the legacy fields. Returns the (possibly normalized)
 * entry ready for JSONL serialization.
 *
 * Throws ValidationError on contract violations. Does NOT mutate input.
 *
 * @param {object} entry — candidate learning
 * @returns {object} normalized entry with scope/host_class/anonymized defaulted
 */
export function validateLearning(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new ValidationError('learning must be an object');
  }

  // schema_version: 0 (implicit/legacy), 1 (current). Both accepted.
  const schemaVersion = entry.schema_version ?? 0;
  if (schemaVersion !== 0 && schemaVersion !== 1) {
    throw new ValidationError(
      `schema_version must be 0 (legacy) or 1, got: ${schemaVersion}`
    );
  }

  for (const field of LEGACY_REQUIRED_FIELDS) {
    if (!(field in entry)) {
      throw new ValidationError(`learning missing required field: ${field}`);
    }
  }

  if (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1) {
    throw new ValidationError(`confidence must be a number in [0, 1], got: ${entry.confidence}`);
  }

  const scope = entry.scope ?? 'local';
  if (!VALID_SCOPES.includes(scope)) {
    throw new ValidationError(`scope must be one of ${VALID_SCOPES.join('|')}, got: ${scope}`);
  }

  const hostClass = entry.host_class ?? null;
  if (hostClass !== null && typeof hostClass !== 'string') {
    throw new ValidationError(`host_class must be string or null, got: ${typeof hostClass}`);
  }

  const anonymized = entry.anonymized ?? false;
  if (typeof anonymized !== 'boolean') {
    throw new ValidationError(`anonymized must be boolean, got: ${typeof anonymized}`);
  }

  // Privacy contract
  if (scope === 'public' && !anonymized) {
    throw new ValidationError(
      'scope=public requires anonymized=true (privacy contract violation)'
    );
  }
  if (scope === 'public' && hostClass === null) {
    throw new ValidationError(
      'scope=public requires host_class to be set (otherwise the entry cannot be grouped on export)'
    );
  }

  const normalized = {
    ...entry,
    schema_version: schemaVersion,
    scope,
    host_class: hostClass,
    anonymized,
  };

  if (anonymized && normalized.anonymization_version === undefined) {
    normalized.anonymization_version = CURRENT_ANONYMIZATION_VERSION;
  }
  if (!anonymized && 'anonymization_version' in normalized) {
    delete normalized.anonymization_version;
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Migrate a legacy learning record to the canonical schema_version:1 shape.
 * Idempotent — calling it on an already-canonical record is a safe no-op.
 *
 * Alias precedence for insight: insight > description > recommendation > observation > lesson
 *
 * The caller MUST still run validateLearning() on the result to confirm the
 * migrated record passes the full schema gate before writing.
 *
 * @param {object} entry — raw record from JSONL, possibly legacy shape
 * @returns {object} record with canonical field names (NOT validated)
 */
export function migrateLegacyLearning(entry) {
  if (!entry || typeof entry !== 'object') return entry;

  const out = { ...entry };

  if (!out.id) {
    out.id = randomUUID();
  }

  if (!out.subject && typeof out.name === 'string') {
    out.subject = out.name;
    delete out.name;
  } else if (out.subject && 'name' in out) {
    delete out.name;
  }

  if (!out.insight) {
    if (typeof out.description === 'string') {
      out.insight = out.description;
      delete out.description;
    } else if (typeof out.recommendation === 'string') {
      out.insight = out.recommendation;
      delete out.recommendation;
    } else if (typeof out.observation === 'string') {
      out.insight = out.observation;
      delete out.observation;
    } else if (typeof out.lesson === 'string') {
      out.insight = out.lesson;
      delete out.lesson;
    }
  } else {
    delete out.description;
    delete out.recommendation;
    delete out.observation;
    delete out.lesson;
  }

  if (!('evidence' in out)) {
    out.evidence = '';
  }

  const COERCIBLE_SCOPES = new Set(['vault-tools', 'deep-sessions', 'wave-executor', 'coordinator']);
  if (out.scope && !VALID_SCOPES.includes(out.scope) && COERCIBLE_SCOPES.has(out.scope)) {
    out.scope = 'local';
  }

  if (
    (out.source_session === undefined || out.source_session === null || out.source_session === '')
    && Array.isArray(out.sessions)
    && out.sessions.length > 0
    && typeof out.sessions[0] === 'string'
    && out.sessions[0].length > 0
  ) {
    out.source_session = out.sessions[0];
  }

  if (!('expires_at' in out) && typeof out.created_at === 'string') {
    const createdMs = Date.parse(out.created_at);
    if (!Number.isNaN(createdMs)) {
      out.expires_at = new Date(createdMs + 30 * 86400 * 1000).toISOString();
    }
  }

  if (out.schema_version === undefined || out.schema_version === null) {
    out.schema_version = CURRENT_SCHEMA_VERSION;
  }

  return out;
}

// Module-level dedupe sets for warnings (per-process).
const _warnedMissingSchemaVersion = new Set();
const _warnedMissingRequiredKeys = new Set();

/**
 * Normalize a learning entry read from disk. Applies defaults for the
 * extended fields so callers can treat legacy and new entries uniformly.
 * Does NOT throw — a malformed entry is passed through unchanged.
 *
 * @param {object} entry
 * @returns {object} entry with scope/host_class/anonymized defaulted
 */
export function normalizeLearning(entry) {
  if (!entry || typeof entry !== 'object') return entry;

  let schemaVersion;
  if ('schema_version' in entry && entry.schema_version !== undefined) {
    schemaVersion = entry.schema_version;
  } else {
    schemaVersion = 0;
    const warnKey = entry.id ?? '<unknown>';
    if (!_warnedMissingSchemaVersion.has(warnKey)) {
      _warnedMissingSchemaVersion.add(warnKey);
      console.error(
        `[learnings] WARN: record missing schema_version (id=${warnKey}); treating as schema_version=0 (pre-versioning legacy)`
      );
    }
  }

  const missing = LEGACY_REQUIRED_FIELDS.filter((f) => !(f in entry));
  if (missing.length > 0) {
    const warnId = entry.id ?? '<unknown>';
    const warnKey = `${warnId}|${missing.join(',')}`;
    if (!_warnedMissingRequiredKeys.has(warnKey)) {
      _warnedMissingRequiredKeys.add(warnKey);
      console.error(
        `[learnings] WARN: record missing required legacy field(s) [${missing.join(', ')}] (id=${warnId}); passing through unchanged`
      );
    }
  }

  return {
    ...entry,
    schema_version: schemaVersion,
    scope: entry.scope ?? 'local',
    host_class: entry.host_class ?? null,
    anonymized: entry.anonymized ?? false,
  };
}
