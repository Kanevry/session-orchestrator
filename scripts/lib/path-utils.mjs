/**
 * path-utils.mjs — Path-traversal-safe helpers for cross-platform use.
 *
 * SECURITY-CRITICAL: Backs enforce-scope.mjs (CWE-23 protection).
 *
 * All functions are pure (no filesystem I/O). Callers must resolve symlinks
 * explicitly if symlink semantics are relevant — this module does NOT follow
 * symlinks to avoid TOCTOU vulnerabilities.
 *
 * Part of v3.0.0 migration (Epic #124, issue #130).
 */

import path from 'node:path';

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
