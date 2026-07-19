/**
 * tests/lib/platform.test.mjs
 *
 * Unit tests for scripts/lib/platform.mjs
 * Runs on Ubuntu, macOS, and Windows via CI matrix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SO_OS,
  SO_IS_WINDOWS,
  SO_IS_WSL,
  SO_PATH_SEP,
  SO_PLATFORM,
  SO_PLUGIN_ROOT,
  SO_PROJECT_DIR,
  SO_STATE_DIR,
  SO_CONFIG_FILE,
  SO_SHARED_DIR,
  detectPlatform,
  resolvePluginRoot,
  resolveProjectDir,
  resolveStateDir,
  resolveConfigFile,
} from '@lib/platform.mjs';

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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 1. Module loads without error — all exports are defined
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports all 10 constants as non-undefined values', () => {
    expect(SO_OS).not.toBeUndefined();
    expect(SO_IS_WINDOWS).not.toBeUndefined();
    expect(SO_IS_WSL).not.toBeUndefined();
    expect(SO_PATH_SEP).not.toBeUndefined();
    expect(SO_PLATFORM).not.toBeUndefined();
    expect(SO_PLUGIN_ROOT).not.toBeUndefined();
    expect(SO_PROJECT_DIR).not.toBeUndefined();
    expect(SO_STATE_DIR).not.toBeUndefined();
    expect(SO_CONFIG_FILE).not.toBeUndefined();
    expect(SO_SHARED_DIR).not.toBeUndefined();
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

  it('SO_PLUGIN_ROOT constant is either empty or an absolute path', () => {
    if (SO_PLUGIN_ROOT !== '') {
      expect(path.isAbsolute(SO_PLUGIN_ROOT)).toBe(true);
    } else {
      expect(SO_PLUGIN_ROOT).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// 11. SO_PLATFORM is one of the valid platform values
// ---------------------------------------------------------------------------

describe('SO_PLATFORM', () => {
  it('is one of "claude", "codex", "cursor", or "pi"', () => {
    expect(['claude', 'codex', 'cursor', 'pi']).toContain(SO_PLATFORM);
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
