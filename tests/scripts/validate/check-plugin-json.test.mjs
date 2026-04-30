/**
 * tests/scripts/validate/check-plugin-json.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-plugin-json.mjs.
 * Spawns the script as a child process and verifies exit codes + output shape.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/validate/check-plugin-json.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-plugin-json-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Smoke — current repo
// ---------------------------------------------------------------------------

describe('check-plugin-json.mjs — smoke against current repo', () => {
  it('exits 0 against the current plugin repo', () => {
    const r = run(PLUGIN_REPO);
    expect(r.status).toBe(0);
  });

  it('reports "Results: N passed, 0 failed" on stdout', () => {
    const r = run(PLUGIN_REPO);
    const match = r.stdout.match(/Results:\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
    expect(match).not.toBeNull();
    expect(parseInt(match[2], 10)).toBe(0);
  });

  it('emits PASS for plugin.json exists and valid JSON', () => {
    const r = run(PLUGIN_REPO);
    expect(r.stdout).toContain('  PASS: plugin.json exists');
    expect(r.stdout).toContain('  PASS: plugin.json is valid JSON');
  });
});

// ---------------------------------------------------------------------------
// Missing plugin-root argument
// ---------------------------------------------------------------------------

describe('check-plugin-json.mjs — missing argument', () => {
  it('exits 1 when no plugin-root arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(1);
  });

  it('writes usage message to stderr when no arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.stderr).toContain('Usage: check-plugin-json.mjs <plugin-root>');
  });
});

// ---------------------------------------------------------------------------
// Missing plugin.json
// ---------------------------------------------------------------------------

describe('check-plugin-json.mjs — missing plugin.json', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when plugin.json is absent', () => {
    dir = makeFixture(); // .claude-plugin dir exists but no plugin.json inside
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning "plugin.json not found"', () => {
    dir = makeFixture();
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: plugin.json not found');
  });

  it('still emits a Results: summary line when plugin.json is absent', () => {
    dir = makeFixture();
    const r = run(dir);
    expect(r.stdout).toContain('Results:');
  });
});

// ---------------------------------------------------------------------------
// Invalid JSON
// ---------------------------------------------------------------------------

describe('check-plugin-json.mjs — invalid JSON', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when plugin.json contains invalid JSON', () => {
    dir = makeFixture();
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{ not valid json }');
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning "not valid JSON"', () => {
    dir = makeFixture();
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{ not valid json }');
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: plugin.json is not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// Missing required 'name' field
// ---------------------------------------------------------------------------

describe('check-plugin-json.mjs — missing name field', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when name field is absent', () => {
    dir = makeFixture();
    writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ version: '1.0.0', description: 'no name' }),
    );
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning missing name field', () => {
    dir = makeFixture();
    writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ version: '1.0.0', description: 'no name' }),
    );
    const r = run(dir);
    expect(r.stdout).toContain("  FAIL: required field 'name' is missing");
  });
});

// ---------------------------------------------------------------------------
// Invalid kebab-case name
// ---------------------------------------------------------------------------

describe('check-plugin-json.mjs — invalid kebab-case name', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when name is not kebab-case (Foo_Bar)', () => {
    dir = makeFixture();
    writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'Foo_Bar', version: '1.0.0' }),
    );
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning kebab-case when name is invalid', () => {
    dir = makeFixture();
    writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'Foo_Bar', version: '1.0.0' }),
    );
    const r = run(dir);
    expect(r.stdout).toContain('kebab-case');
    expect(r.stdout).toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Invalid semver version
// ---------------------------------------------------------------------------

describe('check-plugin-json.mjs — invalid version semver', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when version does not match semver', () => {
    dir = makeFixture();
    writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-plugin', version: 'abc' }),
    );
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line mentioning semver when version is invalid', () => {
    dir = makeFixture();
    writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-plugin', version: 'abc' }),
    );
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: version does not match semver: abc');
  });
});
