/**
 * hardening.mjs — env/runtime checks + scope/pattern primitives.
 *
 * Node.js port of the relevant functions from scripts/lib/hardening.sh.
 * Pure ESM. No zx dependency — lightweight for hook hot-paths.
 *
 * Part of v3.0.0 migration (Epic #124, issue #135).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveProjectDir } from './platform.mjs';

// ---------------------------------------------------------------------------
// A) Env / runtime checks
// ---------------------------------------------------------------------------

/**
 * Assert that the running Node.js version meets the minimum major version.
 * Throws an Error with a clear message if the current major is below `min`.
 * Returns void on success.
 *
 * @param {number} [min=20]
 * @returns {Promise<void>}
 */
export async function assertNodeVersion(min = 20) {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < min) {
    throw new Error(
      `Node.js ${min}+ is required, but found ${process.versions.node}. ` +
      `Please upgrade Node.js before running session-orchestrator scripts.`
    );
  }
}

/**
 * Check whether a Node module is importable.
 * Returns true on success, false on failure. Does NOT throw.
 *
 * @param {string} name — module name (e.g. "zx")
 * @returns {Promise<boolean>}
 */
export async function assertDepInstalled(name) {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run environment checks and return a structured result.
 *
 * Hard checks (ok = false if any fail):
 *   - Node >= 20
 *
 * Soft checks (warning only):
 *   - 'zx' importable
 *   - SO_PROJECT_DIR resolvable (resolveProjectDir returns a non-empty string)
 *
 * @returns {Promise<{ok: boolean, missing: string[], warnings: string[]}>}
 */
export async function checkEnvironment() {
  const missing = [];
  const warnings = [];

  // Hard: Node >= 20
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) {
    missing.push(`node>=20 (found ${process.versions.node})`);
  }

  // Soft: zx installed
  const hasZx = await assertDepInstalled('zx');
  if (!hasZx) {
    warnings.push("'zx' is not installed — run 'npm ci' in the plugin root before executing wave scripts.");
  }

  // Soft: SO_PROJECT_DIR resolvable
  const projectDir = resolveProjectDir();
  if (!projectDir) {
    warnings.push('SO_PROJECT_DIR could not be resolved — wave scripts may not locate the project root correctly.');
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// B) Scope / pattern primitives (used by Wave 3 hooks on hot-paths — all sync)
// ---------------------------------------------------------------------------

/**
 * Find the wave-scope.json file for the given project root.
 *
 * Precedence (mirrors find_scope_file in hardening.sh):
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
  for (const dir of ['.cursor', '.codex', '.claude']) {
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

  // Replace remaining `**` (not followed by /) with `.*`
  regex = regex.replace(/\*\*/g, '.*');

  // Step 3: Single * → one path segment (no slashes)
  regex = regex.replace(/\*/g, '[^/]*');

  // Step 4: Expand placeholders
  regex = regex.replace(/<<DBLS>>/g, '(.*\\/)?');

  // Step 5: Anchor
  regex = `^${regex}$`;

  return new RegExp(regex).test(relPath);
}

/**
 * Test whether a command string contains a blocked pattern with shell-aware boundaries.
 *
 * Match rule: boundary characters are whitespace OR shell operators
 * (`;`, `|`, `&`, `(`, `)`, `{`, `}`, backtick). This catches bypass attempts
 * like `ls;rm -rf /`, `ls&&rm -rf /`, `(rm -rf /)`, `` `rm -rf /` ``.
 * Case-sensitive.
 *
 * @param {string} command — full command string
 * @param {string} pattern — blocked pattern to search for
 * @returns {boolean}
 */
export function commandMatchesBlocked(command, pattern) {
  if (!pattern) return false;
  const escaped = pattern.replace(/[.*+?|[\](){}\\^$]/g, '\\$&');
  // Boundary class: whitespace + shell operators (; | & ( ) { } backtick).
  // A blocked pattern is detected if preceded/followed by any of these or by start/end of string.
  const boundary = '[\\s;|&(){}`]';
  return new RegExp(`(^|${boundary})${escaped}(${boundary}|$)`).test(command);
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

/**
 * Build an actionable suggestion string for a blocked command pattern.
 *
 * @param {string} pattern — the blocked command pattern
 * @returns {string}
 */
export function suggestForCommandBlock(pattern) {
  switch (pattern) {
    case 'rm -rf':
      return 'Destructive deletion is blocked. Move specific files instead or use trash-cli.';
    case 'git push --force':
    case 'git push -f':
      return "Force-push is blocked. Use 'git push --force-with-lease' after coordinator approval.";
    case 'git reset --hard':
      return "Hard reset is blocked. Use 'git reset --soft' or 'git stash' to preserve work.";
    case 'git checkout -- .':
      return 'Whole-tree discard is blocked. Target specific files instead.';
    default:
      return `Blocked command pattern '${pattern}' is not permitted during wave execution.`;
  }
}
