/**
 * learnings/schema.mjs — schema, validators, and migration for learnings entries.
 *
 * Extracted from scripts/lib/learnings.mjs (issue #358 Q3 follow-up).
 * Pure leaf module — imports only stdlib. No imports from sibling modules
 * (io.mjs, filters.mjs) or parent (../learnings.mjs). This breaks the
 * circular-import topology flagged by Q3 architect review. ("Pure leaf" refers
 * to the import graph, not side-effect purity: {@link normalizeDialects}
 * emits a deduped stderr WARN on a session_id/source_session conflict.)
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
 *   file_paths:            string[] | undefined            (repo-relative scope paths;
 *                                                           canonical rename of legacy `files`)
 *   updated_at:            ISO 8601 string | undefined      (canonical rename of legacy `last_seen`)
 *   evidence_sessions:     string[] | undefined            (OPTIONAL corroborating session ids;
 *                                                           a documented array field — never
 *                                                           collapsed into source_session)
 *
 * Producer-dialect normalization (Epic #723 B2 — {@link normalizeDialects}):
 *   Legacy producers emitted `files`, a duplicate `session_id`, `last_seen`,
 *   and a literal `next_review: null`. normalizeDialects() renames/reconciles
 *   these on every read (normalizeLearning) and every migration
 *   (migrateLegacyLearning) so downstream code sees ONE canonical shape. See
 *   the function doc for the exact rules. Note: `evidence` MAY legally be an
 *   array in some legacy records and is deliberately NOT coerced (validateLearning
 *   does not type-check it), so the shape is preserved verbatim.
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
  // autonomy-verdict (#683): repo/scope readiness synthesis from autopilot
  // effectiveness plus skill-judge signals. 90d matches the operational
  // autopilot-effectiveness horizon it depends on.
  'autonomy-verdict': 90,
  // domain-regression (#638): a sidecar-sourced regression flag (metric baseline→recent
  // delta) surfaced via /evolve extra-sources. 60d aligns with the moderate-decay tier
  // (hardware-pattern / default) — a regression signal should age out if it stops recurring.
  'domain-regression': 60,
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

/**
 * ISO-8601 timestamp fields re-serialized (verlustfrei, same instant) during
 * dialect normalization. A value Date.parse cannot handle is left verbatim.
 */
const TIMESTAMP_FIELDS = Object.freeze(['created_at', 'updated_at', 'expires_at', 'next_review']);

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

/** Module-level dedupe set for session_id↔source_session conflict warnings. */
const _warnedSessionIdConflict = new Set();

/**
 * Normalize known producer DIALECTS to the canonical schema shape. Deliberately
 * does NOT touch `schema_version`, `scope`, or the insight/subject alias chain —
 * schema_version stamping is a WRITE concern (migrateLegacyLearning /
 * appendLearning), and the alias chain lives in migrateLegacyLearning.
 *
 * Applied on BOTH the read funnel (normalizeLearning) and the migration/write
 * funnel (migrateLegacyLearning) so every reader and the backfill writer see a
 * single canonical shape. Pure except a deduped stderr WARN on a
 * session_id/source_session conflict (see below); idempotent; never throws;
 * non-objects (and arrays) pass through unchanged. Does NOT mutate its input.
 *
 * Dialect rules (Epic #723 B2 — census 2026-07-02):
 *   - `files`        → `file_paths`  — verbatim value move; an empty array is
 *                      preserved as an empty `file_paths`; a canonical
 *                      `file_paths` already present wins (legacy `files` dropped).
 *   - `session_id`   → dropped when it EXACTLY duplicates `source_session`; on a
 *                      genuine conflict, `source_session` is canonical, BOTH keys
 *                      are kept, and the conflict is logged once per record id.
 *                      An orphan `session_id` (no source_session) is left as-is.
 *   - `last_seen`    → `updated_at` ONLY when `updated_at` is missing/null; when
 *                      both are present, both are preserved.
 *   - `next_review`  literal `null` → key dropped entirely (a real timestamp is
 *                      kept and re-serialized when `reserializeTimestamps`).
 *   - timestamps     re-serialized via `new Date(x).toISOString()` (same instant,
 *                      canonical millis + `Z`) when parseable; left verbatim
 *                      otherwise. Gated by `reserializeTimestamps` (default true):
 *                      the READ funnel + the backfill canonicalize timestamp
 *                      FORMAT, but `migrateLegacyLearning` passes `false` to keep
 *                      its existing byte-exact "does not overwrite an existing
 *                      expires_at" contract — a schema/alias migration must not
 *                      silently reformat a caller's timestamps.
 *
 * Documented NON-actions (invariants callers rely on):
 *   - `evidence_sessions[]` is an OPTIONAL array field — never collapsed here.
 *   - `evidence` may legally be an array in some legacy records — NOT coerced.
 *
 * @param {object} entry — raw record (possibly a producer dialect shape)
 * @param {{ reserializeTimestamps?: boolean }} [opts] — when false, timestamp
 *        fields are left byte-exact (used by migrateLegacyLearning).
 * @returns {object} record with dialects normalized (schema_version untouched)
 */
