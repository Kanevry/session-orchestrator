/**
 * crypto-digest-utils.mjs — Shared SHA-256 digest helpers.
 *
 * Replaces inline `createHash('sha256')...` patterns in 6 modules.
 * Pure functions, no side effects, no async.
 *
 * Exports:
 *   digestSha256Short(input, options?)       → string (truncated hex, default 8 chars)
 *   digestSha256(input, options?)            → string (full hex digest)
 *   digestSha256WithSalt(value, options)     → string (salt + \x00 + value pattern)
 *   digestMultiBufferSha256(buffers, options?) → string (sequential multi-buffer update)
 */

import { createHash } from 'node:crypto';

/**
 * Compute a SHA-256 digest of `input` and return a truncated hex string.
 * The most common pattern: an 8-character hex prefix suitable as a stable
 * short identifier (e.g. schema hash, task dedup key).
 *
 * @param {string|Buffer} input  - Value to hash; coerced to string when not a Buffer.
 * @param {{ length?: number, encoding?: string }} [options]
 *   - `length`   Number of leading characters to return (default 8).
 *   - `encoding` Digest encoding passed to `hash.digest()` (default 'hex').
 * @returns {string} Truncated digest string.
 */
export function digestSha256Short(input, options = {}) {
  const length = options.length ?? 8;
  const encoding = options.encoding ?? 'hex';
  return createHash('sha256').update(String(input ?? '')).digest(encoding).slice(0, length);
}

/**
 * Compute the full SHA-256 digest of `input` without truncation.
 *
 * @param {string|Buffer} input  - Value to hash; coerced to string when not a Buffer.
 * @param {{ encoding?: string }} [options]
 *   - `encoding` Digest encoding passed to `hash.digest()` (default 'hex').
 * @returns {string} Full digest string.
 */
export function digestSha256(input, options = {}) {
  const encoding = options.encoding ?? 'hex';
  return createHash('sha256').update(String(input ?? '')).digest(encoding);
}

/**
 * Compute a SHA-256 digest using the `salt + \x00 + value` pattern.
 * Used for hostname hashing where a per-installation salt prevents
 * cross-installation correlation without knowing the salt.
 *
 * @param {string} value  - The value to hash (e.g. hostname).
 * @param {{ salt: string, encoding?: string }} options
 *   - `salt`     Required. The salt string prepended before a NUL separator.
 *   - `encoding` Digest encoding passed to `hash.digest()` (default 'hex').
 * @returns {string} Full digest string.
 * @throws {TypeError} When `options.salt` is not a string.
 */
export function digestSha256WithSalt(value, options) {
  if (!options || typeof options.salt !== 'string') {
    throw new TypeError('digestSha256WithSalt requires options.salt (string)');
  }
  const encoding = options.encoding ?? 'hex';
  return createHash('sha256')
    .update(options.salt)
    .update('\x00')
    .update(String(value ?? ''))
    .digest(encoding);
}

/**
 * Compute a SHA-256 digest by sequentially updating over an array of
 * buffers or strings. Preserves the exact update order of the original
 * multi-step `hash.update(a).update(b)...` patterns.
 *
 * @param {Array<string|Buffer>} buffers  - Ordered list of values to feed into the hash.
 * @param {{ encoding?: string }} [options]
 *   - `encoding` Digest encoding passed to `hash.digest()` (default 'hex').
 * @returns {string} Full digest string.
 * @throws {TypeError} When `buffers` is not an array.
 */
export function digestMultiBufferSha256(buffers, options = {}) {
  if (!Array.isArray(buffers)) {
    throw new TypeError('digestMultiBufferSha256 requires buffers (array)');
  }
  const encoding = options.encoding ?? 'hex';
  const h = createHash('sha256');
  for (const b of buffers) {
    h.update(b);
  }
  return h.digest(encoding);
}
