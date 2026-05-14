/**
 * test-runner/fingerprint.mjs — Stable fingerprinting for test findings.
 *
 * Deterministic hashing of (scope, checkId, locator) tuples enabling
 * idempotent issue creation across test runs. Leaf module — only imports
 * crypto-digest-utils.mjs (no I/O, no side effects).
 *
 * Exports:
 *   fingerprintFinding({scope, checkId, locator})  → 16-char hex string
 */

import { digestSha256 } from '../crypto-digest-utils.mjs';

/**
 * Compute a stable 16-character hex fingerprint for a finding.
 *
 * @param {object} opts
 * @param {string} opts.scope - finding scope (e.g., 'a11y', 'console', 'onboarding')
 * @param {string} opts.checkId - check identifier (e.g., 'axe-color-contrast', 'step-count-over-7')
 * @param {string} opts.locator - DOM selector or AX path
 * @returns {string} 16-char hex fingerprint
 * @throws {TypeError} if any arg is not a string
 */
export function fingerprintFinding({ scope, checkId, locator }) {
  if (typeof scope !== 'string' || typeof checkId !== 'string' || typeof locator !== 'string') {
    throw new TypeError('fingerprintFinding: scope, checkId, and locator must all be strings');
  }
  // Newline separator: forbidden in CLI args per ARG_BOUNDARY_DANGEROUS, so it
  // cannot collide with input content.
  const joined = [scope, checkId, locator].join('\n');
  const full = digestSha256(joined);
  return full.slice(0, 16);
}
