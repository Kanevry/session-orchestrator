/**
 * plugin-root.mjs — Robust plugin root resolution with layered fallback.
 *
 * Issue #212: manual installs may not have CLAUDE_PLUGIN_ROOT set. This module
 * provides a deterministic, testable resolution strategy so hook handlers and
 * scripts never silently fall back to an empty path or wrong directory.
 *
 * TIER ORDER — SINGLE SOURCE OF TRUTH (stops at first success):
 *   1.   PLUGIN_ROOT native env var
 *   2-5. Compatibility roots: the one matching an explicit SO_PLATFORM first,
 *        then the rest in legacy Claude → Codex → Cursor → Pi order
 *   6.   Walk up from import.meta.url looking for package.json whose
 *        name === "session-orchestrator"
 *   7.   Walk up from process.cwd() looking for the same marker
 *   8.   Scan the client plugin caches (marketplace install, no env, cwd outside
 *        any checkout — GH Kanevry/session-orchestrator#64)
 *
 * `.mcp.json`'s bash bootstrap MIRRORS this order and cites this block. It
 * implements: tiers 1-5 in this exact env order → `git rev-parse
 * --show-toplevel` (its analogue of tier 7) → `node -e resolvePluginRoot()`
 * (which runs THIS function, tiers 1-8) → its own cache scan, reachable only
 * when the module is not node-resolvable at all.
 *
 * THE ONE REMAINING DIVERGENCE, stated exactly: **tier 6** — a shell has no
 * `import.meta.url`, so the walk up from this file's own location has no
 * analogue there. Everything else is mirrored byte-for-byte in behaviour: the
 * env list AND its order, the `CODEX_HOME` trim (see `_pluginCacheBases`), the
 * `package.json{name === "session-orchestrator"}` test (the shell runs the same
 * `JSON.parse` via `node -e`, not a substring `grep` — a `grep` matched
 * `"name": "session-orchestrator-fork"` that this function rejects), and the
 * newest-wins-by-mtime tiebreak (`[ "$c" -nt "$r" ]` is strict, exactly like
 * the `>` below).
 *
 * Two divergences that existed until 2026-08-28 and no longer do: the shell
 * scanned the caches BEFORE the node tier (a host with both a global npm
 * install and a marketplace cache copy had the shell pick the cache while this
 * function picked the npm copy), and its env list read `CLAUDE_PLUGIN_ROOT,
 * CODEX_PLUGIN_ROOT, PLUGIN_ROOT` — a different tier-1 winner, and no
 * `CURSOR_RULES_DIR`/`PI_PLUGIN_ROOT` at all. When either side's order changes,
 * change both — the shell is the mirror, this list is the original.
 *
 * Throws PluginRootResolutionError when all resolution levels fail.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
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

/**
 * Base directories under which a client keeps its plugin cache.
 *
 * Measured 2026-08-28 on codex-cli 0.141.0 and Claude Code: an installed
 * plugin is COPIED (not symlinked) to
 * `<base>/plugins/cache/<marketplace>/<plugin-name>/<version>/`, e.g.
 * `~/.codex/plugins/cache/local/session-orchestrator/3.22.0+codex.20260822193811/`
 * and `~/.claude/plugins/cache/session-orchestrator/session-orchestrator/3.13.0/`.
 *
 * Cursor is deliberately absent: no cache layout was measured for it on this
 * host (`~/.cursor/plugins/cache` did not exist), and a guessed path would
 * resolve nothing while implying coverage. Add it once a real install is seen.
 *
 * `CODEX_HOME` is TRIMMED before the emptiness test, not merely defaulted.
 * `||` and shell `${X:-…}` both fire on unset/empty only, so a whitespace-only
 * value passes straight through and the scan globs a nonsense base
 * (`.claude/rules/development.md` § Env-var fallback whitespace trap).
 * `.mcp.json`'s bash bootstrap carries the same trim for the same reason —
 * before 2026-08-28 it used `${CODEX_HOME:-$HOME/.codex}` and diverged from here on
 * exactly that input.
 *
 * @returns {string[]} Absolute base directories, most-specific client first
 */
function _pluginCacheBases() {
  const home = os.homedir();
  const codexHome = (process.env.CODEX_HOME || '').trim() || path.join(home, '.codex');
  return [codexHome, path.join(home, '.claude')];
}

