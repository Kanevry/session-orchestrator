/**
 * owner-config/error.mjs — OwnerConfigError class.
 *
 * Leaf module. No imports. Thrown by coerce() when validation fails. The
 * `.errors` array carries the full list of human-readable failure messages
 * collected by validate().
 */

export class OwnerConfigError extends Error {
  /**
   * @param {string} message
   * @param {string[]} [errors]
   */
  constructor(message, errors = []) {
    super(message);
    this.name = 'OwnerConfigError';
    this.errors = errors;
  }
}
