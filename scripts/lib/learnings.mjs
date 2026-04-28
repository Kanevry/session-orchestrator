/**
 * learnings.mjs — v3.1.0 schema-extended learnings writer/reader.
 *
 * Part of v3.1.0 Epic #157, Sub-Epic #160 (Hardware-Pattern Learnings + Privacy Tiers).
 * Issue #170 (C1). Schema drift fix: #303.
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
 *
 * Privacy contract (enforced by validateLearning):
 *   - scope=local   → never exported. May contain absolute paths, host info.
 *   - scope=private → in-repo only. No host identifying info.
 *   - scope=public  → export-safe. anonymized=true is REQUIRED.
 *
 * Legacy field aliases handled by migrateLegacyLearning():
 *   description   → insight (lrn-2026-04-25-xxx writer)
 *   recommendation → insight (retro/supabase writer)
 *   missing id    → crypto.randomUUID()
 *   missing schema_version → 1
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_SCOPES = Object.freeze(['local', 'private', 'public']);

/** Current anonymization ruleset version. Bump when C3 redaction rules change. */
export const CURRENT_ANONYMIZATION_VERSION = 1;

/**
 * Current learnings-record schema version.
 *
 * Records are tagged with `schema_version` at write time. Records without the
 * field (legacy, pre-versioning) are read as `schema_version: 0`.
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

  // anonymization_version is only meaningful when anonymized=true. If the
  // caller omitted it while setting anonymized=true, stamp the current
  // version so downstream consumers can track redaction-rule changes.
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
 * Transformations applied:
 *   - `description` → `insight` (lrn-2026-04-25-xxx writer format)
 *   - `recommendation` → `insight` (retro/supabase writer format)
 *   - Missing `id` → `crypto.randomUUID()`
 *   - Missing `schema_version` → 1
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

  // Backfill id with a stable UUID when missing
  if (!out.id) {
    out.id = randomUUID();
  }

  // Normalize insight aliases: description | recommendation → insight
  if (!out.insight) {
    if (typeof out.description === 'string') {
      out.insight = out.description;
      delete out.description;
    } else if (typeof out.recommendation === 'string') {
      out.insight = out.recommendation;
      delete out.recommendation;
    }
  } else {
    // insight is present — clean up stale alias keys to avoid confusion
    delete out.description;
    delete out.recommendation;
  }

  // Stamp schema_version when absent
  if (out.schema_version === undefined || out.schema_version === null) {
    out.schema_version = CURRENT_SCHEMA_VERSION;
  }

  return out;
}

// Module-level dedupe set for schema-version warnings.
// Keyed by record `id` (or '<unknown>' for records without an id) so each
// legacy record warns at most once per process, even if normalizeLearning is
// called multiple times (e.g., during readLearnings + filter helpers).
const _warnedMissingSchemaVersion = new Set();

// Same contract for required-key warnings (issue #281). Keyed by
// `<id>|<sorted-missing-fields>` so distinct shapes for the same id still
// warn once, but repeated reads of the same shape stay silent.
const _warnedMissingRequiredKeys = new Set();

/**
 * Normalize a learning entry read from disk. Applies defaults for the
 * extended fields so callers can treat legacy and new entries uniformly.
 * Does NOT throw — a malformed entry is passed through unchanged (readers
 * already handle legacy shapes).
 *
 * @param {object} entry
 * @returns {object} entry with scope/host_class/anonymized defaulted
 */
export function normalizeLearning(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  // Records without `schema_version` are pre-versioning (legacy). Tag as v0.
  // Warn once per unique id per process so operators can spot-check the fleet
  // without log-spam on large files. Never throw.
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

  // Required-key surface (issue #281). Legacy records may silently miss fields
  // that validateLearning() would reject on write. Reader path is never-throw,
  // so emit a dedupe'd WARN so operators can spot legacy drift without spam.
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

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read all learnings from the given JSONL path. Returns normalized entries
 * (missing extended fields are defaulted). Malformed lines are skipped with
 * their raw text preserved in the result's `malformed` array.
 *
 * @param {string} filePath — absolute or project-relative path to learnings.jsonl
 * @returns {Promise<{entries: object[], malformed: string[]}>}
 */
export async function readLearnings(filePath) {
  if (!existsSync(filePath)) return { entries: [], malformed: [] };
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const entries = [];
  const malformed = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      entries.push(normalizeLearning(parsed));
    } catch {
      malformed.push(line);
    }
  }
  return { entries, malformed };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Append a single validated learning to the JSONL file. Returns the
 * validated (normalized) entry. Creates the parent directory if missing.
 *
 * All records are validated against `schema_version: 1` requirements
 * before appending. New records missing `schema_version` are auto-stamped
 * with `CURRENT_SCHEMA_VERSION` prior to validation so every newly written
 * line carries a version tag.
 *
 * Atomic append via write-temp-then-concat is NOT used here — JSONL
 * lines shorter than PIPE_BUF (~4KB on Linux, ~512B on macOS) are
 * atomic on POSIX append. For very large insight/evidence fields that
 * might exceed that boundary, use rewriteLearnings() instead.
 *
 * @param {string} filePath
 * @param {object} entry
 * @returns {Promise<object>} validated entry
 */
export async function appendLearning(filePath, entry) {
  const stamped = {
    ...entry,
    schema_version: entry?.schema_version ?? CURRENT_SCHEMA_VERSION,
  };
  const validated = validateLearning(stamped);
  const line = JSON.stringify(validated) + '\n';
  await mkdir(path.dirname(filePath), { recursive: true });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(filePath, line, 'utf8');
  return validated;
}

/**
 * Atomically rewrite the entire JSONL file from a validated entries array.
 * Use when bulk-updating (prune + decay + new appends all at once). Mirrors
 * the shell behavior of `jq | ... > tmp && mv tmp learnings.jsonl`.
 *
 * @param {string} filePath
 * @param {object[]} entries
 * @returns {Promise<object[]>} validated entries written
 */
export async function rewriteLearnings(filePath, entries) {
  const validated = entries.map((e) =>
    validateLearning({
      ...e,
      schema_version: e?.schema_version ?? CURRENT_SCHEMA_VERSION,
    })
  );
  const body = validated.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, filePath);
  return validated;
}

// ---------------------------------------------------------------------------
// Filtering helpers (used by C3 export + /evolve hardware-pattern queries)
// ---------------------------------------------------------------------------

/**
 * Filter learnings by scope. Returns a new array.
 * @param {object[]} entries
 * @param {string|string[]} scope
 * @returns {object[]}
 */
export function filterByScope(entries, scope) {
  const scopes = Array.isArray(scope) ? scope : [scope];
  return entries.filter((e) => scopes.includes(normalizeLearning(e).scope));
}

/**
 * Filter learnings by host_class. Returns a new array.
 * @param {object[]} entries
 * @param {string} hostClass
 * @returns {object[]}
 */
export function filterByHostClass(entries, hostClass) {
  return entries.filter((e) => normalizeLearning(e).host_class === hostClass);
}

/**
 * Filter learnings by type.
 * @param {object[]} entries
 * @param {string} type
 * @returns {object[]}
 */
export function filterByType(entries, type) {
  return entries.filter((e) => e.type === type);
}
