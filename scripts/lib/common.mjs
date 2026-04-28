/**
 * common.mjs — Shared I/O utilities for session-orchestrator scripts.
 *
 * Pure ESM, Node stdlib only. Replaces the generic helpers from common.sh.
 *
 * Part of v3.0.0 migration (Epic #124, issue #136).
 * Shell-helper ports added for issue #218.
 */

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns a unique temp path (does NOT create the file/directory).
 * @param {string} prefix - non-empty string prepended to the filename
 * @returns {string}
 */
export function makeTmpPath(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('makeTmpPath: prefix must be a non-empty string');
  }
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${rand}`);
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/** Returns the current time as an ISO 8601 UTC string. */
export function utcTimestamp() {
  return new Date().toISOString();
}

/** Returns the current Unix time in milliseconds. */
export function epochMs() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// JSON file helpers
// ---------------------------------------------------------------------------

/**
 * Reads and parses a JSON file; throws on missing file or parse error.
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Serialises obj as pretty-printed JSON and writes it to filePath,
 * creating any missing parent directories automatically.
 * @param {string} filePath
 * @param {unknown} obj
 * @returns {Promise<void>}
 */
export async function writeJson(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Appends obj as a single JSONL line to filePath, creating missing parent
 * directories automatically. Single appendFile call — atomic for lines under
 * PIPE_BUF (4 KiB).
 * @param {string} filePath
 * @param {unknown} obj
 * @returns {Promise<void>}
 */
export async function appendJsonl(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Shell-helper ports (issue #218) — equivalents of common.sh functions
// ---------------------------------------------------------------------------

/**
 * Print an error message to stderr and exit with code 1.
 * Equivalent to die() in common.sh.
 * @param {string} message
 * @returns {never}
 */
export function die(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

/**
 * Print a warning message to stderr (does not exit).
 * Equivalent to warn() in common.sh.
 * @param {string} message
 */
export function warn(message) {
  process.stderr.write(`WARNING: ${message}\n`);
}

/**
 * Verify that jq is available on PATH.
 * Throws an Error if jq is not found (instead of exiting, so callers can decide).
 * For scripts that want exit-on-failure behaviour, wrap with die():
 *   try { requireJq(); } catch (e) { die(e.message); }
 * Equivalent to require_jq() in common.sh.
 * @returns {void}
 * @throws {Error} when jq is not on PATH
 */
export function requireJq() {
  try {
    execSync('command -v jq', { stdio: 'ignore', shell: true });
  } catch {
    throw new Error('jq is required but not installed. Install via: brew install jq');
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for project/plugin root detection
// ---------------------------------------------------------------------------

/** Return true when `dir` exists as a directory. */
function _isDirSync(dir) {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/** Return true when `file` exists (file or directory). */
function _isFileSync(file) {
  return existsSync(file);
}

/**
 * Walk up the directory tree from `startDir` until a directory satisfying
 * `predicate(dir)` is found. Returns the matching directory or null.
 * @param {string} startDir
 * @param {(dir: string) => boolean} predicate
 * @returns {string|null}
 */
function _walkUpUntil(startDir, predicate) {
  let dir = path.resolve(startDir);
  while (true) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// findProjectRoot
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` (defaults to process.cwd()) looking for CLAUDE.md,
 * .claude/, AGENTS.md, or .codex/ markers. Returns the found project root, or
 * `startDir` if nothing is found.
 *
 * Respects CLAUDE_PROJECT_DIR and CODEX_PROJECT_DIR environment variables as
 * fast-paths (same semantics as common.sh find_project_root).
 *
 * Equivalent to find_project_root() in common.sh.
 *
 * @param {string} [startDir] - directory to start the walk from (default: process.cwd())
 * @returns {string} Absolute path of the project root
 */
export function findProjectRoot(startDir) {
  const base = startDir ? path.resolve(startDir) : process.cwd();

  // Fast path: CLAUDE_PROJECT_DIR
  const claudeDir = process.env.CLAUDE_PROJECT_DIR;
  if (claudeDir) {
    if (_isFileSync(path.join(claudeDir, 'CLAUDE.md')) || _isDirSync(path.join(claudeDir, '.claude'))) {
      return claudeDir;
    }
  }

  // Fast path: CODEX_PROJECT_DIR
  const codexDir = process.env.CODEX_PROJECT_DIR;
  if (codexDir) {
    if (_isFileSync(path.join(codexDir, 'AGENTS.md')) || _isDirSync(path.join(codexDir, '.codex'))) {
      return codexDir;
    }
  }

  const found = _walkUpUntil(base, (dir) =>
    _isFileSync(path.join(dir, 'CLAUDE.md')) ||
    _isDirSync(path.join(dir, '.claude')) ||
    _isFileSync(path.join(dir, 'AGENTS.md')) ||
    _isDirSync(path.join(dir, '.codex')),
  );

  return found ?? base;
}

// ---------------------------------------------------------------------------
// resolvePluginRoot
// ---------------------------------------------------------------------------

/**
 * Resolve the session-orchestrator plugin root directory.
 *
 * Resolution order (stops at first success):
 *   1. CLAUDE_PLUGIN_ROOT env var
 *   2. CODEX_PLUGIN_ROOT  env var
 *   3. Walk up from import.meta.url of this file looking for plugin.json / skills/ / .codex-plugin/
 *   4. Walk up from process.cwd() looking for the same markers
 *
 * Equivalent to resolve_plugin_root() in common.sh, but throws instead of calling die()
 * so that callers in a non-process context (tests) can catch the error.
 *
 * @param {string} [callerUrl] - import.meta.url of the calling module (optional override for level-3 walk)
 * @returns {string} Absolute path to the plugin root
 * @throws {Error} when all resolution levels fail
 */
export function resolvePluginRoot(callerUrl) {
  const isPluginDir = (dir) =>
    _isFileSync(path.join(dir, 'plugin.json')) ||
    _isDirSync(path.join(dir, 'skills')) ||
    _isDirSync(path.join(dir, '.codex-plugin'));

  // Level 1: CLAUDE_PLUGIN_ROOT
  const claudeRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (claudeRoot && _isDirSync(claudeRoot)) return claudeRoot;

  // Level 2: CODEX_PLUGIN_ROOT
  const codexRoot = process.env.CODEX_PLUGIN_ROOT;
  if (codexRoot && _isDirSync(codexRoot)) return codexRoot;

  // Level 3: walk up from caller / this file
  const startFromFile = callerUrl
    ? path.dirname(fileURLToPath(callerUrl))
    : path.dirname(fileURLToPath(import.meta.url));
  const byFile = _walkUpUntil(startFromFile, isPluginDir);
  if (byFile) return byFile;

  // Level 4: walk up from cwd
  const byCwd = _walkUpUntil(process.cwd(), isPluginDir);
  if (byCwd) return byCwd;

  throw new Error(
    'Could not locate plugin root. Set CLAUDE_PLUGIN_ROOT (or CODEX_PLUGIN_ROOT) to the plugin directory, ' +
    'or ensure plugin.json / skills/ exists in an ancestor of the cwd.',
  );
}
