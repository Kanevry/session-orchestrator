/**
 * skill-invocations-schema.mjs — schema module for skill-invocation selection records.
 *
 * Mirrors subagents-schema.mjs style: Zod-free, custom ValidationError, validate /
 * normalize / append / read functions. No top-level side effects.
 *
 * Part of epic #645 (A — L1 telemetry: skill-invocation selection).
 *
 * Canonical schema (schema_version: 1):
 *   timestamp         ISO 8601 string — when the Skill tool was invoked
 *   event             'selected' — the selection event
 *   skill             string — the skill name passed to the Skill tool
 *   session_id        string | null — the session that invoked the skill
 *   schema_version    1 (integer)
 *
 * Optional:
 *   phase             string | null — orchestration phase if derivable from context
 *
 * Default JSONL path: .orchestrator/metrics/skill-invocations.jsonl
 */

import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current skill-invocation record schema version. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Allowed event values. */
export const VALID_EVENTS = Object.freeze(['selected']);

/** Default JSONL path for skill invocation records. */
export const DEFAULT_SKILL_INVOCATIONS_PATH = '.orchestrator/metrics/skill-invocations.jsonl';

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {string|undefined} field — optional field name that triggered the error
   */
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * Validate a skill-invocation record. Throws ValidationError on any constraint
 * violation. Does NOT mutate the input.
 *
 * Required fields: timestamp, event, skill, schema_version.
 * Optional: session_id, phase.
 *
 * @param {object} entry
 * @returns {object} the entry (unchanged) — validation is side-effect-free
 * @throws {ValidationError}
 */
export function validateSkillInvocation(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new ValidationError('skill-invocation record must be a non-null object');
  }

  // schema_version
  if (entry.schema_version !== CURRENT_SCHEMA_VERSION) {
    throw new ValidationError(
      `schema_version must be ${CURRENT_SCHEMA_VERSION}, got: ${entry.schema_version}`,
      'schema_version',
    );
  }

  // timestamp
  if (typeof entry.timestamp !== 'string' || !entry.timestamp.trim()) {
    throw new ValidationError('timestamp must be a non-empty ISO 8601 string', 'timestamp');
  }
  if (Number.isNaN(Date.parse(entry.timestamp))) {
    throw new ValidationError(
      `timestamp is not a valid ISO 8601 date: ${entry.timestamp}`,
      'timestamp',
    );
  }

  // event
  if (!VALID_EVENTS.includes(entry.event)) {
    throw new ValidationError(
      `event must be one of ${VALID_EVENTS.join('|')}, got: ${entry.event}`,
      'event',
    );
  }

  // skill
  if (typeof entry.skill !== 'string' || !entry.skill.trim()) {
    throw new ValidationError('skill must be a non-empty string', 'skill');
  }

  // session_id (optional)
  if (
    entry.session_id !== undefined &&
    entry.session_id !== null &&
    typeof entry.session_id !== 'string'
  ) {
    throw new ValidationError('session_id must be a string or null', 'session_id');
  }

  // phase (optional)
  if (
    entry.phase !== undefined &&
    entry.phase !== null &&
    typeof entry.phase !== 'string'
  ) {
    throw new ValidationError('phase must be a string or null', 'phase');
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/**
 * Normalize a skill-invocation record read from disk. Applies defaults for
 * optional fields so callers can treat legacy and new entries uniformly.
 * Does NOT throw — malformed entries are passed through unchanged.
 *
 * @param {object} entry
 * @returns {object} entry with optional fields defaulted to null / CURRENT_SCHEMA_VERSION
 */
export function normalizeSkillInvocation(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return {
    ...entry,
    schema_version: entry.schema_version ?? CURRENT_SCHEMA_VERSION,
    session_id: entry.session_id ?? null,
    phase: entry.phase ?? null,
  };
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append a single skill-invocation record to a JSONL file.
 *
 * Steps:
 *   1. Stamp schema_version if missing.
 *   2. Normalize (apply optional-field defaults).
 *   3. Validate — throws ValidationError on bad input.
 *   4. Serialize to JSON + newline.
 *   5. mkdir(dirname, recursive: true).
 *   6. appendFile (POSIX append <= PIPE_BUF is atomic for typical JSONL lines).
 *
 * @param {string} filePath — absolute path to target .jsonl file
 * @param {object} entry — candidate skill-invocation record
 * @returns {Promise<object>} the validated + normalized entry that was written
 * @throws {ValidationError} when the entry fails schema validation
 */
export async function appendSkillInvocation(filePath, entry) {
  const stamped = {
    ...entry,
    schema_version: entry?.schema_version ?? CURRENT_SCHEMA_VERSION,
  };
  const normalized = normalizeSkillInvocation(stamped);
  const validated = validateSkillInvocation(normalized);
  const line = JSON.stringify(validated) + '\n';
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, line, 'utf8');
  return validated;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read all valid skill-invocation records from a JSONL file. Malformed lines
 * are skipped with a stderr warning — never throws.
 *
 * @param {string} filePath — absolute path to target .jsonl file
 * @returns {Promise<object[]>} array of normalized skill-invocation records
 */
export async function readSkillInvocations(filePath) {
  if (!existsSync(filePath)) return [];
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`[skill-invocations-schema] WARN: could not read ${filePath}: ${err?.message ?? err}\n`);
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const entries = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      entries.push(normalizeSkillInvocation(parsed));
    } catch {
      process.stderr.write(`[skill-invocations-schema] WARN: skipping malformed JSONL line: ${line.slice(0, 120)}\n`);
    }
  }
  return entries;
}
