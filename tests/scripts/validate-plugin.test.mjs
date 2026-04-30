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
