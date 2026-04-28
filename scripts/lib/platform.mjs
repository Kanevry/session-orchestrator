/**
 * platform.mjs — platform detection for session-orchestrator (Node.js port of platform.sh)
 * ESM-importable. Uses only Node built-ins. No external dependencies.
 *
 * Exports 10 constants + 5 named helper functions:
 *   SO_PLATFORM, SO_PLUGIN_ROOT, SO_PROJECT_DIR, SO_STATE_DIR, SO_CONFIG_FILE,
 *   SO_SHARED_DIR, SO_OS, SO_IS_WINDOWS, SO_IS_WSL, SO_PATH_SEP
 *   detectPlatform, resolvePluginRoot, resolveProjectDir, resolveStateDir, resolveConfigFile
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  resolvePluginRoot as _resolvePluginRootRobust,
  PluginRootResolutionError,
} from './plugin-root.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function _isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Walk up the directory tree from startDir looking for marker.
 * Uses path.parse(dir).root so it terminates correctly on Windows ("C:\\")
 * and POSIX ("/").
 *
 * @param {string} startDir   Absolute directory to begin walking from
 * @param {string} marker     Relative sub-path to look for inside each candidate dir
 * @param {'file'|'dir'|'any'} kind  What to check for existence
 * @returns {string|null}  The directory that contains marker, or null
 */
function walkUpFor(startDir, marker, kind) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root; // "/" on POSIX, "C:\\" on Windows

  const check = (candidate) => {
    if (!existsSync(candidate)) return false;
    if (kind === 'file') return _isFile(candidate);
    if (kind === 'dir')  return _isDir(candidate);
    return true; // 'any'
  };

  while (dir !== root) {
    if (check(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // safety guard — should not happen but protects against edge cases
    dir = parent;
  }

  // Check root itself
  if (check(path.join(root, marker))) return root;

  return null;
}

// ---------------------------------------------------------------------------
// detectPlatform
// ---------------------------------------------------------------------------

/**
 * Detect the host IDE/CLI platform.
 *
 * Detection order (mirrors platform.sh):
 * 1. Env-var fast path: CLAUDE_PLUGIN_ROOT → "claude", CODEX_PLUGIN_ROOT → "codex",
 *    CURSOR_RULES_DIR → "cursor"
 * 2. Filesystem walk from CWD looking for marker dirs:
 *    .claude-plugin → "claude", .codex-plugin → "codex", .cursor/rules → "cursor"
 * 3. Default: "claude"
 *
 * @returns {"claude"|"codex"|"cursor"}
 */
export function detectPlatform() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude';
  if (process.env.CODEX_PLUGIN_ROOT)  return 'codex';
  if (process.env.CURSOR_RULES_DIR)   return 'cursor';

  const cwd = process.cwd();

  if (walkUpFor(cwd, '.claude-plugin',               'dir')) return 'claude';
  if (walkUpFor(cwd, '.codex-plugin',                'dir')) return 'codex';
  if (walkUpFor(cwd, path.join('.cursor', 'rules'),  'dir')) return 'cursor';

  return 'claude';
}

// ---------------------------------------------------------------------------
// resolvePluginRoot
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the session-orchestrator plugin directory.
 *
 * Delegates to `scripts/lib/plugin-root.mjs` which implements the 4-level fallback
 * (CLAUDE_PLUGIN_ROOT → CODEX_PLUGIN_ROOT → walk from import.meta.url →
 * walk from cwd). The platform-specific CURSOR_RULES_DIR path is handled here
 * as an additional level before falling back to the robust resolver.
 *
 * Returns empty string (never throws) to preserve backward compat with callers
 * that check for a falsy return value.
 *
 * @param {"claude"|"codex"|"cursor"} [platform]
 * @returns {string}  Absolute path, or empty string if nothing found
 */
export function resolvePluginRoot(platform) {
  const plt = platform ?? detectPlatform();

  // Cursor: platform-specific env var not covered by plugin-root.mjs
  if (plt === 'cursor' && process.env.CURSOR_RULES_DIR &&
      _isDir(process.env.CURSOR_RULES_DIR)) {
    return process.env.CURSOR_RULES_DIR;
  }

  // Delegate to the robust 4-level resolver (#212)
  try {
    return _resolvePluginRootRobust();
  } catch (err) {
    if (err instanceof PluginRootResolutionError) {
      return '';
    }
    return '';
  }
}

