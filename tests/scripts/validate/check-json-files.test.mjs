/**
 * tests/scripts/validate/check-json-files.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-json-files.mjs.
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
  '../../../scripts/lib/validate/check-json-files.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-json-files-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Smoke — current repo
// ---------------------------------------------------------------------------

describe('check-json-files.mjs — smoke against current repo', () => {
  it('exits 0 against the current plugin repo', () => {
    const r = run(PLUGIN_REPO);
    expect(r.status).toBe(0);
  });

  it('emits 2 PASS lines (hooks + mcpServers)', () => {
    const r = run(PLUGIN_REPO);
    expect(r.stdout).toContain('  PASS: hooks file is valid JSON');
    expect(r.stdout).toContain('  PASS: mcpServers file is valid JSON');
  });

  it('reports "Results: 2 passed, 0 failed"', () => {
    const r = run(PLUGIN_REPO);
    expect(r.stdout).toContain('Results: 2 passed, 0 failed');
  });
});

// ---------------------------------------------------------------------------
// Missing plugin-root argument
// ---------------------------------------------------------------------------

describe('check-json-files.mjs — missing argument', () => {
  it('exits 1 when no plugin-root arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(1);
  });

  it('writes usage message to stderr when no arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.stderr).toContain('Usage: check-json-files.mjs <plugin-root>');
  });
});

// ---------------------------------------------------------------------------
// Invalid JSON in hooks file (auto-discovered path)
// ---------------------------------------------------------------------------

describe('check-json-files.mjs — invalid hooks JSON', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when auto-discovered hooks.json contains invalid JSON', () => {
    dir = makeFixture();
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({}));
    mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{ not valid json }');
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line when hooks.json is not valid JSON', () => {
    dir = makeFixture();
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({}));
    mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{ not valid json }');
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: hooks file is not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// No hooks file present → skip (PASS)
// ---------------------------------------------------------------------------

describe('check-json-files.mjs — no hooks file at conventional location', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 and emits PASS skip when no hooks.json at conventional location', () => {
    dir = makeFixture();
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({}));
    // No hooks/ directory or hooks.json created
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('  PASS: hooks is not a JSON file or not specified (skipped)');
  });
});
