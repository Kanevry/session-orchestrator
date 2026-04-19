/**
 * learnings.mjs — v3.1.0 schema-extended learnings writer/reader.
 *
 * Part of v3.1.0 Epic #157, Sub-Epic #160 (Hardware-Pattern Learnings + Privacy Tiers).
 * Issue #170 (C1).
 *
 * Schema additions on top of the legacy 9-field shape:
 *   - scope:                 'local' | 'private' | 'public'  (default: 'local')
 *   - host_class:            string | null                   (default: null)
 *   - anonymized:            boolean                         (default: false)
 *   - anonymization_version: number | undefined              (bumped when redaction rules change)
 *
 * Privacy contract (enforced by validateLearning):
 *   - scope=local   → never exported. May contain absolute paths, host info.
 *   - scope=private → in-repo only. No host identifying info.
 *   - scope=public  → export-safe. anonymized=true is REQUIRED.
 *
 * Backward compat:
 *   - Existing entries without scope/host_class/anonymized are read as
 *     {scope: 'local', host_class: null, anonymized: false}. No migration
 *     needed — the legacy JSONL lines are valid on re-read without rewrite.
 *
 * Existing writers (skills/evolve/, skills/session-end/) keep emitting
 * legacy shapes via shell. Only new writers that opt into the extended
 * fields need to use this module. The upgrade path is additive.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_SCOPES = Object.freeze(['local', 'private', 'public']);

/** Current anonymization ruleset version. Bump when C3 redaction rules change. */
export const CURRENT_ANONYMIZATION_VERSION = 1;

/** Legacy schema fields expected on every learning. */
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

  const normalized = { ...entry, scope, host_class: hostClass, anonymized };

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
  return {
    ...entry,
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
  const validated = validateLearning(entry);
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
  const validated = entries.map((e) => validateLearning(e));
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
