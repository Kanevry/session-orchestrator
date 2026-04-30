/**
 * tests/scripts/validate/check-commands.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-commands.mjs.
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
  '../../../scripts/lib/validate/check-commands.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-commands-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'test-plugin', version: '1.0.0' }));
  return dir;
}

// ---------------------------------------------------------------------------
// Smoke — current repo
// ---------------------------------------------------------------------------

describe('check-commands.mjs — smoke against current repo', () => {
  it('exits 0 against the current plugin repo', () => {
    const r = run(PLUGIN_REPO);
    expect(r.status).toBe(0);
  });

  it('emits PASS line confirming commands directory contains .md files', () => {
    const r = run(PLUGIN_REPO);
    expect(r.stdout).toContain('  PASS: commands directory contains');
    expect(r.stdout).toContain('.md files');
  });

  it('reports "Results: 1 passed, 0 failed"', () => {
    const r = run(PLUGIN_REPO);
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });
});

// ---------------------------------------------------------------------------
// Missing plugin-root argument
// ---------------------------------------------------------------------------

describe('check-commands.mjs — missing argument', () => {
  it('exits 1 when no plugin-root arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(1);
  });

  it('writes usage message to stderr when no arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.stderr).toContain('Usage: check-commands.mjs <plugin-root>');
  });
});

// ---------------------------------------------------------------------------
// No commands/ directory
// ---------------------------------------------------------------------------

describe('check-commands.mjs — missing commands directory', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when no commands/ directory exists', () => {
    dir = makeFixture();
    // commands/ dir not created
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line when commands/ directory is absent', () => {
    dir = makeFixture();
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: commands directory not found at conventional location: ./commands');
  });
});

// ---------------------------------------------------------------------------
// Empty commands/ directory (no .md files)
// ---------------------------------------------------------------------------

describe('check-commands.mjs — empty commands directory', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when commands/ directory has no .md files', () => {
    dir = makeFixture();
    mkdirSync(path.join(dir, 'commands'), { recursive: true });
    // No .md files placed inside
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line when commands/ directory is empty', () => {
    dir = makeFixture();
    mkdirSync(path.join(dir, 'commands'), { recursive: true });
    const r = run(dir);
    expect(r.stdout).toContain('  FAIL: commands directory is empty (no .md files)');
  });
});

// ---------------------------------------------------------------------------
// Non-.md files in commands/ do not count
// ---------------------------------------------------------------------------

describe('check-commands.mjs — commands dir with non-.md files only', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when commands/ only contains non-.md files', () => {
    dir = makeFixture();
    mkdirSync(path.join(dir, 'commands'), { recursive: true });
    writeFileSync(path.join(dir, 'commands', 'README.txt'), 'not a command file');
    writeFileSync(path.join(dir, 'commands', 'script.sh'), '#!/bin/bash');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('  FAIL: commands directory is empty (no .md files)');
  });
});

// ---------------------------------------------------------------------------
// Valid commands dir with .md files
// ---------------------------------------------------------------------------

describe('check-commands.mjs — valid commands directory fixture', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 when commands/ contains at least one .md file', () => {
    dir = makeFixture();
    mkdirSync(path.join(dir, 'commands'), { recursive: true });
    writeFileSync(path.join(dir, 'commands', 'session.md'), '# /session command\n');
    const r = run(dir);
    expect(r.status).toBe(0);
  });

  it('emits PASS line reporting the count of .md files found', () => {
    dir = makeFixture();
    mkdirSync(path.join(dir, 'commands'), { recursive: true });
    writeFileSync(path.join(dir, 'commands', 'session.md'), '# /session command\n');
    writeFileSync(path.join(dir, 'commands', 'discovery.md'), '# /discovery command\n');
    const r = run(dir);
    expect(r.stdout).toContain('  PASS: commands directory contains 2 .md files');
  });
});