/**
 * Scan the client plugin caches for an installed copy of this plugin.
 *
 * This is the only level that can succeed for a marketplace install launched
 * outside any checkout. Measured 2026-08-28 by probing a registered MCP server
 * from `/tmp` (codex-cli 0.141.0): the child process received NO plugin-root
 * environment variable (`CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`,
 * `PLUGIN_ROOT` and `CODEX_HOME` were all unset), its `PWD` was the launch
 * directory, and `HOME` was set — so every earlier level is blind while the
 * installed copy sits at a well-known path under `HOME`.
 * See GH Kanevry/session-orchestrator#64.
 *
 * Ceiling (BV-004): among valid candidates the newest wins by directory
 * **mtime**, not by semver. That reads as "the copy the client installed most
 * recently", which is the intent, and it keeps this resolver free of a semver
 * parser — a lexical sort would already be wrong today (`3.9.0` sorts above
 * `3.22.0`). Revisit if a client starts pre-seeding caches it never launches.
 *
 * Equal-mtime tiebreak: the comparison is STRICTLY greater, so on a tie the
 * FIRST candidate in scan order wins — bases in `_pluginCacheBases()` order
 * (`CODEX_HOME` before `~/.claude`), then `readdirSync` order within each. Two
 * cache copies sharing an mtime to the millisecond means the same content
 * installed twice, so the choice is arbitrary rather than wrong; what matters
 * is that it is DETERMINISTIC and identical to `.mcp.json`'s `[ "$c" -nt "$r" ]`,
 * which is also strict. Untested by design — a test would pin an arbitrary
 * choice as a contract.
 *
 * @param {string[]} tried  Diagnostic accumulator, appended to on failure
 * @returns {string|null} Absolute path to the newest cached plugin copy
 */
function _scanPluginCaches(tried) {
  const bases = _pluginCacheBases();
  let best = null;
  let bestMtimeMs = -1;

  for (const base of bases) {
    const cacheDir = path.join(base, 'plugins', 'cache');
    if (!_isDir(cacheDir)) continue;

    let marketplaces;
    try { marketplaces = readdirSync(cacheDir); } catch { continue; }

    for (const marketplace of marketplaces) {
      const pluginDir = path.join(cacheDir, marketplace, 'session-orchestrator');
      if (!_isDir(pluginDir)) continue;

      let versions;
      try { versions = readdirSync(pluginDir); } catch { continue; }

      for (const version of versions) {
        const candidate = path.join(pluginDir, version);
        // The directory NAME is not proof — a foreign package may sit under a
        // `session-orchestrator/` marketplace folder. The package.json marker is.
        if (!_isPluginRoot(candidate)) continue;
        let mtimeMs;
        try { mtimeMs = statSync(candidate).mtimeMs; } catch { continue; }
        if (mtimeMs > bestMtimeMs) { bestMtimeMs = mtimeMs; best = candidate; }
      }
    }
  }

  if (!best) {
    const globs = bases.map((base) => path.join(base, 'plugins', 'cache', '*', 'session-orchestrator', '*'));
    tried.push(`plugin caches (${globs.join(', ')}) — no package.json{name:session-orchestrator} found`);
  }
  return best;
}

// ---------------------------------------------------------------------------
// resolvePluginRoot
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the session-orchestrator plugin directory.
 *
 * Tier order is defined ONCE in this file's top docblock (§ TIER ORDER) and
 * mirrored by `.mcp.json`'s bash bootstrap. Do not restate it here — a second
 * copy is what let the two drift.
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

  // Level 8: client plugin caches — the marketplace-install case, where no env
  // var is provided and the cwd is outside every checkout (#64).
  const byPluginCache = _scanPluginCaches(tried);
  if (byPluginCache) return byPluginCache;

  throw new PluginRootResolutionError(
    'Could not resolve session-orchestrator plugin root. ' +
    'Set PLUGIN_ROOT, CLAUDE_PLUGIN_ROOT, CODEX_PLUGIN_ROOT, CURSOR_RULES_DIR, or PI_PLUGIN_ROOT ' +
    'to the plugin directory, ensure a package.json with name "session-orchestrator" exists in an ' +
    'ancestor of the cwd or this script, or (re)install the plugin through your client\'s marketplace ' +
    'so a cached copy exists. Attempted: ' + tried.join('; '),
    tried,
  );
}