export function normalizeDialects(entry, { reserializeTimestamps = true } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;

  const out = { ...entry };

  // files → file_paths (verbatim value move; canonical wins; empty array kept).
  if ('files' in out) {
    if (!('file_paths' in out)) {
      out.file_paths = out.files;
    }
    delete out.files;
  }

  // session_id reconciliation against the canonical source_session.
  if ('session_id' in out) {
    const hasSource =
      typeof out.source_session === 'string' && out.source_session.length > 0;
    if (hasSource && out.session_id === out.source_session) {
      // Exact duplicate — drop the redundant alias.
      delete out.session_id;
    } else if (hasSource && out.session_id !== out.source_session) {
      // Genuine conflict: source_session wins; keep BOTH; warn once per id.
      const warnKey = out.id ?? '<unknown>';
      if (!_warnedSessionIdConflict.has(warnKey)) {
        _warnedSessionIdConflict.add(warnKey);
        console.error(
          `[learnings] WARN: session_id (${out.session_id}) conflicts with source_session (${out.source_session}) (id=${warnKey}); source_session wins, keeping both`
        );
      }
    }
    // No source_session present → leave the orphan session_id untouched.
  }

  // last_seen → updated_at only when updated_at is absent/null; else keep both.
  if ('last_seen' in out) {
    const updMissing = out.updated_at === undefined || out.updated_at === null;
    if (updMissing) {
      out.updated_at = out.last_seen;
      delete out.last_seen;
    }
  }

  // next_review literal null → drop the key entirely.
  if (out.next_review === null) {
    delete out.next_review;
  }

  // Timestamp re-serialization — canonicalize to millis + Z, same instant.
  // Skipped when the caller (migrateLegacyLearning) needs byte-exact timestamps.
  if (reserializeTimestamps) {
    for (const field of TIMESTAMP_FIELDS) {
      const v = out[field];
      if (typeof v === 'string' && v.length > 0) {
        const ms = Date.parse(v);
        if (Number.isFinite(ms)) {
          out[field] = new Date(ms).toISOString();
        }
      }
    }
  }

  return out;
}

/**
 * Migrate a legacy learning record to the canonical schema_version:1 shape.
 * Idempotent — calling it on an already-canonical record is a safe no-op.
 *
 * Alias precedence for insight: insight > description > recommendation > observation > lesson
 *
 * Producer dialects (`files`→`file_paths`, duplicate `session_id`, `last_seen`,
 * `next_review: null`) are normalized by {@link normalizeDialects} as the final
 * step. Timestamp FORMAT is deliberately NOT reformatted here (byte-exact
 * contract preserved); the read funnel + backfill canonicalize timestamps.
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

  // Normalize producer dialects last (files→file_paths, session_id/last_seen/
  // next_review reconciliation) — schema_version is preserved by normalizeDialects.
  // reserializeTimestamps:false keeps migrateLegacyLearning's byte-exact timestamp
  // contract (it does schema/alias migration, not timestamp reformatting). The
  // READ funnel (normalizeLearning) and the backfill canonicalize timestamp format.
  return normalizeDialects(out, { reserializeTimestamps: false });
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

  // Normalize producer dialects (files→file_paths, session_id/last_seen/
  // next_review reconciliation, timestamp re-serialization) so every reader
  // sees the canonical scope key. schema_version behaviour is UNCHANGED:
  // normalizeDialects never touches it, and a missing version still reads as 0.
  const d = normalizeDialects(entry);

  let schemaVersion;
  if ('schema_version' in d && d.schema_version !== undefined) {
    schemaVersion = d.schema_version;
  } else {
    schemaVersion = 0;
    const warnKey = d.id ?? '<unknown>';
    if (!_warnedMissingSchemaVersion.has(warnKey)) {
      _warnedMissingSchemaVersion.add(warnKey);
      console.error(
        `[learnings] WARN: record missing schema_version (id=${warnKey}); treating as schema_version=0 (pre-versioning legacy)`
      );
    }
  }

  const missing = LEGACY_REQUIRED_FIELDS.filter((f) => !(f in d));
  if (missing.length > 0) {
    const warnId = d.id ?? '<unknown>';
    const warnKey = `${warnId}|${missing.join(',')}`;
    if (!_warnedMissingRequiredKeys.has(warnKey)) {
      _warnedMissingRequiredKeys.add(warnKey);
      console.error(
        `[learnings] WARN: record missing required legacy field(s) [${missing.join(', ')}] (id=${warnId}); passing through unchanged`
      );
    }
  }

  return {
    ...d,
    schema_version: schemaVersion,
    scope: d.scope ?? 'local',
    host_class: d.host_class ?? null,
    anonymized: d.anonymized ?? false,
  };
}
