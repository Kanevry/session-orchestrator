/**
 * path-utils.mjs — Path-traversal-safe helpers for cross-platform use.
 *
 * SECURITY-CRITICAL: Backs enforce-scope.mjs (CWE-23 protection).
 *
 * Most functions are pure (no filesystem I/O). The exception is
 * validatePathInsideProject, which performs a two-phase lexical + realpath
 * guard and calls realpathSync on Phase 2. All other exported helpers remain
 * pure and do not follow symlinks.
 *
 * Part of v3.0.0 migration (Epic #124, issue #130).
 */

import path from 'node:path';
import { realpathSync } from 'node:fs';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Documented attack patterns covered by isPathInside.
 * Exported for test self-check (Wave 4) and audit documentation.
 */
export const CWE_23_ATTACK_PATTERNS = [
  'relative-escape',         // ../
  'deep-relative-escape',    // ../../
  'absolute-escape',         // /etc/passwd when parent is /home/user
  'prefix-match-confusion',  // /home/userx vs /home/user (not a descendant)
  'windows-drive-escape',    // C:\..\Windows
  'case-mismatch',           // Windows Foo vs foo (locale-aware)
  'cross-drive',             // C:\ vs D:\
  'unc-path',                // \\server\share (Windows — unconditionally rejected)
  'null-byte-injection',     // embedded \x00 (rejected via input guard)
];

function _assertNonEmptyString(value, fnName, argName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fnName}: ${argName} must be a non-empty string`);
  }
  if (value.includes('\x00')) {
    throw new TypeError(`${fnName}: ${argName} must not contain null bytes`);
  }
}

function _normalizeForCompare(p) {
  // Locale-stable lowercasing on Windows to match filesystem case-insensitivity.
  // toLocaleLowerCase('en-US') avoids Turkish-I style divergence from toLowerCase().
  return IS_WINDOWS ? p.toLocaleLowerCase('en-US') : p;
}

/**
 * Returns true if child is strictly inside parent (descendant, not equal).
 *
 * Rejects: relative/absolute escapes, UNC paths on Windows, null bytes, empty inputs.
 * Case-insensitive on Windows (locale-stable).
 *
 * @param {string} child — path to test
 * @param {string} parent — containing path
 * @returns {boolean}
 * @throws {TypeError} on invalid input (empty, null-byte, non-string)
 */
export function isPathInside(child, parent) {
  _assertNonEmptyString(child, 'isPathInside', 'child');
  _assertNonEmptyString(parent, 'isPathInside', 'parent');

  // Unconditionally reject UNC paths on Windows as child input.
  if (IS_WINDOWS && (child.startsWith('\\\\') || child.startsWith('//'))) {
    return false;
  }

  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const pa = _normalizeForCompare(resolvedParent);
  const ch = _normalizeForCompare(resolvedChild);
  const rel = path.relative(pa, ch);

  // Descendant iff: non-empty relative path, no leading '..', and not absolute.
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Returns relative path from root to fullPath.
 *
 * Return contract:
 *   - `'.'`        → fullPath IS root (same directory)
 *   - `'<rel>'`    → fullPath is strictly inside root
 *   - `null`       → fullPath is outside root
 *
 * Callers MUST distinguish `null` from `'.'` — do not use falsy checks.
 *
 * @param {string} root
 * @param {string} fullPath
 * @returns {string|null}
 */
export function relativeFromRoot(root, fullPath) {
  _assertNonEmptyString(root, 'relativeFromRoot', 'root');
  _assertNonEmptyString(fullPath, 'relativeFromRoot', 'fullPath');

  const resolvedRoot = path.resolve(root);
  const resolvedFull = path.resolve(fullPath);

  if (_normalizeForCompare(resolvedRoot) === _normalizeForCompare(resolvedFull)) {
    return '.';
  }
  if (!isPathInside(fullPath, root)) {
    return null;
  }
  return path.relative(resolvedRoot, resolvedFull);
}

/**
 * Lowercase on Windows (locale-stable), passthrough on POSIX.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizeCase(p) {
  _assertNonEmptyString(p, 'normalizeCase', 'p');
  return _normalizeForCompare(p);
}

/**
 * Returns true if two paths reside on the same drive.
 * On POSIX, always returns true (single-root filesystem).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameDrive(a, b) {
  _assertNonEmptyString(a, 'sameDrive', 'a');
  _assertNonEmptyString(b, 'sameDrive', 'b');
  if (!IS_WINDOWS) return true;
  const rootA = path.parse(path.resolve(a)).root.toLowerCase();
  const rootB = path.parse(path.resolve(b)).root.toLowerCase();
  return rootA === rootB;
}

/**
 * Two-phase path-traversal + symlink-escape guard.
 * Phase 1: lexical isPathInside check (rejects ../ traversal).
 * Phase 2: realpath resolution + isPathInside (rejects symlink escape).
 * ENOENT in Phase 2 is swallowed — lexical check is sufficient when path does not yet exist.
 *
 * @param {string} input - User-supplied path (relative or absolute)
 * @param {string} root - Trusted parent directory (absolute)
 * @returns {{ok: true, realPath: string|undefined, lexicalPath: string} | {ok: false, reason: 'lexical'|'symlink'|'input', error?: string}}
 */
export function validatePathInsideProject(input, root) {
  // 1. Input validation
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'input', error: 'input must be a non-empty string' };
  }
  if (input.includes('\0')) {
    return { ok: false, reason: 'input', error: 'input contains null byte' };
  }
  // 2. Phase 1: lexical
  const lexicalPath = path.resolve(root, input);
  if (!isPathInside(lexicalPath, root)) {
    return { ok: false, reason: 'lexical' };
  }
  // 3. Phase 2: realpath (ENOENT swallowed; other errors propagate — SEC-Q2-LOW-1)
  try {
    const realPath = realpathSync(lexicalPath);
    if (!isPathInside(realPath, root)) {
      return { ok: false, reason: 'symlink' };
    }
    return { ok: true, realPath, lexicalPath };
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
    return { ok: true, realPath: undefined, lexicalPath };
  }
}
