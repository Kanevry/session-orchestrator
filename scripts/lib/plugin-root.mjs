/**
 * plugin-root.mjs — Robust plugin root resolution with layered fallback.
 *
 * Issue #212: manual installs may not have CLAUDE_PLUGIN_ROOT set. This module
 * provides a deterministic, testable resolution strategy so hook handlers and
 * scripts never silently fall back to an empty path or wrong directory.
 *
 * Fallback order (stops at first success):
 *   1. PLUGIN_ROOT native env var
 *   2. Compatibility root matching explicit SO_PLATFORM
 *   3. Remaining Claude, Codex, Cursor, and Pi compatibility roots
 *   4. Walk up from import.meta.url looking for package.json whose name === "session-orchestrator"
 *   5. Walk up from process.cwd() looking for the same marker
 *
 * Throws PluginRootResolutionError when all resolution levels fail.
 *
 * Backward compat: without native or explicit platform inputs, compatibility
 * roots retain their legacy Claude → Codex → Cursor → Pi order.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPATIBILITY_ROOTS = [
  ['claude', 'CLAUDE_PLUGIN_ROOT'],
  ['codex', 'CODEX_PLUGIN_ROOT'],
  ['cursor', 'CURSOR_RULES_DIR'],
  ['pi', 'PI_PLUGIN_ROOT'],
];
const VALID_PLATFORMS = new Set(COMPATIBILITY_ROOTS.map(([platform]) => platform));

// ---------------------------------------------------------------------------
// PluginRootResolutionError
// ---------------------------------------------------------------------------

/**
 * Thrown when all resolution levels fail. Callers may inspect
 * `error.triedPaths` to understand what was attempted.
 */
export class PluginRootResolutionError extends Error {
  /**
   * @param {string} message
   * @param {string[]} triedPaths  Directories / env vars that were checked
   */
  constructor(message, triedPaths = []) {
    super(message);
    this.name = 'PluginRootResolutionError';
    this.triedPaths = triedPaths;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return true when `dir` is an existing directory.
 * @param {string} dir
 * @returns {boolean}
 */
function _isDir(dir) {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * Return a trimmed allowlisted platform or null.
 * @param {string|undefined} value
 * @returns {"claude"|"codex"|"cursor"|"pi"|null}
 */
function _validPlatform(value) {
  const platform = (value || '').trim();
  if (!VALID_PLATFORMS.has(platform)) return null;
  return /** @type {"claude"|"codex"|"cursor"|"pi"} */ (platform);
}

/**
 * Resolve one environment path, recording why it was skipped.
 * @param {string} envName
 * @param {string[]} tried
 * @returns {string|null}
 */
function _envDirectory(envName, tried) {
  const rawValue = process.env[envName];
  const value = (rawValue || '').trim();

  if (!value) {
    tried.push(rawValue === undefined
      ? `${envName} (not set)`
      : `${envName} (empty after trim)`);
    return null;
  }

  if (_isDir(value)) return value;
  tried.push(`${envName}=${value} (not a directory)`);
  return null;
}

/**
 * Order compatibility roots by explicit platform, then an optional caller hint,
 * while retaining the legacy Claude → Codex → Cursor → Pi order for the rest.
 * @param {string|undefined} platformHint
 * @returns {Array<[string, string]>}
 */
function _orderedCompatibilityRoots(platformHint) {
  const preferredPlatform = _validPlatform(process.env.SO_PLATFORM) ?? _validPlatform(platformHint);
  if (!preferredPlatform) return COMPATIBILITY_ROOTS;

  const matching = COMPATIBILITY_ROOTS.filter(([platform]) => platform === preferredPlatform);
  const remaining = COMPATIBILITY_ROOTS.filter(([platform]) => platform !== preferredPlatform);
  return [...matching, ...remaining];
}

/**
 * Return true when `dir` contains a package.json whose `name` field equals
 * `"session-orchestrator"`. Silently returns false on any read/parse error.
 *
 * @param {string} dir  Candidate directory to inspect
 * @returns {boolean}
 */
function _isPluginRoot(dir) {
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    return pkg.name === 'session-orchestrator';
  } catch {
    return false;
  }
}

/**
 * Walk up the directory tree from `startDir`, testing each directory with
 * `_isPluginRoot`. Returns the matching directory path or `null`.
 *
 * Terminates at the filesystem root ("/", "C:\\", etc.) or when the parent
 * path stops changing (guard against edge cases).
 *
 * @param {string} startDir  Absolute directory to begin walking from
 * @returns {string|null}
 */
function _walkUp(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (_isPluginRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // safety guard
    dir = parent;
  }

  // Check root itself
  if (_isPluginRoot(root)) return root;

  return null;
}

// ---------------------------------------------------------------------------
// resolvePluginRoot
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the session-orchestrator plugin directory.
 *
 * Fallback order:
 *   1. Trimmed native PLUGIN_ROOT when it is an existing directory
 *   2. Compatibility root matching a valid explicit SO_PLATFORM
 *   3. Remaining compatibility roots in legacy order
 *   4. Walk up from import.meta.url (the location of this file) looking for a
 *      package.json with name "session-orchestrator"
 *   5. Walk up from process.cwd() looking for the same marker
 *
 * @param {string} [platformHint] Optional compatibility hint for wrapper callers
 * @returns {string} Absolute path to the plugin root
 * @throws {PluginRootResolutionError} When all resolution levels fail
 */
export function resolvePluginRoot(platformHint) {
  const tried = [];

  // Level 1: native root identifies location only; platform detection is separate.
  const nativeRoot = _envDirectory('PLUGIN_ROOT', tried);
  if (nativeRoot) return nativeRoot;

  // Levels 2-5: prefer the compatibility root matching explicit SO_PLATFORM.
  for (const [, envName] of _orderedCompatibilityRoots(platformHint)) {
    const compatibilityRoot = _envDirectory(envName, tried);
    if (compatibilityRoot) return compatibilityRoot;
  }

  // Level 6: walk up from this file's location
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const byImportMeta = _walkUp(thisDir);
  if (byImportMeta) return byImportMeta;
  tried.push(`walk from import.meta.url (${thisDir}) — no package.json{name:session-orchestrator} found`);

  // Level 7: walk up from cwd
  const byCwd = _walkUp(process.cwd());
  if (byCwd) return byCwd;
  tried.push(`walk from cwd (${process.cwd()}) — no package.json{name:session-orchestrator} found`);

  throw new PluginRootResolutionError(
    'Could not resolve session-orchestrator plugin root. ' +
    'Set PLUGIN_ROOT, CLAUDE_PLUGIN_ROOT, CODEX_PLUGIN_ROOT, CURSOR_RULES_DIR, or PI_PLUGIN_ROOT ' +
    'to the plugin directory, or ensure a package.json with name "session-orchestrator" exists in an ' +
    'ancestor of the cwd or this script. Attempted: ' + tried.join('; '),
    tried,
  );
}
