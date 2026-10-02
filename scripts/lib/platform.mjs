/**
 * platform.mjs — platform detection for session-orchestrator (Node.js port of platform.sh)
 * ESM-importable. Uses only Node built-ins. No external dependencies.
 *
 * Exports:
 *   - lazy memoized accessors (#1153 P5): getPlatform, getPluginRoot, getProjectDir,
 *     getStateDir, getConfigFile (+ test-only _resetPlatformCache)
 *   - plain constants (no filesystem work): SO_SHARED_DIR, SO_OS, SO_IS_WINDOWS,
 *     SO_IS_WSL, SO_PATH_SEP
 *   - pure resolvers: detectPlatform, resolvePluginRoot, resolveProjectDir,
 *     resolveSessionRoot, resolveStateDir, resolveConfigFile
 *
 * NOTHING in this module touches the filesystem at import time.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePluginRoot as _resolvePluginRootRobust } from './plugin-root.mjs';

const VALID_PLATFORMS = new Set(['claude', 'codex', 'cursor', 'pi']);

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
 * @param {string|undefined} value
 * @returns {"claude"|"codex"|"cursor"|"pi"|null}
 */
function _validPlatform(value) {
  const platform = (value || '').trim();
  if (!VALID_PLATFORMS.has(platform)) return null;
  return /** @type {"claude"|"codex"|"cursor"|"pi"} */ (platform);
}

/** @param {string} envName */
function _hasEnvValue(envName) {
  return (process.env[envName] || '').trim() !== '';
}

/**
 * Absolute home directory, or null when the host cannot report one.
 * os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows.
 *
 * @returns {string|null}
 */
function _homeDir() {
  try {
    const home = os.homedir();
    return home ? path.resolve(home) : null;
  } catch {
    return null;
  }
}

/**
 * True when `dir` is the home directory itself or one of its ancestors
 * ("/", "/Users", "C:\\", …). Unrelated branches of the tree (e.g. "/opt")
 * are neither — they are walked normally.
 *
 * @param {string} dir
 * @param {string|null} home
 * @returns {boolean}
 */
function _isHomeOrAbove(dir, home) {
  if (home === null) return false;
  if (dir === home) return true;
  // The filesystem root already ends in the separator ("/", "C:\\") — appending
  // a second one ("//") would make it match nothing and silently exempt the one
  // directory that is an ancestor of every home.
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return home.startsWith(prefix);
}

/**
 * Walk up the directory tree from startDir looking for marker, bounded by the
 * project the walk started in.
 *
 * Two boundaries, both load-bearing (#1139) — a marker outside the project can
 * never describe the project:
 *
 *  1. **Repo root.** The first ancestor holding `.git` is the LAST directory
 *     inspected (inclusive — a marker at the repo root is still found). `.git`
 *     is a directory in a normal clone and a FILE in a worktree or submodule,
 *     so existence is checked, not the kind.
 *  2. **Home directory.** os.homedir() and its ancestors are never inspected —
 *     even when no repo root was found (cwd outside every checkout). This is
 *     what stops a stray `~/.pi` / `~/.cursor/rules` / `~/CLAUDE.md` from being
 *     adopted by every markerless directory on the host: before this boundary
 *     existed, 63 of 84 telemetry records from Claude Code sessions reported
 *     `platform=pi` because the walk reached `$HOME` and found `~/.pi` there.
 *
 * Named ceiling (BV-004): when a checkout's root IS the home directory (a
 * dotfiles repo at `$HOME`), boundary 2 wins over boundary 1 and no marker is
 * detected there — deliberate, because that false positive is silent and
 * host-wide while the false negative degrades to the documented default
 * ('claude' for detectPlatform, cwd for resolveProjectDir). Revisit if a
 * repo-at-$HOME layout ever has to carry orchestrator state.
 *
 * Terminates correctly on Windows ("C:\\") and POSIX ("/") via the
 * parent === dir fixpoint.
 *
 * @param {string} startDir   Absolute directory to begin walking from
 * @param {string} marker     Relative sub-path to look for inside each candidate dir
 * @param {'file'|'dir'|'any'} kind  What to check for existence
 * @returns {string|null}  The directory that contains marker, or null
 */
