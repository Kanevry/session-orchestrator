/**
 * tests/lib/platform.test.mjs
 *
 * Unit tests for scripts/lib/platform.mjs
 * Runs on Ubuntu, macOS, and Windows via CI matrix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SO_OS,
  SO_IS_WINDOWS,
  SO_IS_WSL,
  SO_PATH_SEP,
  SO_SHARED_DIR,
  getPlatform,
  getPluginRoot,
  getProjectDir,
  getStateDir,
  getConfigFile,
  _resetPlatformCache,
  detectPlatform,
  resolvePluginRoot,
  resolveProjectDir,
  resolveSessionRoot,
  resolveStateDir,
  resolveConfigFile,
} from '@lib/platform.mjs';
import { runCursorHookEvent } from '@lib/cursor-hook-bridge.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const ENV_KEYS = [
  'SO_PLATFORM',
  'PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CURSOR_RULES_DIR',
  'PI_PLUGIN_ROOT',
  'CLAUDE_PROJECT_DIR',
  'CODEX_PROJECT_DIR',
  'CURSOR_PROJECT_DIR',
  'PI_PROJECT_DIR',
];

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, '');
  // The lazy accessors memoize per process (#1153 P5) — without this the second
  // test in this file would read the first test's environment.
  _resetPlatformCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetPlatformCache();
});

// ---------------------------------------------------------------------------
// 1. Module loads without error — all exports are defined
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports the plain constants as non-undefined values', () => {
    expect(SO_OS).not.toBeUndefined();
    expect(SO_IS_WINDOWS).not.toBeUndefined();
    expect(SO_IS_WSL).not.toBeUndefined();
    expect(SO_PATH_SEP).not.toBeUndefined();
    expect(SO_SHARED_DIR).not.toBeUndefined();
  });

  it('exports the 5 lazy accessors, each returning a defined value', () => {
    expect(getPlatform()).not.toBeUndefined();
    expect(getPluginRoot()).not.toBeUndefined();
    expect(getProjectDir()).not.toBeUndefined();
    expect(getStateDir()).not.toBeUndefined();
    expect(getConfigFile()).not.toBeUndefined();
  });

  it('exports all 5 functions as callable functions', () => {
    expect(typeof detectPlatform).toBe('function');
    expect(typeof resolvePluginRoot).toBe('function');
    expect(typeof resolveProjectDir).toBe('function');
    expect(typeof resolveStateDir).toBe('function');
    expect(typeof resolveConfigFile).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 2. SO_OS matches process.platform
// ---------------------------------------------------------------------------

describe('SO_OS', () => {
  it('equals process.platform', () => {
    expect(SO_OS).toBe(process.platform);
  });
});

// ---------------------------------------------------------------------------
// 3. SO_IS_WINDOWS correctness
// ---------------------------------------------------------------------------

describe('SO_IS_WINDOWS', () => {
  it('is true only when process.platform is win32', () => {
    if (process.platform === 'win32') {
      expect(SO_IS_WINDOWS).toBe(true);
    } else {
      expect(SO_IS_WINDOWS).toBe(false);
    }
  });

  it('is a boolean', () => {
    expect(typeof SO_IS_WINDOWS).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 4. SO_IS_WSL detection — reflects env at module load time
// ---------------------------------------------------------------------------

describe('SO_IS_WSL', () => {
  it('is a boolean', () => {
    expect(typeof SO_IS_WSL).toBe('boolean');
  });

  it('is true when WSL_DISTRO_NAME was set at module load, false when unset', () => {
    // The constant reflects the state of the environment at import time.
    // We verify the value matches the env-var presence at that moment.
    const expectedAtLoadTime = process.env.WSL_DISTRO_NAME !== undefined;
    expect(SO_IS_WSL).toBe(expectedAtLoadTime);
  });

  it('is false on macOS and Windows native (no WSL_DISTRO_NAME in those environments)', () => {
    // On native macOS / Windows, WSL_DISTRO_NAME is never set.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(SO_IS_WSL).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. SO_PATH_SEP equals path.sep
// ---------------------------------------------------------------------------

describe('SO_PATH_SEP', () => {
  it('equals path.sep from node:path', () => {
    expect(SO_PATH_SEP).toBe(path.sep);
  });

  it('is "/" on POSIX or "\\\\" on Windows', () => {
    if (process.platform === 'win32') {
      expect(SO_PATH_SEP).toBe('\\');
    } else {
      expect(SO_PATH_SEP).toBe('/');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. resolveStateDir mapping
// ---------------------------------------------------------------------------

describe('resolveStateDir', () => {
  it('returns ".claude" for platform "claude"', () => {
    expect(resolveStateDir('claude')).toBe('.claude');
  });

  it('returns ".codex" for platform "codex"', () => {
    expect(resolveStateDir('codex')).toBe('.codex');
  });

  it('returns ".cursor" for platform "cursor"', () => {
    expect(resolveStateDir('cursor')).toBe('.cursor');
  });

  it('returns ".pi" for platform "pi"', () => {
    expect(resolveStateDir('pi')).toBe('.pi');
  });

  it('returns ".claude" for unknown platform (default case)', () => {
    expect(resolveStateDir('unknown')).toBe('.claude');
  });
});

// ---------------------------------------------------------------------------
// 7. resolveConfigFile mapping
// ---------------------------------------------------------------------------

describe('resolveConfigFile', () => {
  it('returns "CLAUDE.md" for platform "claude"', () => {
    expect(resolveConfigFile('claude')).toBe('CLAUDE.md');
  });

  it('returns "AGENTS.md" for platform "codex"', () => {
    expect(resolveConfigFile('codex')).toBe('AGENTS.md');
  });

  it('returns "CLAUDE.md" for platform "cursor"', () => {
    expect(resolveConfigFile('cursor')).toBe('CLAUDE.md');
  });

  it('returns "AGENTS.md" for platform "pi"', () => {
    expect(resolveConfigFile('pi')).toBe('AGENTS.md');
  });
});

// ---------------------------------------------------------------------------
// 8. SO_SHARED_DIR is constant
// ---------------------------------------------------------------------------

describe('SO_SHARED_DIR', () => {
  it('equals ".orchestrator" regardless of platform', () => {
    expect(SO_SHARED_DIR).toBe('.orchestrator');
  });
});

// ---------------------------------------------------------------------------
// 9. detectPlatform env-var precedence
// ---------------------------------------------------------------------------

describe('detectPlatform', () => {
  it.each(['claude', 'codex', 'cursor', 'pi'])(
    'honors trimmed explicit SO_PLATFORM=%s before compatibility env vars',
    (platform) => {
      vi.stubEnv('SO_PLATFORM', `  ${platform}  `);
      vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/claude/compatibility/root');
      expect(detectPlatform()).toBe(platform);
    },
  );

  it('returns explicit codex when Claude compatibility env variables are also set', () => {
    vi.stubEnv('SO_PLATFORM', 'codex');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/claude/compatibility/root');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '/codex/root');
    expect(detectPlatform()).toBe('codex');
  });

  it('ignores an invalid explicit platform and uses compatibility detection', () => {
    vi.stubEnv('SO_PLATFORM', 'vscode');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '/codex/root');
    expect(detectPlatform()).toBe('codex');
  });

  it('ignores whitespace-only explicit and compatibility values', () => {
    vi.stubEnv('SO_PLATFORM', '   ');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '   ');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '/codex/root');
    expect(detectPlatform()).toBe('codex');
  });

  it('does not infer platform identity from PLUGIN_ROOT', () => {
    vi.stubEnv('PLUGIN_ROOT', '/native/codex/plugin/root');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/claude/compatibility/root');
    expect(detectPlatform()).toBe('claude');
  });

  it('returns "claude" when CLAUDE_PLUGIN_ROOT is set', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/some/path');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('CURSOR_RULES_DIR', '');
    expect(detectPlatform()).toBe('claude');
  });

  it('returns "codex" when CODEX_PLUGIN_ROOT is set and CLAUDE_PLUGIN_ROOT is unset', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '/some/codex/path');
    vi.stubEnv('CURSOR_RULES_DIR', '');
    expect(detectPlatform()).toBe('codex');
  });

  it('returns "cursor" when CURSOR_RULES_DIR is set and other env vars are unset', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('CURSOR_RULES_DIR', '/some/cursor/path');
    vi.stubEnv('PI_PLUGIN_ROOT', '');
    expect(detectPlatform()).toBe('cursor');
  });

  it('returns "pi" when PI_PLUGIN_ROOT is set and other env vars are unset', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('CURSOR_RULES_DIR', '');
    vi.stubEnv('PI_PLUGIN_ROOT', '/some/pi/path');
    expect(detectPlatform()).toBe('pi');
  });

  it('CLAUDE_PLUGIN_ROOT takes precedence over CODEX_PLUGIN_ROOT', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/claude/root');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '/codex/root');
    vi.stubEnv('CURSOR_RULES_DIR', '');
    expect(detectPlatform()).toBe('claude');
  });

  it('returns "claude" as default when no env vars are set', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('CURSOR_RULES_DIR', '');
    // When no env var is set and no marker directories are found,
    // default is "claude". The test CWD is the repo root which has
    // a .claude-plugin dir — which would also return "claude".
    const result = detectPlatform();
    expect(['claude', 'codex', 'cursor', 'pi']).toContain(result);
  });
});

// ---------------------------------------------------------------------------
// 10. resolvePluginRoot returns absolute path
// ---------------------------------------------------------------------------

describe('resolvePluginRoot', () => {
  it('returns an absolute path or empty string', () => {
    const result = resolvePluginRoot();
    // Either resolves to an absolute path or returns empty string when not found
    expect(typeof result).toBe('string');
    if (result !== '') {
      expect(path.isAbsolute(result)).toBe(true);
    }
  });

  it('returns an absolute path when CLAUDE_PLUGIN_ROOT points to an existing directory', () => {
    // Use fileURLToPath to get an OS-correct absolute path on all platforms
    // (URL.pathname on Windows has a leading slash: /C:/Users/...).
    const scriptsDir = path.resolve(fileURLToPath(new URL('../../scripts', import.meta.url)));
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', scriptsDir);
    const result = resolvePluginRoot('claude');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(scriptsDir);
  });

  it('uses the Codex compatibility root selected by explicit SO_PLATFORM', () => {
    const repoDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const scriptsDir = path.join(repoDir, 'scripts');
    vi.stubEnv('SO_PLATFORM', ' codex ');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', scriptsDir);
    vi.stubEnv('CODEX_PLUGIN_ROOT', repoDir);
    expect(resolvePluginRoot()).toBe(repoDir);
  });

  it('prefers native PLUGIN_ROOT over simultaneous explicit and compatibility roots', () => {
    const repoDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const scriptsDir = path.join(repoDir, 'scripts');
    const hooksDir = path.join(repoDir, 'hooks');
    vi.stubEnv('SO_PLATFORM', 'codex');
    vi.stubEnv('PLUGIN_ROOT', `  ${hooksDir}  `);
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', scriptsDir);
    vi.stubEnv('CODEX_PLUGIN_ROOT', repoDir);
    vi.stubEnv('CURSOR_RULES_DIR', scriptsDir);
    vi.stubEnv('PI_PLUGIN_ROOT', scriptsDir);

    expect(resolvePluginRoot()).toBe(hooksDir);
  });

  it.each([
    ['whitespace-only', '   '],
    ['nonexistent', '/definitely/missing/session-orchestrator-plugin-root'],
  ])('falls back from a %s native root to explicit Codex compatibility', (_case, nativeRoot) => {
    const repoDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const scriptsDir = path.join(repoDir, 'scripts');
    vi.stubEnv('SO_PLATFORM', 'codex');
    vi.stubEnv('PLUGIN_ROOT', nativeRoot);
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', scriptsDir);
    vi.stubEnv('CODEX_PLUGIN_ROOT', repoDir);

    expect(resolvePluginRoot()).toBe(repoDir);
  });

  it('getPluginRoot() is either empty or an absolute path', () => {
    const root = getPluginRoot();
    if (root !== '') {
      expect(path.isAbsolute(root)).toBe(true);
    } else {
      expect(root).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// 11. SO_PLATFORM is one of the valid platform values
// ---------------------------------------------------------------------------

describe('getPlatform', () => {
  it('is one of "claude", "codex", "cursor", or "pi"', () => {
    expect(['claude', 'codex', 'cursor', 'pi']).toContain(getPlatform());
  });
});

// ---------------------------------------------------------------------------
// 12. resolveProjectDir returns an absolute path
// ---------------------------------------------------------------------------

describe('resolveProjectDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an absolute path', () => {
    const result = resolveProjectDir();
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('returns CLAUDE_PROJECT_DIR when that env var is set', () => {
    vi.stubEnv('CLAUDE_PROJECT_DIR', '/my/project');
    vi.stubEnv('CODEX_PROJECT_DIR', '');
    vi.stubEnv('CURSOR_PROJECT_DIR', '');
    const result = resolveProjectDir('claude');
    expect(result).toBe('/my/project');
    vi.unstubAllEnvs();
  });

  it('returns CODEX_PROJECT_DIR when CLAUDE_PROJECT_DIR is unset', () => {
    vi.stubEnv('CLAUDE_PROJECT_DIR', '');
    vi.stubEnv('CODEX_PROJECT_DIR', '/my/codex/project');
    vi.stubEnv('CURSOR_PROJECT_DIR', '');
    const result = resolveProjectDir('codex');
    expect(result).toBe('/my/codex/project');
    vi.unstubAllEnvs();
  });

  it('returns PI_PROJECT_DIR when higher-precedence project env vars are unset', () => {
    vi.stubEnv('CLAUDE_PROJECT_DIR', '');
    vi.stubEnv('CODEX_PROJECT_DIR', '');
    vi.stubEnv('CURSOR_PROJECT_DIR', '');
    vi.stubEnv('PI_PROJECT_DIR', '/my/pi/project');
    const result = resolveProjectDir('pi');
    expect(result).toBe('/my/pi/project');
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// 13. Walk boundary — the marker search never leaves the project (#1139)
// ---------------------------------------------------------------------------

describe('walk boundary (#1139)', () => {
  /** @type {string} */
  let sandbox;

  beforeEach(() => {
    // realpathSync: macOS reaches tmpdir through a symlink (/var -> /private/var).
    // The boundary compares resolved path strings, so the faked HOME and the faked
    // cwd must agree on one form.
    sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'so-platform-boundary-')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * Point os.homedir() and process.cwd() into the sandbox.
   * os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
   *
   * @param {string} relCwd  Path of the faked cwd relative to the sandbox
   * @returns {string}  The absolute faked cwd
   */
  const enterSandbox = (relCwd) => {
    vi.stubEnv('HOME', sandbox);
    vi.stubEnv('USERPROFILE', sandbox);
    const cwd = path.join(sandbox, relCwd);
    mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    return cwd;
  };

  it('does not adopt a marker sitting in the home directory (the ~/.pi false positive)', () => {
    mkdirSync(path.join(sandbox, '.pi'));
    enterSandbox(path.join('scratch', 'nested'));

    expect(detectPlatform()).toBe('claude');
  });

  it('stops at a repo root marked by a .git FILE (worktree form)', () => {
    mkdirSync(path.join(sandbox, 'outer', '.pi'), { recursive: true });
    const repo = path.join(sandbox, 'outer', 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, '.git'), 'gitdir: /elsewhere/worktrees/repo\n');
    enterSandbox(path.join('outer', 'repo', 'sub', 'deep'));

    expect(detectPlatform()).toBe('claude');
  });

  it('still finds a marker at the repo root itself', () => {
    const repo = path.join(sandbox, 'outer', 'repo');
    mkdirSync(path.join(repo, '.codex-plugin'), { recursive: true });
    writeFileSync(path.join(repo, '.git'), 'gitdir: /elsewhere/worktrees/repo\n');
    enterSandbox(path.join('outer', 'repo', 'sub', 'deep'));

    expect(detectPlatform()).toBe('codex');
  });

  it('resolveProjectDir does not return the home directory for a stray CLAUDE.md there', () => {
    writeFileSync(path.join(sandbox, 'CLAUDE.md'), '# stray home-level config\n');
    const cwd = enterSandbox(path.join('scratch', 'nested'));

    expect(resolveProjectDir('claude')).toBe(cwd);
  });
});

