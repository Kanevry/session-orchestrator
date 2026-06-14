/**
 * skill-judgments-schema.mjs — schema module for skill-applied JUDGMENT records (L3).
 *
 * Mirrors skill-invocations-schema.mjs style: Zod-free, custom ValidationError,
 * validate / normalize / append / read functions. No top-level side effects.
 *
 * SEPARATE schema, SEPARATE file from skill-invocations-schema.mjs. That module's
 * VALID_EVENTS is frozen to ['selected'] (L1 selection telemetry); this module's
 * VALID_EVENTS is frozen to ['judged'] (L3 LLM-judge advisory output). Do NOT
 * cross-import or merge the two — they record different events at different layers.
 *
 * Part of epic #645 (A — L3: opt-in session-end LLM-judge of skill application).
 *
 * Canonical schema (schema_version: 1):
 *   timestamp         ISO 8601 string — when the judgment was emitted
 *   event             'judged' — the judgment event
 *   skill             string (non-empty) — the skill being judged
 *   session_id        string | null — the session the judgment pertains to
 *   applied           'yes' | 'no' | 'unknown' — was the skill actually applied?
 *   completed         'yes' | 'no' | 'unknown' — did the skill's work complete?
 *   confidence        number in [0, 1] — judge confidence
 *   advisory          true (literal) — schema-level guarantee this NEVER gates an action
 *   model             string — model identifier that produced the judgment
 *   schema_version    1 (integer)
 *
 * Default JSONL path: .orchestrator/metrics/skill-judgments.jsonl
 */

import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current skill-judgment record schema version. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Allowed event values. Frozen to 'judged' — distinct from skill-invocations' 'selected'. */
export const VALID_EVENTS = Object.freeze(['judged']);

/** Tri-state enum for the applied/completed judgment fields. */
export const VALID_TRISTATE = Object.freeze(['yes', 'no', 'unknown']);

/** Default JSONL path for skill judgment records. */
export const DEFAULT_SKILL_JUDGMENTS_PATH = '.orchestrator/metrics/skill-judgments.jsonl';

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
 * Validate a skill-judgment record. Throws ValidationError on any constraint
 * violation. Does NOT mutate the input.
 *
 * Required fields: timestamp, event, skill, applied, completed, confidence,
 * advisory, model, schema_version.
 * Optional: session_id.
 *
 * @param {object} entry
 * @returns {object} the entry (unchanged) — validation is side-effect-free
 * @throws {ValidationError}
 */
export function validateSkillJudgment(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new ValidationError('skill-judgment record must be a non-null object');
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

  // applied (tri-state)
  if (!VALID_TRISTATE.includes(entry.applied)) {
    throw new ValidationError(
      `applied must be one of ${VALID_TRISTATE.join('|')}, got: ${entry.applied}`,
      'applied',
    );
  }

  // completed (tri-state)
  if (!VALID_TRISTATE.includes(entry.completed)) {
    throw new ValidationError(
      `completed must be one of ${VALID_TRISTATE.join('|')}, got: ${entry.completed}`,
      'completed',
    );
  }

  // confidence — number in [0, 1]
  if (
    typeof entry.confidence !== 'number' ||
    Number.isNaN(entry.confidence) ||
    entry.confidence < 0 ||
    entry.confidence > 1
  ) {
    throw new ValidationError(
      `confidence must be a number in [0, 1], got: ${entry.confidence}`,
      'confidence',
    );
  }

  // advisory — MUST be the literal boolean true. This is a schema-level guarantee
  // that an L3 judgment can NEVER be wired into an auto-action gate (#645 R9(b)).
  if (entry.advisory !== true) {
    throw new ValidationError(
      `advisory must be the literal value true (advisory-only guarantee), got: ${entry.advisory}`,
      'advisory',
    );
  }

  // model
  if (typeof entry.model !== 'string' || !entry.model.trim()) {
    throw new ValidationError('model must be a non-empty string', 'model');
  }

  // session_id (optional)
  if (
    entry.session_id !== undefined &&
    entry.session_id !== null &&
    typeof entry.session_id !== 'string'
  ) {
    throw new ValidationError('session_id must be a string or null', 'session_id');
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/**
 * Normalize a skill-judgment record read from disk. Applies defaults for
 * optional fields so callers can treat legacy and new entries uniformly.
 * Does NOT throw — malformed entries are passed through unchanged.
 *
 * @param {object} entry
 * @returns {object} entry with optional fields defaulted
 */
export function normalizeSkillJudgment(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return {
    ...entry,
    schema_version: entry.schema_version ?? CURRENT_SCHEMA_VERSION,
    session_id: entry.session_id ?? null,
    advisory: entry.advisory ?? true,
  };
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append a single skill-judgment record to a JSONL file.
 *
 * Steps:
 *   1. Stamp schema_version + advisory:true if missing.
 *   2. Normalize (apply optional-field defaults).
 *   3. Validate — throws ValidationError on bad input.
 *   4. Serialize to JSON + newline.
 *   5. mkdir(dirname, recursive: true).
 *   6. appendFile (POSIX append <= PIPE_BUF is atomic for typical JSONL lines).
 *
 * Signature mirrors the (record, { path }) call shape the L3 coordinator uses;
 * `path` defaults to DEFAULT_SKILL_JUDGMENTS_PATH (repo-relative) when omitted.
 *
 * @param {object} record — candidate skill-judgment record
 * @param {{path?: string}} [opts] — target file path (absolute preferred)
 * @returns {Promise<object>} the validated + normalized entry that was written
 * @throws {ValidationError} when the entry fails schema validation
 */
export async function appendSkillJudgment(record, { path: filePath = DEFAULT_SKILL_JUDGMENTS_PATH } = {}) {
  const stamped = {
    ...record,
    schema_version: record?.schema_version ?? CURRENT_SCHEMA_VERSION,
    advisory: record?.advisory ?? true,
  };
  const normalized = normalizeSkillJudgment(stamped);
  const validated = validateSkillJudgment(normalized);
  const line = JSON.stringify(validated) + '\n';
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, line, 'utf8');
  return validated;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read all skill-judgment records from a JSONL file. Malformed lines are
 * skipped with a stderr warning — never throws. Returns [] when the file is
 * absent (existsSync-guarded).
 *
 * @param {string} [filePath] — absolute path to target .jsonl file
 * @returns {Promise<object[]>} array of normalized skill-judgment records
 */
export async function readSkillJudgments(filePath = DEFAULT_SKILL_JUDGMENTS_PATH) {
  if (!existsSync(filePath)) return [];
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`[skill-judgments-schema] WARN: could not read ${filePath}: ${err?.message ?? err}\n`);
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const entries = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      entries.push(normalizeSkillJudgment(parsed));
    } catch {
      process.stderr.write(`[skill-judgments-schema] WARN: skipping malformed JSONL line: ${line.slice(0, 120)}\n`);
    }
  }
  return entries;
}
