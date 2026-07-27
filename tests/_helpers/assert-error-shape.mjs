/**
 * tests/_helpers/assert-error-shape.mjs
 *
 * Bundles the assertions every named-error-class contract repeats:
 * prototype chain, `.name`, `.message`, and (where the class carries one)
 * `.code`.
 *
 * ## Why this exists
 *
 * Nine test files independently spelled out the same quartet — `is an instance
 * of Error` / `stores the provided code` / `has .name === X` / `stores the
 * message` — one `it()` block per assertion. That is 4 test blocks proving one
 * contract. Folding them into a single block that calls this helper keeps the
 * SAME assertions (identical catch-power: a class that forgets `this.name` or
 * drops `code` still turns the block RED) while removing the per-file
 * boilerplate.
 *
 * ## Why it takes an INSTANCE, not the class
 *
 * Constructor signatures are not uniform across the codebase:
 *   new ReconcileError(message, code)       // message-first
 *   new ProfileRegistryError(code, message) // code-first
 *   new OwnerConfigError(message, errors)   // message + extra payload
 * A class-first helper would need a per-call adapter anyway, so the caller
 * constructs the error and hands the instance over. Class-specific extras
 * (`.kind`, `.errors`, `.triedPaths`, …) stay as their own assertions in the
 * caller — this helper covers ONLY the shared quartet.
 */

import { expect } from 'vitest';

/**
 * @param {unknown} err - the constructed error instance under test
 * @param {object} expected
 * @param {string} expected.name - required; expected `err.name`
 * @param {string} expected.message - required; expected `err.message`
 * @param {string} [expected.code] - when present, expected `err.code`
 * @param {Function} [expected.ctor] - when present, also asserts `instanceof ctor`
 */
export function assertErrorShape(err, { name, message, code, ctor } = {}) {
  if (typeof name !== 'string' || typeof message !== 'string') {
    throw new TypeError('assertErrorShape: `name` and `message` are required strings');
  }

  expect(err).toBeInstanceOf(Error);
  if (ctor) expect(err).toBeInstanceOf(ctor);
  expect(err.name).toBe(name);
  expect(err.message).toBe(message);
  if (code !== undefined) expect(err.code).toBe(code);
}
