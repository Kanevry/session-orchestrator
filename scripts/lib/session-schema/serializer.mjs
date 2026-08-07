/**
 * session-schema/serializer.mjs — checked JSONL serialization for session records.
 *
 * Leaf module for the session-schema library. It imports the validator directly
 * so the serializer can be used by library consumers without depending on the
 * parent barrel or the CLI entry point.
 */

import { ValidationError, validateSession } from './validator.mjs';

function normalizeCaughtValue(value) {
  try {
    if (value instanceof Error) {
      return typeof value.message === 'string' ? value.message : String(value.message);
    }
    return String(value);
  } catch {
    return 'unknown thrown value';
  }
}

/**
 * Serialize a session record to one JSONL line and prove that it round-trips.
 *
 * JSON.stringify may silently drop values such as `undefined`, `NaN`, or
 * `Infinity`; the parsed-back value is therefore validated before the line is
 * returned. The validator's return value is deliberately discarded because it
 * may stamp `schema_version: 2` onto an otherwise unversioned input.
 *
 * @param {unknown} input — session record to serialize
 * @returns {string} the verified JSONL line (newline-terminated)
 * @throws {ValidationError} when serialization or round-trip validation fails
 */
export function serializeSessionLineChecked(input) {
  let line;
  try {
    line = JSON.stringify(input);
  } catch (err) {
    throw new ValidationError(`session is not JSON-serializable: ${normalizeCaughtValue(err)}`);
  }
  if (typeof line !== 'string' || line.length === 0) {
    throw new ValidationError('session serialized to an empty line');
  }
  let reparsed;
  try {
    reparsed = JSON.parse(line);
  } catch (err) {
    throw new ValidationError(
      `serialized session line does not parse back as JSON: ${normalizeCaughtValue(err)}`
    );
  }
  validateSession(reparsed);
  return line + '\n';
}
