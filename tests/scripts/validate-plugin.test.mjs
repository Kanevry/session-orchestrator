/**
 * tests/scripts/validate-plugin.test.mjs
 *
 * Vitest suite for scripts/validate-plugin.mjs (issue #218).
 *
 * The script is a pass-through orchestrator that shells out to check-*.sh
 * sub-scripts in scripts/lib/validate/. Tests verify: exit codes, output
 * shape, and basic failure modes. All tests are hermetic — no network, no
 * git server dependency beyond the local repo.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../scripts/validate-plugin.mjs');
const CHECK_CODEX_PLUGIN = resolve(__dirname, '../../scripts/lib/validate/check-codex-plugin.mjs');
const REPO_ROOT = resolve(__dirname, '../../');

/**
 * Run scripts/validate-plugin.mjs with the given argument list.
 *
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function run(args = []) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Happy path — current repo plugin
// ---------------------------------------------------------------------------

describe('validate-plugin.mjs — current repo plugin', () => {
  it('exits 0 when run against the current repo plugin', () => {
    const r = run([REPO_ROOT]);
    expect(r.status).toBe(0);
  });

  it('reports "Results:" summary line on stdout', () => {
    const r = run([REPO_ROOT]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Results:');
  });

  it('reports at least 18 passed checks', () => {
    const r = run([REPO_ROOT]);
    expect(r.status).toBe(0);
    // "Results: 19 passed, 0 failed" — extract the number
    const match = r.stdout.match(/Results:\s+(\d+)\s+passed/);
    expect(match).not.toBeNull();
    const passedCount = parseInt(match[1], 10);
    expect(passedCount).toBeGreaterThanOrEqual(18);
  });

  it('reports 0 failed checks', () => {
    const r = run([REPO_ROOT]);
    expect(r.status).toBe(0);
    const match = r.stdout.match(/(\d+)\s+failed/);
    expect(match).not.toBeNull();
    const failedCount = parseInt(match[1], 10);
    expect(failedCount).toBe(0);
  });

  it('passes check-plugin-json gate (plugin.json exists and valid)', () => {
    const r = run([REPO_ROOT]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS: plugin.json exists');
    expect(r.stdout).toContain('PASS: plugin.json is valid JSON');
  });

  it('output includes PASS lines for agent frontmatter', () => {
    const r = run([REPO_ROOT]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    // At least one agent frontmatter pass line
    expect(r.stdout).toMatch(/PASS:.*\.md:.*frontmatter/);
  });

  it('emits a closing separator line (=== block)', () => {
    const r = run([REPO_ROOT]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('===========================================');
  });
});

// ---------------------------------------------------------------------------
// Plugin root argument — missing plugin.json → exit 1
// ---------------------------------------------------------------------------

describe('validate-plugin.mjs — missing plugin.json', () => {
  it('exits 1 when plugin-root directory has no .claude-plugin/plugin.json', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-missing-'));
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports a FAIL line about plugin.json not found', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-missing-'));
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('FAIL: plugin.json not found');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('still emits a Results: summary even on early-abort failure', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-missing-'));
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('Results:');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid plugin.json — missing required 'name' field → exit 1
// ---------------------------------------------------------------------------

describe('validate-plugin.mjs — invalid plugin.json', () => {
  it('exits 1 when plugin.json is missing the required name field', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-bad-'));
    const pluginDir = join(tmpDir, '.claude-plugin');
    mkdirSync(pluginDir, { recursive: true });
    // Valid JSON but missing the required 'name' field
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ version: '1.0.0', description: 'no name here' }),
    );
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports FAIL for missing name field in plugin.json', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-bad-'));
    const pluginDir = join(tmpDir, '.claude-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ version: '1.0.0', description: 'no name here' }),
    );
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('FAIL:');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when plugin.json contains invalid JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-badjson-'));
    const pluginDir = join(tmpDir, '.claude-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), '{ not valid json }');
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when plugin.json has a non-kebab-case name', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-badname-'));
    const pluginDir = join(tmpDir, '.claude-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'My Plugin Name!', version: '1.0.0' }),
    );
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('FAIL:');
      expect(r.stdout).toContain('kebab-case');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Nonexistent plugin root
// ---------------------------------------------------------------------------

describe('validate-plugin.mjs — nonexistent plugin root', () => {
  it('exits 1 when the plugin-root path does not exist', () => {
    const r = run(['/nonexistent/path/to/plugin']);
    expect(r.status).toBe(1);
  });

  it('reports FAIL: plugin.json not found for a nonexistent root', () => {
    const r = run(['/nonexistent/path/to/plugin']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL: plugin.json not found');
  });
});

// ---------------------------------------------------------------------------
// check-codex-plugin.mjs — composerIcon check (R6)
// ---------------------------------------------------------------------------

/**
 * Run check-codex-plugin.mjs directly against a given plugin root.
 * @param {string} pluginRoot
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runComposerIconCheck(pluginRoot) {
  return spawnSync('node', [CHECK_CODEX_PLUGIN, pluginRoot], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 10_000,
  });
}

describe('check-codex-plugin.mjs — composerIcon passes on real repo', () => {
  it('exits 0 against the current repo (icon file exists and is valid SVG)', () => {
    const r = runComposerIconCheck(REPO_ROOT);
    expect(r.status).toBe(0);
  });

  it('emits PASS for composerIcon field present', () => {
    const r = runComposerIconCheck(REPO_ROOT);
    expect(r.stdout).toContain('PASS: interface.composerIcon field is present');
  });

  it('emits PASS for composerIcon file exists', () => {
    const r = runComposerIconCheck(REPO_ROOT);
    expect(r.stdout).toContain('PASS: composerIcon file exists at');
  });

  it('emits PASS for valid XML/SVG root', () => {
    const r = runComposerIconCheck(REPO_ROOT);
    expect(r.stdout).toContain('PASS: composerIcon file is valid XML/SVG');
  });

  it('reports 3 passed, 0 failed', () => {
    const r = runComposerIconCheck(REPO_ROOT);
    expect(r.stdout).toContain('3 passed, 0 failed');
  });
});

describe('check-codex-plugin.mjs — composerIcon field missing', () => {
  it('exits 1 when interface.composerIcon field is absent', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-no-icon-'));
    const codexPluginDir = join(tmpDir, '.codex-plugin');
    mkdirSync(codexPluginDir, { recursive: true });
    writeFileSync(
      join(codexPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', interface: { displayName: 'Test' } }),
    );
    try {
      const r = runComposerIconCheck(tmpDir);
      expect(r.status).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports FAIL with "field not set" message when composerIcon is absent', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-no-icon-'));
    const codexPluginDir = join(tmpDir, '.codex-plugin');
    mkdirSync(codexPluginDir, { recursive: true });
    writeFileSync(
      join(codexPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', interface: { displayName: 'Test' } }),
    );
    try {
      const r = runComposerIconCheck(tmpDir);
      expect(r.stdout).toContain('interface.composerIcon field not set');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('check-codex-plugin.mjs — composerIcon file does not exist', () => {
  it('exits 1 when composerIcon references a nonexistent file', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-missing-icon-'));
    const codexPluginDir = join(tmpDir, '.codex-plugin');
    mkdirSync(codexPluginDir, { recursive: true });
    writeFileSync(
      join(codexPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', interface: { composerIcon: './assets/nonexistent.svg' } }),
    );
    try {
      const r = runComposerIconCheck(tmpDir);
      expect(r.status).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports FAIL with "does not exist" when composerIcon path is missing', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-missing-icon-'));
    const codexPluginDir = join(tmpDir, '.codex-plugin');
    mkdirSync(codexPluginDir, { recursive: true });
    writeFileSync(
      join(codexPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', interface: { composerIcon: './assets/nonexistent.svg' } }),
    );
    try {
      const r = runComposerIconCheck(tmpDir);
      expect(r.stdout).toContain('does not exist');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('check-codex-plugin.mjs — composerIcon file is not valid XML/SVG', () => {
  it('exits 1 when composerIcon file does not start with <?xml or <svg', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-bad-svg-'));
    const codexPluginDir = join(tmpDir, '.codex-plugin');
    const assetsDir = join(tmpDir, 'assets');
    mkdirSync(codexPluginDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(codexPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', interface: { composerIcon: './assets/icon.svg' } }),
    );
    writeFileSync(join(assetsDir, 'icon.svg'), 'not xml content here');
    try {
      const r = runComposerIconCheck(tmpDir);
      expect(r.status).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports FAIL with "does not start with" when file is not valid XML/SVG', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-bad-svg-'));
    const codexPluginDir = join(tmpDir, '.codex-plugin');
    const assetsDir = join(tmpDir, 'assets');
    mkdirSync(codexPluginDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(codexPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', interface: { composerIcon: './assets/icon.svg' } }),
    );
    writeFileSync(join(assetsDir, 'icon.svg'), 'not xml content here');
    try {
      const r = runComposerIconCheck(tmpDir);
      expect(r.stdout).toContain('does not start with <?xml or <svg root');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits 0 when composerIcon file starts with <?xml declaration', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-xml-decl-'));
    const codexPluginDir = join(tmpDir, '.codex-plugin');
    const assetsDir = join(tmpDir, 'assets');
    mkdirSync(codexPluginDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(codexPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', interface: { composerIcon: './assets/icon.svg' } }),
    );
    writeFileSync(join(assetsDir, 'icon.svg'), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    try {
      const r = runComposerIconCheck(tmpDir);
      expect(r.status).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
