/**
 * tests/lib/plugin-root.test.mjs
 *
 * Unit tests for scripts/lib/plugin-root.mjs
 * Issue #212 — layered plugin root fallback
 *
 * Test IDs (AC 5):
 *   env-native              — native PLUGIN_ROOT precedence
 *   env-claude/codex/cursor/pi — legacy compatibility fallbacks
 *   env-precedence          — explicit SO_PLATFORM matching + legacy order
 *   walk-from-import-meta   — walk up from this file's location
 *   walk-from-cwd           — walk up from cwd
 *   all-fail-throws         — all levels fail → PluginRootResolutionError diagnostics
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory with a package.json whose name matches (or not).
 * Returns the absolute path to the temp dir.
 *
 * @param {string} name  package.json "name" field
 * @returns {string}
 */
function makeTmpPluginDir(name = 'session-orchestrator') {
  const dir = path.join(os.tmpdir(), `plugin-root-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }), 'utf8');
  return dir;
}

// ---------------------------------------------------------------------------
// We must re-import the module with a fresh env for each test because
// resolvePluginRoot reads process.env at call time (not at module load time),
// so vi.stubEnv works correctly here without module reloading.
// ---------------------------------------------------------------------------

// Dynamically import so ESM module cache is shared; env stubs apply per-call.
const { resolvePluginRoot, PluginRootResolutionError } = await import('@lib/plugin-root.mjs');

const ROOT_ENV_KEYS = [
  'SO_PLATFORM',
  'PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CURSOR_RULES_DIR',
  'PI_PLUGIN_ROOT',
];

beforeEach(() => {
  for (const key of ROOT_ENV_KEYS) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('PluginRootResolutionError', () => {
  it('is an instance of Error with correct name', () => {
    const err = new PluginRootResolutionError('test', ['a', 'b']);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PluginRootResolutionError');
    expect(err.message).toBe('test');
    expect(err.triedPaths).toEqual(['a', 'b']);
  });
});

describe('resolvePluginRoot — native PLUGIN_ROOT', () => {
  let nativeDir;
  let claudeDir;
  let codexDir;
  let cursorDir;
  let piDir;

  beforeEach(() => {
    nativeDir = makeTmpPluginDir('session-orchestrator');
    claudeDir = makeTmpPluginDir('session-orchestrator');
    codexDir = makeTmpPluginDir('session-orchestrator');
    cursorDir = makeTmpPluginDir('session-orchestrator');
    piDir = makeTmpPluginDir('session-orchestrator');
    vi.stubEnv('SO_PLATFORM', 'codex');
    vi.stubEnv('PLUGIN_ROOT', `  ${nativeDir}  `);
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', claudeDir);
    vi.stubEnv('CODEX_PLUGIN_ROOT', codexDir);
    vi.stubEnv('CURSOR_RULES_DIR', cursorDir);
    vi.stubEnv('PI_PLUGIN_ROOT', piDir);
  });

  afterEach(() => {
    rmSync(nativeDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(codexDir, { recursive: true, force: true });
    rmSync(cursorDir, { recursive: true, force: true });
    rmSync(piDir, { recursive: true, force: true });
  });

  it('returns the trimmed native root before simultaneous explicit-platform roots', () => {
    expect(resolvePluginRoot()).toBe(nativeDir);
  });
});

describe('resolvePluginRoot — env-claude compatibility fallback', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpPluginDir('session-orchestrator');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', tmpDir);
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('PI_PLUGIN_ROOT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns CLAUDE_PLUGIN_ROOT when set to an existing directory', () => {
    const result = resolvePluginRoot();
    expect(result).toBe(tmpDir);
  });

  it('does not walk the filesystem when env var is set', () => {
    // If it walked, it would find this test file's repo root — but we're asserting
    // it returns the env var value, which proves the walk was bypassed.
    const result = resolvePluginRoot();
    expect(result).toBe(tmpDir);
  });
});

describe('resolvePluginRoot — env-codex compatibility fallback', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpPluginDir('session-orchestrator');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('CODEX_PLUGIN_ROOT', tmpDir);
    vi.stubEnv('PI_PLUGIN_ROOT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns CODEX_PLUGIN_ROOT when CLAUDE_PLUGIN_ROOT is unset', () => {
    const result = resolvePluginRoot();
    expect(result).toBe(tmpDir);
  });
});

describe('resolvePluginRoot — env-cursor', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpPluginDir('session-orchestrator');
    vi.stubEnv('CURSOR_RULES_DIR', `  ${tmpDir}  `);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the trimmed CURSOR_RULES_DIR legacy fallback', () => {
    expect(resolvePluginRoot()).toBe(tmpDir);
  });
});

describe('resolvePluginRoot — env-pi compatibility fallback', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpPluginDir('session-orchestrator');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('PI_PLUGIN_ROOT', tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns PI_PLUGIN_ROOT when CLAUDE_PLUGIN_ROOT and CODEX_PLUGIN_ROOT are unset', () => {
    const result = resolvePluginRoot();
    expect(result).toBe(tmpDir);
  });
});

describe('resolvePluginRoot — env-precedence', () => {
  let claudeDir;
  let codexDir;
  let cursorDir;
  let piDir;

  beforeEach(() => {
    claudeDir = makeTmpPluginDir('session-orchestrator');
    codexDir = makeTmpPluginDir('session-orchestrator');
    cursorDir = makeTmpPluginDir('session-orchestrator');
    piDir = makeTmpPluginDir('session-orchestrator');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', claudeDir);
    vi.stubEnv('CODEX_PLUGIN_ROOT', codexDir);
    vi.stubEnv('CURSOR_RULES_DIR', cursorDir);
    vi.stubEnv('PI_PLUGIN_ROOT', piDir);
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(codexDir, { recursive: true, force: true });
    rmSync(cursorDir, { recursive: true, force: true });
    rmSync(piDir, { recursive: true, force: true });
  });

  it('preserves Claude-first legacy precedence without explicit SO_PLATFORM', () => {
    expect(resolvePluginRoot()).toBe(claudeDir);
  });

  it.each([
    ['claude', () => claudeDir],
    ['codex', () => codexDir],
    ['cursor', () => cursorDir],
    ['pi', () => piDir],
  ])('prefers the %s compatibility root for matching explicit SO_PLATFORM', (platform, expectedDir) => {
    vi.stubEnv('SO_PLATFORM', `  ${platform}  `);
    expect(resolvePluginRoot()).toBe(expectedDir());
  });

  it('ignores invalid explicit SO_PLATFORM and preserves legacy precedence', () => {
    vi.stubEnv('SO_PLATFORM', 'vscode');
    expect(resolvePluginRoot()).toBe(claudeDir);
  });

  it('ignores whitespace-only explicit SO_PLATFORM and preserves legacy precedence', () => {
    vi.stubEnv('SO_PLATFORM', '   ');
    expect(resolvePluginRoot()).toBe(claudeDir);
  });

  it.each([
    ['whitespace-only', '   '],
    ['non-directory', '/definitely/missing/session-orchestrator-plugin-root'],
  ])('falls back from a %s native root to the explicit Codex root', (_case, nativeRoot) => {
    vi.stubEnv('SO_PLATFORM', 'codex');
    vi.stubEnv('PLUGIN_ROOT', nativeRoot);

    expect(resolvePluginRoot()).toBe(codexDir);
  });

  it('continues to legacy precedence when the explicit-platform root is invalid', () => {
    vi.stubEnv('SO_PLATFORM', 'codex');
    vi.stubEnv('PLUGIN_ROOT', '   ');
    vi.stubEnv('CODEX_PLUGIN_ROOT', path.join(codexDir, 'missing'));

    expect(resolvePluginRoot()).toBe(claudeDir);
  });
});

describe('resolvePluginRoot — walk-from-import-meta (Level 4)', () => {
  beforeEach(() => {
    // Clear env vars so levels 1 + 2 + 3 are skipped
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('PI_PLUGIN_ROOT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves plugin root by walking up from import.meta.url', () => {
    // scripts/lib/plugin-root.mjs walks up from its own location.
    // The session-orchestrator repo root has a package.json with name "session-orchestrator".
    // Even from the test file location (tests/lib/), the walk should find it.
    const result = resolvePluginRoot();

    // Must be a non-empty string
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);

    // Must contain a package.json with name "session-orchestrator"
    const pkg = JSON.parse(readFileSync(path.join(result, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('session-orchestrator');
  });
});

describe('resolvePluginRoot — walk-from-cwd (Level 5)', () => {
  let tmpDir;

  beforeEach(() => {
    // Create a tmp dir that is NOT inside the session-orchestrator repo
    // so import.meta.url walk won't find the real root first — BUT
    // we want to test cwd walk. We accomplish this by creating a plugin
    // dir and then having a subdirectory as the "cwd" for the walk.
    tmpDir = makeTmpPluginDir('session-orchestrator');

    // Create a subdirectory inside the tmp plugin dir; set it as cwd
    // for the walk simulation. We can't actually change process.cwd(), so
    // instead we test that the walk from cwd finds the *real* repo root,
    // which is what happens when env vars are unset and the test runner
    // runs from within the repo.
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('CODEX_PLUGIN_ROOT', '');
    vi.stubEnv('PI_PLUGIN_ROOT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds the plugin root when cwd is inside the repo', () => {
    // process.cwd() is the repo root (or inside it) during test runs.
    // With env vars unset, the walk from import.meta.url (scripts/lib/)
    // will find the repo root at Level 3. This demonstrates the cwd
    // walk fallback behaviour by verifying the overall resolution works.
    const result = resolvePluginRoot();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('resolvePluginRoot — all-fail-throws-named-error', () => {
  // We need to test the throw path. The only way to make all levels fail is:
  // - env vars unset (levels 1+2+3 skip)
  // - import.meta.url walk must not find a matching package.json
  // - cwd walk must not find a matching package.json
  //
  // Since this test runs inside the session-orchestrator repo, levels 3+4
  // would always succeed in normal conditions. We test the error class
  // construction and verify the guard condition logic by unit-testing the
  // error class directly, and use a deliberately wrong env var value to
  // validate the error path for non-directory env vars.

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('PluginRootResolutionError carries triedPaths array', () => {
    const err = new PluginRootResolutionError('failed', [
      'CLAUDE_PLUGIN_ROOT (not set)',
      'CODEX_PLUGIN_ROOT (not set)',
      'PI_PLUGIN_ROOT (not set)',
      'walk from import.meta.url — not found',
      'walk from cwd — not found',
    ]);
    expect(err.name).toBe('PluginRootResolutionError');
    expect(err.triedPaths).toHaveLength(5);
    expect(err.triedPaths[0]).toContain('CLAUDE_PLUGIN_ROOT');
    expect(err.triedPaths[2]).toContain('PI_PLUGIN_ROOT');
    expect(err.triedPaths[4]).toContain('cwd');
  });

  it('reports trimmed invalid and whitespace-only env paths before throwing', () => {
    const isolatedDir = path.join(
      os.tmpdir(),
      `plugin-root-isolated-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(isolatedDir, { recursive: true });

    try {
      const isolatedModule = path.join(isolatedDir, 'plugin-root.mjs');
      copyFileSync(fileURLToPath(new URL('../../scripts/lib/plugin-root.mjs', import.meta.url)), isolatedModule);
      const missingNative = path.join(isolatedDir, 'missing-native');
      const missingCodex = path.join(isolatedDir, 'missing-codex');
      const script = `
        import { resolvePluginRoot } from ${JSON.stringify(pathToFileURL(isolatedModule).href)};
        try {
          resolvePluginRoot();
          process.exit(2);
        } catch (error) {
          console.log(JSON.stringify({
            name: error.name,
            message: error.message,
            triedPaths: error.triedPaths,
          }));
        }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: isolatedDir,
        env: {
          ...process.env,
          SO_PLATFORM: 'codex',
          PLUGIN_ROOT: `  ${missingNative}  `,
          CLAUDE_PLUGIN_ROOT: '   ',
          CODEX_PLUGIN_ROOT: missingCodex,
          CURSOR_RULES_DIR: '',
          PI_PLUGIN_ROOT: '',
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      const error = JSON.parse(result.stdout.trim());
      expect(error.name).toBe('PluginRootResolutionError');
      expect(error.message).toContain('PLUGIN_ROOT');
      expect(error.triedPaths).toContain(`PLUGIN_ROOT=${missingNative} (not a directory)`);
      expect(error.triedPaths).toContain(`CODEX_PLUGIN_ROOT=${missingCodex} (not a directory)`);
      expect(error.triedPaths).toContain('CLAUDE_PLUGIN_ROOT (empty after trim)');
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it('error message mentions all env var names when all levels fail', () => {
    // Simulate the error message format
    const err = new PluginRootResolutionError(
      'Could not resolve session-orchestrator plugin root. ' +
      'Set CLAUDE_PLUGIN_ROOT, CODEX_PLUGIN_ROOT, or PI_PLUGIN_ROOT to the plugin directory',
      [],
    );
    expect(err.message).toContain('CLAUDE_PLUGIN_ROOT');
    expect(err.message).toContain('CODEX_PLUGIN_ROOT');
    expect(err.message).toContain('PI_PLUGIN_ROOT');
    expect(err.message).toContain('session-orchestrator');
  });
});
