/**
 * scope-gate.mjs — scope / pattern primitives.
 *
 * Split out of scripts/lib/hardening.mjs (concern B). Used by Wave 3 hooks on
 * hot-paths — all sync. Re-exported by hardening.mjs as a barrel so existing
 * importers keep working unchanged.
 *
 * Layering: hook-safe — pure functions only; no I/O at import time;
 * ESM-pure for fast hook hot-paths. Hooks (under `hooks/`) import from
 * this lib; this lib MUST NOT reverse-import from `hooks/`. Cross-cutting
 * invariant for all exports below — see #554 A2.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Find the wave-scope.json file for the given project root.
 *
 * Precedence (mirrors find_scope_file in hardening.sh):
 *   <root>/.pi/wave-scope.json
 *   <root>/.cursor/wave-scope.json
 *   <root>/.codex/wave-scope.json
 *   <root>/.claude/wave-scope.json
 *
 * Returns the absolute path string, or null if none exist.
 * Sync (uses fs.existsSync).
 *
 * @param {string} projectRoot — absolute path to project root
 * @returns {string|null}
 */
export function findScopeFile(projectRoot) {
  for (const dir of ['.pi', '.cursor', '.codex', '.claude']) {
    const candidate = path.join(projectRoot, dir, 'wave-scope.json');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Read the enforcement level from a scope file.
 * Defaults to "strict" (fail-closed) on parse error or missing field.
 * Sync. Never throws.
 *
 * @param {string} scopeFilePath — absolute path to wave-scope.json
 * @returns {string}
 */
export function getEnforcementLevel(scopeFilePath) {
  try {
    const data = JSON.parse(readFileSync(scopeFilePath, 'utf8'));
    return data.enforcement ?? 'strict';
  } catch {
    return 'strict';
  }
}

/**
 * Check whether a named gate is enabled in the scope file.
 * Returns true if the field is missing or true, false only if explicitly false.
 * Sync. Never throws.
 *
 * @param {string} scopeFilePath — absolute path to wave-scope.json
 * @param {string} gateName — key within .gates
 * @returns {boolean}
 */
export function gateEnabled(scopeFilePath, gateName) {
  try {
    const data = JSON.parse(readFileSync(scopeFilePath, 'utf8'));
    const gates = data.gates;
    if (gates === undefined || gates === null) return true;
    const value = gates[gateName];
    if (value === undefined || value === null) return true;
    return value !== false;
  } catch {
    return true;
  }
}

/**
 * Test whether a relative file path matches a single glob-style pattern.
 *
 * Supported patterns:
 *   - `prefix/`       — directory prefix: any file under prefix/ (including nested)
 *   - `src/**\/*.ts`  — recursive glob: `**` = any depth (including zero dirs)
 *   - `src/*.ts`      — single-segment glob: `*` = one segment (no slashes)
 *   - `path/to/file`  — exact match
 *
 * Conversion order:
 *   1. Escape all regex special chars EXCEPT `*` and `/`.
 *   2. Replace `**` with `<<DBL>>` placeholder.
 *   3. Replace remaining `*` with `[^/]*` (single segment).
 *   4. Replace `<<DBL>>` with `.*` (any depth).
 *   5. Anchor: `^...$`.
 *
 * Case-sensitive. Empty pattern returns false.
 *
 * Hook-safe: pure, deterministic, no I/O. Current importers (grep-verified
 * #554 A2): hooks/wave-scope-commit-guard.mjs, hooks/enforce-scope.mjs,
 * scripts/lib/worktree-freshness.mjs, scripts/lib/pre-dispatch-check.mjs.
 *
 * @param {string} relPath
 * @param {string} pattern
 * @returns {boolean}
 */
export function pathMatchesPattern(relPath, pattern) {
  if (!pattern) return false;

  // Directory prefix shortcut: pattern ends with '/'
  if (pattern.endsWith('/')) {
    return relPath.startsWith(pattern);
  }

  // Build a regex from the glob pattern.
  // Step 1: Escape regex special chars (everything except * and /)
  const specialChars = /[.+?|[\](){}\\^$]/g;
  let regex = pattern.replace(specialChars, (ch) => `\\${ch}`);

  // Step 2: Replace `**/` with placeholder (matches zero-or-more dir segments WITH trailing slash)
  // `src/**/foo` must match `src/foo` (zero dirs) and `src/a/b/foo` (two dirs).
  // Replacing `**/` → `(.*\/)?` captures "any number of segments + slash, or nothing".
  regex = regex.replace(/\*\*\//g, '<<DBLS>>');

  // Replace remaining `**` (not followed by /) with a second placeholder.
  // MUST use a placeholder (not `.*` directly) — the single-* pass below would otherwise
  // re-process the `*` quantifier in `.*`, yielding `.[^/]*` which blocks nested paths
  // under `tests/**` etc. (issue #220).
  regex = regex.replace(/\*\*/g, '<<DBLG>>');

  // Step 3: Single * → one path segment (no slashes)
  regex = regex.replace(/\*/g, '[^/]*');

  // Step 4: Expand placeholders
  regex = regex.replace(/<<DBLS>>/g, '(.*\\/)?');
  regex = regex.replace(/<<DBLG>>/g, '.*');

  // Step 5: Anchor
  regex = `^${regex}$`;

  return new RegExp(regex).test(relPath);
}

/**
 * Build an actionable suggestion string for a scope violation.
 *
 * @param {string} relPath — the relative path that was blocked
 * @param {string} allowedCsv — comma-separated list of allowed paths (may be empty)
 * @returns {string}
 */
export function suggestForScopeViolation(relPath, allowedCsv) {
  if (!allowedCsv) {
    return (
      `No paths are currently allowed for this wave. ` +
      `If '${relPath}' is in-scope, update the session plan and restart the wave.`
    );
  }
  return (
    `Allowed paths: [${allowedCsv}]. ` +
    `If '${relPath}' belongs to this wave, add its directory to the plan's wave scope and restart.`
  );
}