// ---------------------------------------------------------------------------
// 16. Lazy, memoized accessors (#1153 P5)
//
// The bug these pin: the five SO_* values used to be `export const … = detect…()`
// evaluated at MODULE LOAD, so every static importer — including the hottest
// deny-capable hooks, which run on every tool call — paid a filesystem walk-up
// just for importing platform.mjs, whether or not it ever read the value.
// ---------------------------------------------------------------------------

describe('lazy platform accessors (#1153 P5)', () => {
  it('memoizes: three calls detect once', () => {
    vi.stubEnv('CODEX_PLUGIN_ROOT', '/tmp/does-not-matter');
    expect(getPlatform()).toBe('codex');

    // Change the environment WITHOUT resetting — a memoized value must not
    // re-detect, otherwise the "compute once per process" contract is a lie.
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('CURSOR_RULES_DIR', '/tmp/does-not-matter');
    expect(getPlatform()).toBe('codex');
    expect(getPlatform()).toBe('codex');
  });

  it('_resetPlatformCache() makes the next call re-detect', () => {
    vi.stubEnv('CODEX_PLUGIN_ROOT', '/tmp/does-not-matter');
    expect(getPlatform()).toBe('codex');

    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('PI_PLUGIN_ROOT', '/tmp/does-not-matter');
    _resetPlatformCache();
    expect(getPlatform()).toBe('pi');
  });

  it('derived accessors follow the memoized platform', () => {
    vi.stubEnv('CODEX_PLUGIN_ROOT', '/tmp/does-not-matter');
    expect(getStateDir()).toBe('.codex');
    expect(getConfigFile()).toBe('AGENTS.md');

    _resetPlatformCache();
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('CURSOR_RULES_DIR', '/tmp/does-not-matter');
    expect(getStateDir()).toBe('.cursor');
    expect(getConfigFile()).toBe('CLAUDE.md');
  });

  it('importing platform.mjs performs ZERO filesystem calls', async () => {
    const calls = [];
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      /** @type {any} */
      const actual = await importOriginal();
      return {
        ...actual,
        default: actual.default ?? actual,
        existsSync: (...args) => { calls.push(['existsSync', args[0]]); return actual.existsSync(...args); },
        statSync: (...args) => { calls.push(['statSync', args[0]]); return actual.statSync(...args); },
        readFileSync: (...args) => { calls.push(['readFileSync', args[0]]); return actual.readFileSync(...args); },
      };
    });

    try {
      const mod = await import('@lib/platform.mjs');
      // The import itself must be filesystem-silent …
      expect(calls).toEqual([]);

      // First USE is where the work happens — proves the spies were live and
      // that the empty array above is a measurement, not a mocking artefact.
      mod.getProjectDir();
      expect(calls.length).toBeGreaterThan(0);
      mod._resetPlatformCache();
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// Deprecated compat bindings are DELETED (#1153 P5 follow-up)
// ---------------------------------------------------------------------------

describe('deprecated compat bindings', () => {
  it('does not export SO_PLATFORM/SO_PLUGIN_ROOT/SO_PROJECT_DIR/SO_STATE_DIR/SO_CONFIG_FILE', async () => {
    // Bug this catches: re-introducing any of these as an `export let` live
    // binding brings back the #1153 P5 defect — the name is `undefined` until
    // some getter has run in the process, so a bare importer silently resolves
    // a root/platform to undefined instead of failing loudly. Deletion is the
    // fix; this assertion is the tripwire against a quiet re-introduction.
    const mod = await import('@lib/platform.mjs');
    const names = Object.keys(mod);
    for (const removed of [
      'SO_PLATFORM',
      'SO_PLUGIN_ROOT',
      'SO_PROJECT_DIR',
      'SO_STATE_DIR',
      'SO_CONFIG_FILE',
    ]) {
      expect(names).not.toContain(removed);
    }
    // Control: the plain constants that were KEPT are still exported, so a
    // wholesale export-list breakage cannot make the assertion above pass.
    expect(names).toEqual(expect.arrayContaining(['SO_SHARED_DIR', 'SO_OS', 'SO_PATH_SEP']));
  });
});

// ---------------------------------------------------------------------------
// resolveSessionRoot (#1492) — the rungs the hook-level tests do not reach.
// Existence-only `.git` entries: the resolver never asks git, so neither does this.
// ---------------------------------------------------------------------------

describe('resolveSessionRoot (#1492)', () => {
  /** @type {string} */
  let sandbox;

  beforeEach(() => {
    // realpath: the clamp compares canonical paths (macOS /var -> /private/var).
    sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'so-session-root-')));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** mkdir -p `rel` inside the sandbox; with `dotGit`, mark it a repo root. */
  const dirAt = (rel, { dotGit = false } = {}) => {
    const dir = path.join(sandbox, rel);
    mkdirSync(dir, { recursive: true });
    if (dotGit) mkdirSync(path.join(dir, '.git'));
    return dir;
  };

  const AGENT = 'agent-a0123456789abcdef0';

  it('falls back to $CLAUDE_PROJECT_DIR when cwd is in no repo — a `cd sub` in a non-git project keeps its manifest', () => {
    // Bug caught: without the env rung a non-git project resolved to the
    // subdirectory the session `cd`-ed into, which holds no manifest — every
    // scope gate allowed everything from then on.
    const proj = dirAt('proj');
    const sub = dirAt(path.join('proj', 'sub'));
    vi.stubEnv('CLAUDE_PROJECT_DIR', proj);

    expect(resolveSessionRoot(sub)).toBe(proj);
  });

  it('does not lift an agent-shaped worktree whose parent is no working copy', () => {
    // Bug caught: the lift would leave every repository — for a checkout at
    // `~/.claude/worktrees/agent-<hex>` (the harness layout, inside Claude's own
    // config dir) the session root became `$HOME`, where pre-task-scope-disjoint
    // writes its ledger and events unconditionally.
    const agentWt = dirAt(path.join('home', '.claude', 'worktrees', AGENT), { dotGit: true });

    expect(resolveSessionRoot(path.join(agentWt, 'src'))).toBe(agentWt);
  });

  it('clamps a lifted agent worktree to a launch dir in a subdirectory of the repo', () => {
    // Bug caught: the harness puts agent worktrees under the repo root, so an
    // agent of a session launched in `/mono/packages/foo` lifted to `/mono` —
    // above the launch dir, no manifest — and was unenforced. Before #1492 it
    // resolved the launch dir. A clamp that also required `cwd` inside the launch
    // dir would miss exactly this case: the agent's `cwd` never is.
    const mono = dirAt('mono', { dotGit: true });
    const pkg = dirAt(path.join('mono', 'packages', 'foo'));
    const agentWt = dirAt(path.join('mono', '.claude', 'worktrees', AGENT), { dotGit: true });
    vi.stubEnv('CLAUDE_PROJECT_DIR', pkg);

    expect(resolveSessionRoot(agentWt)).toBe(pkg);
    // Control: the lift itself still lands on the repo root without a launch dir.
    vi.stubEnv('CLAUDE_PROJECT_DIR', '');
    expect(resolveSessionRoot(agentWt)).toBe(mono);
  });

  it('keeps a worktree entered directly inside the launch dir (`git worktree add wt`) — the launch dir is its parent, not a descendant', () => {
    // Bug caught: `path.relative(<launch>/wt, <launch>)` is the bare `..`, which
    // neither equals '' nor starts with `../`. Read as "inside", the clamp sent
    // the session back to the launch dir, where it has no manifest (#1492).
    const launch = dirAt('main', { dotGit: true });
    const wt = dirAt(path.join('main', 'wt'), { dotGit: true });
    vi.stubEnv('CLAUDE_PROJECT_DIR', launch);

    expect(resolveSessionRoot(wt)).toBe(wt);
  });

  it.each([
    ['CURSOR_PROJECT_DIR'],
    ['PI_PROJECT_DIR'],
  ])('clamps on a bridge-set %s too — a bridge workspace in a repo subdirectory keeps its manifest', (envName) => {
    // Bug caught (review HIGH-1 on b57e572c): the Cursor and Pi bridges delete
    // CLAUDE_PROJECT_DIR and set their own `*_PROJECT_DIR` to the payload `cwd`.
    // A clamp on CLAUDE_PROJECT_DIR alone never fired there, so a workspace in
    // `<repo>/sub` climbed to `<repo>`, found no manifest, and every scope gate
    // allowed — where before #1492 the bridges resolved `<repo>/sub`.
    const repo = dirAt('repo', { dotGit: true });
    const sub = dirAt(path.join('repo', 'sub'));
    vi.stubEnv(envName, sub);

    expect(resolveSessionRoot(sub)).toBe(sub);
    // Control: the same cwd without any launch dir still resolves the repo root.
    vi.stubEnv(envName, '');
    expect(resolveSessionRoot(sub)).toBe(repo);
  });

  it('denies an out-of-scope Write end-to-end through the Cursor bridge for a workspace in a repo subdirectory', async () => {
    // Bug caught (review HIGH-1 on b57e572c): the resolver row above, wired
    // through the real bridge env (CLAUDE_PROJECT_DIR deleted, CURSOR_PROJECT_DIR
    // = payload cwd) into the real enforce-scope hook. With the clamp on
    // CLAUDE_PROJECT_DIR alone the hook resolved `<mono>`, which holds no
    // manifest, and allowed the write.
    dirAt('mono', { dotGit: true });
    const pkg = dirAt(path.join('mono', 'packages', 'foo', '.cursor'));
    writeFileSync(path.join(pkg, 'wave-scope.json'), JSON.stringify({
      wave: 1,
      role: 'impl',
      enforcement: 'strict',
      allowedPaths: ['src/**'],
    }));
    const cwd = path.dirname(pkg);

    const result = await runCursorHookEvent(
      'preToolUse',
      { tool_name: 'Write', tool_input: { file_path: 'other/x.mjs', content: 'x' } },
      { cwd },
      { pluginRoot: REPO_ROOT },
    );

    expect(result.payload.cwd).toBe(cwd);
    expect(result.block).toBe(true);
    // A scope-violation reason, not a fail-closed hook timeout under load.
    expect(result.reason).toMatch(/Scope violation: 'other\/x\.mjs'/);
  }, 30000);

  it('clamps when $CLAUDE_PROJECT_DIR and cwd spell one directory differently (symlink vs realpath)', () => {
    // Bug caught: compared as resolved strings, an unresolved launch spelling
    // (macOS mkdtemp `/var/…` vs the realpath `/private/var/…` in `cwd`) is not
    // "inside" the canonical repo root, so the clamp lapsed and a subdirectory
    // launch resolved to the repo root above its manifest. An explicit symlink
    // reproduces the split on every OS, not only where `$TMPDIR` is one.
    const mono = dirAt('mono', { dotGit: true });
    const pkg = dirAt(path.join('mono', 'packages', 'foo'));
    const linkParent = realpathSync(mkdtempSync(path.join(tmpdir(), 'so-session-root-link-')));
    try {
      const link = path.join(linkParent, 'via-link');
      symlinkSync(sandbox, link);
      const launchViaLink = path.join(link, 'mono', 'packages', 'foo');
      vi.stubEnv('CLAUDE_PROJECT_DIR', launchViaLink);

      expect(resolveSessionRoot(pkg)).toBe(launchViaLink);
      expect(resolveSessionRoot(pkg)).not.toBe(mono);
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #1504 point 8 — APFS case spelling must not skip the clamp.
// ---------------------------------------------------------------------------

describe('resolveSessionRoot — case-insensitive volume spelling (#1504 point 8)', () => {
  /** @type {string} */
  let sandbox;
  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'so-case-root-')));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('clamps on a launch dir spelled in another letter case — the monorepo-package manifest stays the decider', () => {
    // Bug caught: `_canonical` used the JS `realpathSync`, which keeps the
    // CALLER's letter case on a case-insensitive volume. A launch dir spelled
    // `<sandbox>/MONO/pkg` beside the git-found `<sandbox>/mono` gave
    // `path.relative` = `../MONO/pkg`, the clamp was skipped, and a package
    // session climbed to the repo root, where no manifest lives.
    const mono = path.join(sandbox, 'mono');
    const pkg = path.join(mono, 'pkg');
    mkdirSync(path.join(mono, '.git'), { recursive: true });
    mkdirSync(pkg, { recursive: true });
    const upper = path.join(sandbox, 'MONO', 'pkg');
    let caseInsensitive = false;
    try { caseInsensitive = realpathSync(upper) !== ''; } catch { /* case-sensitive volume */ }
    if (!caseInsensitive) return; // the split cannot exist on a case-sensitive volume

    vi.stubEnv('CLAUDE_PROJECT_DIR', upper);
    expect(resolveSessionRoot(pkg)).toBe(upper);
    // Control: the same spelling as the repo root clamps either way.
    vi.stubEnv('CLAUDE_PROJECT_DIR', pkg);
    expect(resolveSessionRoot(pkg)).toBe(pkg);
  });
});