// ---------------------------------------------------------------------------
// resolveProjectDir
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the current project root.
 *
 * Detection order (mirrors platform.sh):
 * 1. CLAUDE_PROJECT_DIR → CODEX_PROJECT_DIR → CURSOR_PROJECT_DIR env vars
 *    (CLAUDE wins when multiple are set — matches .sh order)
 * 2. Walk CWD up looking for platform config file (CLAUDE.md / AGENTS.md) or .git
 * 3. Default: process.cwd()
 *
 * @param {"claude"|"codex"|"cursor"} [platform]
 * @returns {string}  Absolute path
 */
export function resolveProjectDir(platform) {
  const plt = platform ?? detectPlatform();

  // 1. Env-var fast path
  if (process.env.CLAUDE_PROJECT_DIR)  return process.env.CLAUDE_PROJECT_DIR;
  if (process.env.CODEX_PROJECT_DIR)   return process.env.CODEX_PROJECT_DIR;
  if (process.env.CURSOR_PROJECT_DIR)  return process.env.CURSOR_PROJECT_DIR;

  // 2. Walk up from CWD
  const cwd = process.cwd();
  const configFile = plt === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';

  const byConfig = walkUpFor(cwd, configFile, 'file');
  if (byConfig) return byConfig;

  const byGit = walkUpFor(cwd, '.git', 'any');
  if (byGit) return byGit;

  // 3. Default
  return cwd;
}

// ---------------------------------------------------------------------------
// resolveStateDir
// ---------------------------------------------------------------------------

/**
 * Return the platform-native transient state directory name.
 *
 * | Platform | Result   |
 * |----------|----------|
 * | claude   | .claude  |
 * | codex    | .codex   |
 * | cursor   | .cursor  |
 *
 * @param {"claude"|"codex"|"cursor"} [platform]
 * @returns {".claude"|".codex"|".cursor"}
 */
export function resolveStateDir(platform) {
  const plt = platform ?? detectPlatform();
  switch (plt) {
    case 'codex':  return '.codex';
    case 'cursor': return '.cursor';
    default:       return '.claude';
  }
}

// ---------------------------------------------------------------------------
// resolveConfigFile
// ---------------------------------------------------------------------------

/**
 * Return the platform config file name.
 *
 * | Platform | Result    |
 * |----------|-----------|
 * | codex    | AGENTS.md |
 * | others   | CLAUDE.md |
 *
 * @param {"claude"|"codex"|"cursor"} [platform]
 * @returns {"CLAUDE.md"|"AGENTS.md"}
 */
export function resolveConfigFile(platform) {
  const plt = platform ?? detectPlatform();
  return plt === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
}

// ---------------------------------------------------------------------------
// Auto-initialise — compute all exported constants at module load
// ---------------------------------------------------------------------------

/** @type {"claude"|"codex"|"cursor"} */
export const SO_PLATFORM = detectPlatform();

/** Absolute path to the session-orchestrator plugin directory (empty string if unresolvable) */
export const SO_PLUGIN_ROOT = resolvePluginRoot(SO_PLATFORM);

/** Absolute path to the current project root */
export const SO_PROJECT_DIR = resolveProjectDir(SO_PLATFORM);

/** Platform-native state directory name */
export const SO_STATE_DIR = resolveStateDir(SO_PLATFORM);

/** Platform config file name */
export const SO_CONFIG_FILE = resolveConfigFile(SO_PLATFORM);

/** Shared orchestrator directory name — always ".orchestrator" */
export const SO_SHARED_DIR = '.orchestrator';

// --- v3 OS / Windows exports ---

/** Current OS identifier: process.platform ("darwin" | "linux" | "win32" | ...) */
export const SO_OS = process.platform;

/** True when running on Windows (native) */
export const SO_IS_WINDOWS = process.platform === 'win32';

/** True when running inside WSL (Windows Subsystem for Linux) */
export const SO_IS_WSL = process.env.WSL_DISTRO_NAME !== undefined;

/** Native path segment separator ("/" on POSIX, "\\" on Windows) */
export const SO_PATH_SEP = path.sep;
