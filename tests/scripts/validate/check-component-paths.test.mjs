/**
 * tests/scripts/validate/check-component-paths.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-component-paths.mjs.
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
  '../../../scripts/lib/validate/check-component-paths.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-comp-paths-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Smoke — current repo
// ---------------------------------------------------------------------------

describe('check-component-paths.mjs — smoke against current repo', () => {
  it('exits 0 against the current plugin repo', () => {
    const r = run(PLUGIN_REPO);
    expect(r.status).toBe(0);
  });

  it('auto-discovers all 4 conventional component paths', () => {
    const r = run(PLUGIN_REPO);
    expect(r.stdout).toContain('  PASS: commands auto-discovered at: ./commands');
    expect(r.stdout).toContain('  PASS: agents auto-discovered at: ./agents');
    expect(r.stdout).toContain('  PASS: hooks auto-discovered at: ./hooks/hooks.json');
    expect(r.stdout).toContain('  PASS: mcpServers auto-discovered at: ./.mcp.json');
  });

  it('reports "Results: 4 passed, 0 failed"', () => {
    const r = run(PLUGIN_REPO);
    expect(r.stdout).toContain('Results: 4 passed, 0 failed');
  });
});

// ---------------------------------------------------------------------------
// Missing plugin-root argument
// ---------------------------------------------------------------------------

describe('check-component-paths.mjs — missing argument', () => {
  it('exits 1 when no plugin-root arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(1);
  });

  it('writes usage message to stderr when no arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.stderr).toContain('Usage: check-component-paths.mjs <plugin-root>');
  });
});

// ---------------------------------------------------------------------------
// Empty plugin.json — no path fields → auto-discovery used
// ---------------------------------------------------------------------------

describe('check-component-paths.mjs — empty plugin.json (no path fields)', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('PASSes commands auto-discovery when commands/ dir is present', () => {
    dir = makeFixture();
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({}));
    mkdirSync(path.join(dir, 'commands'), { recursive: true });
    const r = run(dir);
    expect(r.stdout).toContain('  PASS: commands auto-discovered at: ./commands');
  });

  it('FAILs commands when commands/ dir is absent and no explicit path', () => {
    dir = makeFixture();
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({}));
    // No commands/ directory created
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('  FAIL: commands not found at conventional location: ./commands');
  });
});

// ---------------------------------------------------------------------------
// Explicit path that does not exist → FAIL
// ---------------------------------------------------------------------------

describe('check-component-paths.mjs — configured path missing', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when explicit commands path does not exist on disk', () => {
    dir = makeFixture();
    writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ commands: './my-commands' }),
    );
    // my-commands directory NOT created
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line when explicit path does not exist', () => {
    dir = makeFixture();
    writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ commands: './my-commands' }),
    );
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: commands path does not exist: ./my-commands');
  });
});
