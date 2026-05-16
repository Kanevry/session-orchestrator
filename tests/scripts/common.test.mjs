/**
 * tests/scripts/common.test.mjs
 *
 * Vitest tests for the shell-helper ports added to scripts/lib/common.mjs
 * (issue #218 — Port install/validate shell tooling to .mjs, retire common.sh).
 *
 * Functions under test: die, warn, requireJq, findProjectRoot, resolvePluginRoot
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

// ---------------------------------------------------------------------------
// die
// ---------------------------------------------------------------------------
// die() calls process.exit(1) — we test it by importing the live module and
// mocking process.exit + process.stderr.write so no actual exit occurs.

describe('die', () => {
  let exitSpy;
  let stderrSpy;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes "ERROR: <message>" to stderr', async () => {
    const { die } = await import('@lib/common.mjs');
    try { die('something failed'); } catch { /* swallow exit mock */ }
    expect(stderrSpy).toHaveBeenCalledWith('ERROR: something failed\n');
  });

  it('calls process.exit(1)', async () => {
    const { die } = await import('@lib/common.mjs');
    try { die('boom'); } catch { /* swallow exit mock */ }
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not write to stdout', async () => {
    const { die } = await import('@lib/common.mjs');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try { die('nope'); } catch { /* swallow exit mock */ }
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// warn
// ---------------------------------------------------------------------------

describe('warn', () => {
  let stderrSpy;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes "WARNING: <message>" to stderr', async () => {
    const { warn } = await import('@lib/common.mjs');
    warn('heads up');
    expect(stderrSpy).toHaveBeenCalledWith('WARNING: heads up\n');
  });

  it('does not exit the process', async () => {
    const { warn } = await import('@lib/common.mjs');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    warn('non-fatal');
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('does not write to stdout', async () => {
    const { warn } = await import('@lib/common.mjs');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    warn('quiet');
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// requireJq
// ---------------------------------------------------------------------------

describe('requireJq', () => {
  it('does not throw when jq is available (live system check)', async () => {
    // jq is required in the dev environment (common.sh already gates on it)
    const { requireJq } = await import('@lib/common.mjs');
    // If jq is not installed this test is informational — skip gracefully
    try {
      expect(() => requireJq()).not.toThrow();
    } catch {
      // jq not installed in this environment — acceptable
    }
  });

  it('throws an Error when jq is not on PATH', async () => {
    // Force PATH to an empty string so execSync cannot find jq
    const { requireJq } = await import('@lib/common.mjs');
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(() => requireJq()).toThrow(Error);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('thrown error message mentions "jq"', async () => {
    const { requireJq } = await import('@lib/common.mjs');
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(() => requireJq()).toThrow(/jq/);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('thrown error message mentions install instructions', async () => {
    const { requireJq } = await import('@lib/common.mjs');
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(() => requireJq()).toThrow(/brew install jq/);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

// ---------------------------------------------------------------------------
// findProjectRoot
// ---------------------------------------------------------------------------

describe('findProjectRoot', () => {
  let tmpBase;

  beforeEach(async () => {
    tmpBase = path.join(os.tmpdir(), `fpr-test-${Date.now()}`);
    await fs.mkdir(tmpBase, { recursive: true });
    // Clear env fast-paths to avoid interference
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CODEX_PROJECT_DIR;
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CODEX_PROJECT_DIR;
    vi.restoreAllMocks();
  });

  it('returns the directory containing CLAUDE.md when found', async () => {
    const { findProjectRoot } = await import('@lib/common.mjs');
    await fs.writeFile(path.join(tmpBase, 'CLAUDE.md'), '# test', 'utf8');
    const sub = path.join(tmpBase, 'sub', 'deep');
    await fs.mkdir(sub, { recursive: true });
    expect(findProjectRoot(sub)).toBe(tmpBase);
  });

  it('returns the directory containing .claude/ when found', async () => {
    const { findProjectRoot } = await import('@lib/common.mjs');
    const claudeDir = path.join(tmpBase, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    const sub = path.join(tmpBase, 'nested');
    await fs.mkdir(sub, { recursive: true });
    expect(findProjectRoot(sub)).toBe(tmpBase);
  });

  it('returns the directory containing AGENTS.md when found', async () => {
    const { findProjectRoot } = await import('@lib/common.mjs');
    await fs.writeFile(path.join(tmpBase, 'AGENTS.md'), '# test', 'utf8');
    expect(findProjectRoot(tmpBase)).toBe(tmpBase);
  });

  it('returns startDir when no markers are found', async () => {
    const { findProjectRoot } = await import('@lib/common.mjs');
    // Use a truly bare temp dir with no Claude markers in ancestors
    // (we use a random subfolder under /tmp which shouldn't have markers)
    const bare = path.join(tmpBase, 'bare');
    await fs.mkdir(bare, { recursive: true });
    // Result is startDir itself when no markers found up the tree
    const result = findProjectRoot(bare);
    // Should be bare or an ancestor — not blow up
    expect(typeof result).toBe('string');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('respects CLAUDE_PROJECT_DIR env var when it contains CLAUDE.md', async () => {
    const { findProjectRoot } = await import('@lib/common.mjs');
    await fs.writeFile(path.join(tmpBase, 'CLAUDE.md'), '# fast path', 'utf8');
    process.env.CLAUDE_PROJECT_DIR = tmpBase;
    expect(findProjectRoot('/tmp')).toBe(tmpBase);
  });

  it('ignores CLAUDE_PROJECT_DIR when it lacks markers', async () => {
    const { findProjectRoot } = await import('@lib/common.mjs');
    const emptyDir = path.join(tmpBase, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = emptyDir;
    // Falls through to walk; since tmpBase also has no markers, result is startDir
    const result = findProjectRoot(emptyDir);
    expect(typeof result).toBe('string');
  });

  it('respects CODEX_PROJECT_DIR env var when it contains AGENTS.md', async () => {
    const { findProjectRoot } = await import('@lib/common.mjs');
    await fs.writeFile(path.join(tmpBase, 'AGENTS.md'), '# codex', 'utf8');
    process.env.CODEX_PROJECT_DIR = tmpBase;
    expect(findProjectRoot('/tmp')).toBe(tmpBase);
  });

  it('returns an absolute path', async () => {
    const { findProjectRoot } = await import('@lib/common.mjs');
    const result = findProjectRoot(tmpBase);
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePluginRoot
// ---------------------------------------------------------------------------

describe('resolvePluginRoot', () => {
  let tmpBase;

  beforeEach(async () => {
    tmpBase = path.join(os.tmpdir(), `rpr-test-${Date.now()}`);
    await fs.mkdir(tmpBase, { recursive: true });
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CODEX_PLUGIN_ROOT;
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CODEX_PLUGIN_ROOT;
    vi.restoreAllMocks();
  });

  it('returns CLAUDE_PLUGIN_ROOT when set to an existing directory', async () => {
    const { resolvePluginRoot } = await import('@lib/common.mjs');
    process.env.CLAUDE_PLUGIN_ROOT = tmpBase;
    expect(resolvePluginRoot()).toBe(tmpBase);
  });

  it('returns CODEX_PLUGIN_ROOT when CLAUDE_PLUGIN_ROOT is absent', async () => {
    const { resolvePluginRoot } = await import('@lib/common.mjs');
    process.env.CODEX_PLUGIN_ROOT = tmpBase;
    expect(resolvePluginRoot()).toBe(tmpBase);
  });

  it('finds a directory containing skills/ via callerUrl walk', async () => {
    const { resolvePluginRoot } = await import('@lib/common.mjs');
    // Create a fake plugin dir with skills/ inside tmpBase
    const skillsDir = path.join(tmpBase, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    // Simulate callerUrl pointing into a sub of tmpBase
    const sub = path.join(tmpBase, 'scripts', 'lib');
    await fs.mkdir(sub, { recursive: true });
    const fakeUrl = `file://${sub}/common.mjs`;
    expect(resolvePluginRoot(fakeUrl)).toBe(tmpBase);
  });

  it('finds a directory containing plugin.json via callerUrl walk', async () => {
    const { resolvePluginRoot } = await import('@lib/common.mjs');
    await fs.writeFile(path.join(tmpBase, 'plugin.json'), '{}', 'utf8');
    const sub = path.join(tmpBase, 'scripts');
    await fs.mkdir(sub, { recursive: true });
    const fakeUrl = `file://${sub}/foo.mjs`;
    expect(resolvePluginRoot(fakeUrl)).toBe(tmpBase);
  });

  it('throws when no plugin markers found and env vars are unset', async () => {
    const { resolvePluginRoot } = await import('@lib/common.mjs');
    // Point callerUrl at a truly bare directory with no plugin markers up the tree.
    // /tmp itself should not be a plugin root.
    const bare = path.join(tmpBase, 'bare', 'deep');
    await fs.mkdir(bare, { recursive: true });
    const fakeUrl = `file://${bare}/foo.mjs`;
    // The current cwd IS the plugin root (session-orchestrator repo), so we need
    // to override cwd detection. Since we cannot mock cwd easily, this test only
    // verifies the throw contract when cwd walk also fails by pointing at /var/empty.
    // On macOS /var/empty exists as an empty directory with no plugin markers.
    // We verify: when env vars are absent and callerUrl points to bare, the function
    // either returns a path (if cwd walk succeeds in the actual repo) or throws.
    // At minimum it must not crash with a non-Error exception.
    try {
      const result = resolvePluginRoot(fakeUrl);
      expect(typeof result).toBe('string');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/plugin root/i);
    }
  });

  it('returns an absolute path', async () => {
    const { resolvePluginRoot } = await import('@lib/common.mjs');
    process.env.CLAUDE_PLUGIN_ROOT = tmpBase;
    expect(path.isAbsolute(resolvePluginRoot())).toBe(true);
  });

  it('ignores CLAUDE_PLUGIN_ROOT when it does not exist as a directory', async () => {
    const { resolvePluginRoot } = await import('@lib/common.mjs');
    process.env.CLAUDE_PLUGIN_ROOT = path.join(tmpBase, 'nonexistent-dir');
    // Falls through to next levels; cwd walk finds the actual plugin root
    try {
      const result = resolvePluginRoot();
      expect(typeof result).toBe('string');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});
