/**
 * owner-config/coerce.mjs — Strict-mode wrapper around validate().
 *
 * Imports: validate + OwnerConfigError. Throws on validation failure, returns
 * the normalized value on success. Convenient for CLI entrypoints and tests
 * that want to assert on success without inspecting `ok`.
 */

import { validate } from './validate.mjs';
import { OwnerConfigError } from './error.mjs';

/**
 * Strict-mode wrapper around validate(). Returns the normalized value when
 * the input passes the gate, otherwise throws OwnerConfigError with the
 * full error list attached as `.errors`.
 *
 * @param {unknown} raw
 * @returns {object}
 */
export function coerce(raw) {
  const result = validate(raw);
  if (!result.ok) {
    throw new OwnerConfigError(
      `owner config validation failed (${result.errors.length} error${result.errors.length === 1 ? '' : 's'})`,
      result.errors
    );
  }
  return result.value;
}
