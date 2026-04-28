/**
 * plugin-root.mjs — Robust CLAUDE_PLUGIN_ROOT resolution with 4-level fallback.
 *
 * Issue #212: manual installs may not have CLAUDE_PLUGIN_ROOT set. This module
 * provides a deterministic, testable resolution strategy so hook handlers and
 * scripts never silently fall back to an empty path or wrong directory.
 *
 * Fallback order (stops at first success):
 *   1. CLAUDE_PLUGIN_ROOT  env var (Claude Code)
 *   2. CODEX_PLUGIN_ROOT   env var (Codex CLI)
 *   3. Walk up from import.meta.url looking for package.json whose name === "session-orchestrator"
 *   4. Walk up from process.cwd() looking for the same marker
 *
 * Throws PluginRootResolutionError when all four levels fail.
 *
 * Backward compat: when CLAUDE_PLUGIN_ROOT is set it is returned immediately —
 * no filesystem walk is performed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// PluginRootResolutionError
// ---------------------------------------------------------------------------

/**
 * Thrown when all four resolution levels fail. Callers may inspect
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
 *   1. CLAUDE_PLUGIN_ROOT  env var — returned immediately when set (backward compat)
 *   2. CODEX_PLUGIN_ROOT   env var — returned immediately when set
 *   3. Walk up from import.meta.url (the location of this file) looking for a
 *      package.json with name "session-orchestrator"
 *   4. Walk up from process.cwd() looking for the same marker
 *
 * @returns {string} Absolute path to the plugin root
 * @throws {PluginRootResolutionError} When all four levels fail
 */
export function resolvePluginRoot() {
  const tried = [];

  // Level 1: CLAUDE_PLUGIN_ROOT
  const claudeRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (claudeRoot) {
    if (_isDir(claudeRoot)) return claudeRoot;
    tried.push(`CLAUDE_PLUGIN_ROOT=${claudeRoot} (not a directory)`);
  } else {
    tried.push('CLAUDE_PLUGIN_ROOT (not set)');
  }

  // Level 2: CODEX_PLUGIN_ROOT
  const codexRoot = process.env.CODEX_PLUGIN_ROOT;
  if (codexRoot) {
    if (_isDir(codexRoot)) return codexRoot;
    tried.push(`CODEX_PLUGIN_ROOT=${codexRoot} (not a directory)`);
  } else {
    tried.push('CODEX_PLUGIN_ROOT (not set)');
  }

  // Level 3: walk up from this file's location
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const byImportMeta = _walkUp(thisDir);
  if (byImportMeta) return byImportMeta;
  tried.push(`walk from import.meta.url (${thisDir}) — no package.json{name:session-orchestrator} found`);

  // Level 4: walk up from cwd
  const byCwd = _walkUp(process.cwd());
  if (byCwd) return byCwd;
  tried.push(`walk from cwd (${process.cwd()}) — no package.json{name:session-orchestrator} found`);

  throw new PluginRootResolutionError(
    'Could not resolve session-orchestrator plugin root. ' +
    'Set CLAUDE_PLUGIN_ROOT (or CODEX_PLUGIN_ROOT) to the plugin directory, ' +
    'or ensure a package.json with name "session-orchestrator" exists in an ' +
    'ancestor of the cwd or this script. Attempted: ' + tried.join('; '),
    tried,
  );
}
