/**
 * subagents-schema.mjs — schema module for subagent lifecycle records.
 *
 * Mirrors learnings.mjs style: Zod-free, custom ValidationError, validate /
 * normalize / migrate / append / read functions. No top-level side effects.
 *
 * Part of issue #342 (PostToolUseFailure + PostToolBatch + SubagentStart/Stop
 * hook handlers). W1-Part1 scope: schema module only.
 *
 * Canonical schema (schema_version: 1):
 *   timestamp         ISO 8601 string — when the event occurred
 *   event             'start' | 'stop' — lifecycle event type
 *   agent_id          string — unique identifier for the subagent instance
 *   schema_version    1 (integer)
 *
 * Required for event='stop':
 *   duration_ms       positive integer — wall-clock time from start to stop
 *
 * Optional:
 *   agent_type        string | null — e.g. 'explore', 'writer', 'test-writer'
 *   parent_session_id string | null — session that spawned this subagent
 *   token_input       integer | null — prompt token count for this subagent
 *   token_output      integer | null — completion token count for this subagent
 */

import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current subagent-record schema version. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Allowed event values. */
export const VALID_EVENTS = Object.freeze(['start', 'stop']);

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
 * Validate a subagent record. Throws ValidationError on any constraint
 * violation. Does NOT mutate the input.
 *
 * Required fields: timestamp, event, agent_id, schema_version.
 * Additional requirement when event='stop': duration_ms (positive integer).
 * Optional: agent_type, parent_session_id, token_input, token_output.
 *
 * @param {object} entry
 * @returns {object} the entry (unchanged) — validation is side-effect-free
 * @throws {ValidationError}
 */
export function validateSubagent(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new ValidationError('subagent record must be a non-null object');
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

  // agent_id
  if (typeof entry.agent_id !== 'string' || !entry.agent_id.trim()) {
    throw new ValidationError('agent_id must be a non-empty string', 'agent_id');
  }

  // duration_ms — required for stop events
  if (entry.event === 'stop') {
    if (
      typeof entry.duration_ms !== 'number' ||
      !Number.isInteger(entry.duration_ms) ||
      entry.duration_ms < 0
    ) {
      throw new ValidationError(
        'duration_ms must be a non-negative integer when event=stop',
        'duration_ms',
      );
    }
  }

  // agent_type (optional)
  if (entry.agent_type !== undefined && entry.agent_type !== null && typeof entry.agent_type !== 'string') {
    throw new ValidationError('agent_type must be a string or null', 'agent_type');
  }

  // parent_session_id (optional)
  if (
    entry.parent_session_id !== undefined &&
    entry.parent_session_id !== null &&
    typeof entry.parent_session_id !== 'string'
  ) {
    throw new ValidationError('parent_session_id must be a string or null', 'parent_session_id');
  }

  // token_input (optional)
  if (entry.token_input !== undefined && entry.token_input !== null) {
    if (typeof entry.token_input !== 'number' || !Number.isInteger(entry.token_input) || entry.token_input < 0) {
      throw new ValidationError('token_input must be a non-negative integer or null', 'token_input');
    }
  }

  // token_output (optional)
  if (entry.token_output !== undefined && entry.token_output !== null) {
    if (typeof entry.token_output !== 'number' || !Number.isInteger(entry.token_output) || entry.token_output < 0) {
      throw new ValidationError('token_output must be a non-negative integer or null', 'token_output');
    }
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/**
 * Normalize a subagent record read from disk. Applies defaults for optional
 * fields so callers can treat legacy and new entries uniformly.
 * Does NOT throw — malformed entries are passed through unchanged.
 *
 * @param {object} entry
 * @returns {object} entry with optional fields defaulted to null / CURRENT_SCHEMA_VERSION
 */
export function normalizeSubagent(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return {
    ...entry,
    schema_version: entry.schema_version ?? CURRENT_SCHEMA_VERSION,
    agent_type: entry.agent_type ?? null,
    parent_session_id: entry.parent_session_id ?? null,
    token_input: entry.token_input ?? null,
    token_output: entry.token_output ?? null,
  };
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

/**
 * Migrate a legacy / partial subagent record to the canonical v1 shape.
 * Idempotent — calling it on an already-canonical record is a safe no-op.
 * No-op for v1; reserved for future schema bumps.
 *
 * The caller MUST still run validateSubagent() on the result before writing.
 *
 * @param {object} entry
 * @returns {object} record with schema_version stamped
 */
export function migrateLegacySubagent(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  if (out.schema_version === undefined || out.schema_version === null) {
    out.schema_version = CURRENT_SCHEMA_VERSION;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append a single subagent record to a JSONL file.
 *
 * Steps:
 *   1. Stamp schema_version if missing.
 *   2. Normalize (apply optional-field defaults).
 *   3. Validate — throws ValidationError on bad input.
 *   4. Serialize to JSON + newline.
 *   5. mkdir(dirname, recursive: true).
 *   6. appendFile (POSIX append ≤ PIPE_BUF is atomic for typical JSONL lines).
 *
 * @param {string} filePath — absolute path to target .jsonl file
 * @param {object} entry — candidate subagent record
 * @returns {Promise<object>} the validated + normalized entry that was written
 * @throws {ValidationError} when the entry fails schema validation
 */
export async function appendSubagent(filePath, entry) {
  const stamped = {
    ...entry,
    schema_version: entry?.schema_version ?? CURRENT_SCHEMA_VERSION,
  };
  const normalized = normalizeSubagent(stamped);
  const validated = validateSubagent(normalized);
  const line = JSON.stringify(validated) + '\n';
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, line, 'utf8');
  return validated;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read all valid subagent records from a JSONL file. Malformed lines are
 * skipped with a stderr warning — never throws.
 *
 * @param {string} filePath — absolute path to target .jsonl file
 * @returns {Promise<object[]>} array of normalized subagent records
 */
export async function readSubagents(filePath) {
  if (!existsSync(filePath)) return [];
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`[subagents-schema] WARN: could not read ${filePath}: ${err?.message ?? err}\n`);
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const entries = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      entries.push(normalizeSubagent(parsed));
    } catch {
      process.stderr.write(`[subagents-schema] WARN: skipping malformed JSONL line: ${line.slice(0, 120)}\n`);
    }
  }
  return entries;
}