function walkUpFor(startDir, marker, kind) {
  let dir = path.resolve(startDir);
  const home = _homeDir();

  const check = (candidate) => {
    if (!existsSync(candidate)) return false;
    if (kind === 'file') return _isFile(candidate);
    if (kind === 'dir')  return _isDir(candidate);
    return true; // 'any'
  };

  for (;;) {
    if (_isHomeOrAbove(dir, home)) break;          // boundary 2 — never inspected
    if (check(path.join(dir, marker))) return dir;
    if (existsSync(path.join(dir, '.git'))) break; // boundary 1 — repo root was the last candidate
    const parent = path.dirname(dir);
    if (parent === dir) break;                     // filesystem root reached
    dir = parent;
  }

  return null;
}

// ---------------------------------------------------------------------------
// detectPlatform
// ---------------------------------------------------------------------------

/**
 * Detect the host IDE/CLI platform.
 *
 * Detection order:
 * 1. Trimmed allowlisted SO_PLATFORM explicit override
 * 2. Compatibility env vars: CLAUDE_PLUGIN_ROOT → "claude", CODEX_PLUGIN_ROOT → "codex",
 *    CURSOR_RULES_DIR → "cursor", PI_PLUGIN_ROOT → "pi"
 * 3. Filesystem walk from CWD looking for marker dirs:
 *    .claude-plugin → "claude", .codex-plugin → "codex", .cursor/rules → "cursor",
 *    .pi → "pi"
 * 4. Default: "claude"
 *
 * @returns {"claude"|"codex"|"cursor"|"pi"}
 */
export function detectPlatform() {
  const explicitPlatform = _validPlatform(process.env.SO_PLATFORM);
  if (explicitPlatform) return explicitPlatform;

  if (_hasEnvValue('CLAUDE_PLUGIN_ROOT')) return 'claude';
  if (_hasEnvValue('CODEX_PLUGIN_ROOT')) return 'codex';
  if (_hasEnvValue('CURSOR_RULES_DIR')) return 'cursor';
  if (_hasEnvValue('PI_PLUGIN_ROOT')) return 'pi';

  const cwd = process.cwd();

  if (walkUpFor(cwd, '.claude-plugin',               'dir')) return 'claude';
  if (walkUpFor(cwd, '.codex-plugin',                'dir')) return 'codex';
  if (walkUpFor(cwd, path.join('.cursor', 'rules'),  'dir')) return 'cursor';
  if (walkUpFor(cwd, '.pi',                           'dir')) return 'pi';

  // Signal-free fallback, deliberate rather than inherited: Claude Code is the
  // only harness that drives this code through `hooks.json` without exporting a
  // platform env var, so it is the harness that actually reaches this line.
  // Codex, Cursor and pi each set their own env var (step 2) or ship a marker
  // directory (step 3), so a wrong answer here costs them nothing they had.
  // No config key for this (BV-001) — SO_PLATFORM already overrides it.
  return 'claude';
}

// ---------------------------------------------------------------------------
// resolvePluginRoot
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the session-orchestrator plugin directory.
 *
 * Delegates to `scripts/lib/plugin-root.mjs` which implements native PLUGIN_ROOT,
 * explicit-platform compatibility precedence, remaining compatibility roots, and
 * import-meta/cwd walking. The optional platform argument retains the legacy Cursor fast path.
 *
 * Returns empty string (never throws) to preserve backward compat with callers
 * that check for a falsy return value.
 *
 * @param {"claude"|"codex"|"cursor"|"pi"} [platform]
 * @returns {string}  Absolute path, or empty string if nothing found
 */
export function resolvePluginRoot(platform) {
  const plt = platform ?? detectPlatform();

  // Preserve the legacy explicit Cursor fast path without changing Claude/Codex/Pi ordering.
  const compatibilityHint = plt === 'cursor' ? plt : undefined;

  try {
    return _resolvePluginRootRobust(compatibilityHint);
  } catch {
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
 * 1. CLAUDE_PROJECT_DIR → CODEX_PROJECT_DIR → CURSOR_PROJECT_DIR → PI_PROJECT_DIR env vars
 *    (CLAUDE wins when multiple are set — matches .sh order)
 * 2. Walk CWD up looking for platform config file (CLAUDE.md / AGENTS.md) or .git
 * 3. Default: process.cwd()
 *
 * @param {"claude"|"codex"|"cursor"|"pi"} [platform]
 * @returns {string}  Absolute path
 */
export function resolveProjectDir(platform) {
  const plt = platform ?? detectPlatform();

  // 1. Env-var fast path
  if (process.env.CLAUDE_PROJECT_DIR)  return process.env.CLAUDE_PROJECT_DIR;
  if (process.env.CODEX_PROJECT_DIR)   return process.env.CODEX_PROJECT_DIR;
  if (process.env.CURSOR_PROJECT_DIR)  return process.env.CURSOR_PROJECT_DIR;
  if (process.env.PI_PROJECT_DIR)      return process.env.PI_PROJECT_DIR;

  // 2. Walk up from CWD
  const cwd = process.cwd();
  const configFile = (plt === 'codex' || plt === 'pi') ? 'AGENTS.md' : 'CLAUDE.md';

  const byConfig = walkUpFor(cwd, configFile, 'file');
  if (byConfig) return byConfig;

  const byGit = walkUpFor(cwd, '.git', 'any');
  if (byGit) return byGit;

  // 3. Default
  return cwd;
}

// ---------------------------------------------------------------------------
// resolveSessionRoot (#1492)
// ---------------------------------------------------------------------------

/**
 * Basename of a worktree the HARNESS creates for an `isolation: "worktree"`
 * subagent: `agent-` + the agent id. Measured 2026-10-02 over this host's
 * transcripts: 13481 `.claude/worktrees/agent-<hex>` hits, every agent id of the
 * form `a` + 16 hex (`agent-a00828908cdd83bd8`). A worktree a SESSION enters
 * (`EnterWorktree`, `claude --worktree <name>`) lives in the same directory under
 * a chosen name (`landing-produktschau`, `s71-politur`), so the name is the only
 * discriminator the path offers.
 */
const HARNESS_AGENT_WORKTREE_RE = /^agent-[0-9a-f]{8,}$/;

/**
 * The first non-blank launch-dir env var, in `resolveProjectDir()` order, or `''`.
 * Trimmed: a whitespace-only value is truthy and would otherwise win
 * (`development.md` § Error Handling, env-var fallback whitespace trap).
 *
 * @returns {string}
 */
function _launchDirFromEnv() {
  for (const name of ['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'PI_PROJECT_DIR']) {
    const value = (process.env[name] || '').trim();
    if (value !== '') return value;
  }
  return '';
}

/**
 * The nearest directory at or above `cwd` holding a `.git` entry — a directory,
 * or the FILE a linked worktree carries — or `''` when none does. Git's own repo
 * discovery walks up looking for exactly this entry, so where git answers, both
 * agree (measured 2026-10-02: same answer, 0.017 ms here vs 4.57 ms for a
 * `git rev-parse --show-toplevel` spawn). Existence only — the entry is not
 * validated, which git would do.
 *
 * Not `walkUpFor(cwd, '.git', 'any')`: its home-directory boundary exists for
 * PLATFORM markers (#1139); a repo whose root is `$HOME` is still a repo root.
 *
 * @param {string} cwd
 * @returns {string}
 */
function _dotGitAncestor(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return '';
  }
}

/**
 * `<P>` when `root` is a harness subagent worktree `<P>/.claude/worktrees/agent-<hex>`
 * whose parent `<P>` is itself a working copy; otherwise `root` unchanged.
 *
 * @param {string} root
 * @returns {string}
 */
function _liftHarnessAgentWorktree(root) {
  if (!HARNESS_AGENT_WORKTREE_RE.test(path.basename(root))) return root;
  const worktreesDir = path.dirname(root);
  if (path.basename(worktreesDir) !== 'worktrees') return root;
  const stateDir = path.dirname(worktreesDir);
  if (path.basename(stateDir) !== '.claude') return root;
  const parent = path.dirname(stateDir);
  return existsSync(path.join(parent, '.git')) ? parent : root;
}

/** realpath, or the resolved spelling when the path does not exist. */
function _canonical(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Is `child` a STRICT descendant of `parent` (never `parent` itself)? Both sides
 * canonical, so macOS `/tmp` vs `/private/tmp` cannot split one directory in two.
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function _isStrictlyInside(child, parent) {
  const rel = path.relative(_canonical(parent), _canonical(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The SESSION ROOT (#1492) — the working copy whose control files belong to the
 * session a hook fires in: `wave-scope.json`, the `.orchestrator/` ledgers, the
 * event records. One resolver for every hook that reads them (enforce-scope,
 * enforce-commands, post-bash-write-verify, pre-task-scope-disjoint).
 *
 * NOT the launch dir whenever the session works elsewhere: `$CLAUDE_PROJECT_DIR`
 * stays on the dir the session was LAUNCHED in after it enters a worktree
 * (docs/en/hooks § "Worktrees are different"), while the coordinator writes
 * `wave-scope.json` into that worktree. Read from the launch dir, the manifest
 * was absent and every scope gate allowed everything for the whole session,
 * silently (#1492, measured in session main-2026-10-02-session-21); preferred
 * for the dispatch ledger it also gave every worktree session of one launch dir
 * ONE shared ledger and the wave key `w?` (measured on be6a2e3e).
 *
 * NOT the payload `cwd` itself: it follows the session's `cd` (docs/en/hooks
 * § "cwd follows Claude"), and a `cd sub` must not move the session's state into
 * `<root>/sub` — a second, empty ledger whose collisions were allowed (#1489 Pkt 6).
 *
 * NEVER ABOVE the launch dir: a session launched in a repo SUBDIRECTORY (a
 * monorepo package, a project under a git-tracked `$HOME`) keeps its manifest
 * there. The repo root above it holds none, so resolving to it switched every
 * scope gate off (review HIGH-1 on 4fdbc469, measured DENY → ALLOW).
 *
 * Precedence:
 *   1. no payload `cwd` → `resolveProjectDir()`, the pre-#1492 answer unchanged;
 *   2. the repo root of `cwd` — `toplevel` when the caller already holds
 *      `git rev-parse --show-toplevel` of it, else the nearest `.git` ancestor
 *      (`_dotGitAncestor`), which answers the same without a spawn, so neither a
 *      timed-out git (review MED on 63f35e8c) nor a hot-path budget can send a
 *      worktree session back to the launch dir — lifted to `<P>` when it is a
 *      harness subagent worktree `<P>/.claude/worktrees/agent-<hex>` (below),
 *      then replaced by the launch dir from env (`_launchDirFromEnv`) when it
 *      lies strictly ABOVE it;
 *   3. the launch dir from env (`CLAUDE_PROJECT_DIR` → `CODEX_PROJECT_DIR` →
 *      `CURSOR_PROJECT_DIR` → `PI_PROJECT_DIR`), only when `cwd` is in no repo;
 *   4. `cwd`.
 *
 * The clamp reads the SAME launch-dir chain as rung 3, not `$CLAUDE_PROJECT_DIR`
 * alone. The Cursor and Pi bridges delete `CLAUDE_PROJECT_DIR` and set their
 * own `*_PROJECT_DIR` to the payload `cwd` on every call (`cursor-hook-bridge.mjs`,
 * `pi-hook-bridge.mjs`); a clamp on `$CLAUDE_PROJECT_DIR` alone therefore never
 * fired there, and a Cursor/Pi workspace in a repo SUBDIRECTORY climbed to the
 * repo root, found no manifest and allowed every write (review HIGH-1 on
 * b57e572c, measured end-to-end through `cursor-hook-bridge.mjs`: DENY at
 * ff3e43b5 → ALLOW). For a Claude session nothing changes — `$CLAUDE_PROJECT_DIR`
 * is first in the chain. For a bridge session the answer is the payload `cwd`
 * whenever it sits in a repo, which is exactly what the bridges resolved before
 * #1492 (`resolveProjectDir()` → their `*_PROJECT_DIR` → the payload `cwd`).
 * The clamp does not ask whether `cwd` lies inside the launch dir: an
 * `isolation: "worktree"` agent's `cwd` never does, and it must clamp too (see
 * THE LIFT).
 *
 * THE LIFT. An `isolation: "worktree"` subagent's hook payload carries the
 * worktree the harness made for it, `<P>/.claude/worktrees/agent-<hex>`. That
 * worktree is a repo root of its own and holds no manifest, so rung 2 alone
 * would disarm scope enforcement for every such agent. The harness puts it under
 * the LAUNCH checkout, so `<P>` is what `$CLAUDE_PROJECT_DIR` resolved to before
 * #1492 — the lift keeps exactly that, and the clamp keeps it for a launch in a
 * subdirectory of `<P>`. It is keyed on the PATH SHAPE, never on which candidate
 * holds a manifest: a root picked because a control file is readable there
 * would let any directory that lacks one become the deciding root.
 *
 * Ceilings (BV-004):
 *  - An agent of a session that ENTERED a worktree is still unenforced, as before
 *    #1492: its worktree sits under the launch checkout (measured: session
 *    0d5e4fc3, 2026-09-25 — cwd `<main>/.claude/worktrees/landing-produktschau`,
 *    agent worktreePath `<main>/.claude/worktrees/agent-acd5bfd0aa590e2e8`), so
 *    the lift lands on the launch root, where that session has no manifest.
 *    Fixing it needs a design (e.g. find the manifest bound to the payload
 *    `session_id` among the repo's worktrees). Revisit when an entered-worktree
 *    session dispatches `isolation: "worktree"` agents under a manifest.
 *  - Rung 2 is `cd`-relocatable: a session whose `cwd` sits in ANOTHER repo (a
 *    submodule, a nested or sibling checkout) is checked against that repo's
 *    manifest — usually none, so its gates allow — where the launch dir's
 *    manifest used to apply. Same relocation `pre-task-scope-disjoint` has
 *    keyed its ledger on since #1489. Revisit if an `orchestrator.scope.*`
 *    record or a review ever shows an out-of-scope write made after such a `cd`.
 *  - A session worktree NAMED like a harness one (`agent-` + 8 or more hex) is
 *    lifted to its parent — the pre-#1492 launch-dir behaviour for that one
 *    session, not a new failure. Revisit if the harness changes its naming.
 *  - A Cursor/Pi bridge session follows its payload `cwd`, as it did before
 *    #1492: the bridges hand over no launch dir distinct from that `cwd`, so a
 *    bridge session whose `cwd` moves into a subdirectory without a manifest is
 *    unenforced there. Not a new failure — the pre-#1492 bridge answer. Revisit
 *    when a bridge hands over a stable workspace root separately from the
 *    payload `cwd` — then clamp on that instead.
 *
 * @param {string|undefined} cwd       the hook payload's `cwd`
 * @param {string} [toplevel]          `git rev-parse --show-toplevel` of `cwd`, `''` when unknown
 * @returns {string}  Absolute path
 */
export function resolveSessionRoot(cwd, toplevel = '') {
  if (typeof cwd !== 'string' || cwd.trim() === '') return resolveProjectDir();
  const repoRoot = (typeof toplevel === 'string' ? toplevel : '') || _dotGitAncestor(cwd);
  if (!repoRoot) return _launchDirFromEnv() || cwd;
  const root = _liftHarnessAgentWorktree(repoRoot);
  const launch = _launchDirFromEnv();
  return launch !== '' && _isStrictlyInside(launch, root) ? launch : root;
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
 * | pi       | .pi      |
 *
 * @param {"claude"|"codex"|"cursor"|"pi"} [platform]
 * @returns {".claude"|".codex"|".cursor"|".pi"}
 */
export function resolveStateDir(platform) {
  const plt = platform ?? detectPlatform();
  switch (plt) {
    case 'codex':  return '.codex';
    case 'cursor': return '.cursor';
    case 'pi':     return '.pi';
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
 * | pi       | AGENTS.md |
 * | others   | CLAUDE.md |
 *
 * @param {"claude"|"codex"|"cursor"|"pi"} [platform]
 * @returns {"CLAUDE.md"|"AGENTS.md"}
 */
export function resolveConfigFile(platform) {
  const plt = platform ?? detectPlatform();
  return (plt === 'codex' || plt === 'pi') ? 'AGENTS.md' : 'CLAUDE.md';
}

// ---------------------------------------------------------------------------
// Lazy, memoized accessors (#1153 P5)
// ---------------------------------------------------------------------------
//
// These five values used to be `export const … = detect…()` evaluated at MODULE
// LOAD, so every one of the ~31 static importers — including the hottest
// deny-capable hooks, which run on every single tool call — paid a filesystem
// walk-up (statSync/existsSync per ancestor directory, twice over for
// resolvePluginRoot) merely for importing this module, whether or not it ever
// read the value.
//
// They are now computed on FIRST USE and memoized. Call the getter at the point
// of use, never at a module's top level — a top-level `const X = getProjectDir()`
// re-creates the exact cost this change removes.

/**
 * Memo slots. `undefined` is the miss sentinel — `''` is a legitimate
 * resolvePluginRoot() result and must not re-trigger resolution.
 * @type {{platform: ("claude"|"codex"|"cursor"|"pi")|undefined, pluginRoot: string|undefined, projectDir: string|undefined, stateDir: string|undefined, configFile: string|undefined}}
 */
const _cache = {
  platform: undefined,
  pluginRoot: undefined,
  projectDir: undefined,
  stateDir: undefined,
  configFile: undefined,
};

/**
 * Host platform, detected once per process.
 * @returns {"claude"|"codex"|"cursor"|"pi"}
 */
export function getPlatform() {
  if (_cache.platform === undefined) {
    _cache.platform = detectPlatform();
  }
  return _cache.platform;
}

/**
 * Absolute path to the session-orchestrator plugin directory, resolved once.
 * @returns {string}  Absolute path, or empty string if unresolvable.
 */
export function getPluginRoot() {
  if (_cache.pluginRoot === undefined) {
    _cache.pluginRoot = resolvePluginRoot(getPlatform());
  }
  return _cache.pluginRoot;
}

/**
 * Absolute path to the current project root, resolved once.
 * @returns {string}
 */
export function getProjectDir() {
  if (_cache.projectDir === undefined) {
    _cache.projectDir = resolveProjectDir(getPlatform());
  }
  return _cache.projectDir;
}

/**
 * Platform-native state directory name (".claude" | ".codex" | ".cursor" | ".pi").
 * @returns {string}
 */
export function getStateDir() {
  if (_cache.stateDir === undefined) {
    _cache.stateDir = resolveStateDir(getPlatform());
  }
  return _cache.stateDir;
}

/**
 * Platform config file name ("CLAUDE.md" | "AGENTS.md").
 * @returns {string}
 */
export function getConfigFile() {
  if (_cache.configFile === undefined) {
    _cache.configFile = resolveConfigFile(getPlatform());
  }
  return _cache.configFile;
}

/**
 * Test-only: drop every memoized value so the next getter re-detects.
 * Production code must never call this — the values are process-stable.
 * @returns {void}
 */
export function _resetPlatformCache() {
  _cache.platform = undefined;
  _cache.pluginRoot = undefined;
  _cache.projectDir = undefined;
  _cache.stateDir = undefined;
  _cache.configFile = undefined;
}

// The deprecated `export let SO_PLATFORM / SO_PLUGIN_ROOT / SO_PROJECT_DIR /
// SO_STATE_DIR / SO_CONFIG_FILE` live bindings (#1153 P5) are GONE. They were
// `undefined` until the matching getter had run in the process, which made
// every bare read a silent wrong answer. Every consumer now calls the getter
// (getPlatform(), getProjectDir(), …). A re-introduction is caught by the
// named-export assertion in tests/lib/platform.test.mjs — do not add them back.

// ---------------------------------------------------------------------------
// Plain constants — no filesystem work, safe to evaluate at load
// ---------------------------------------------------------------------------

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
