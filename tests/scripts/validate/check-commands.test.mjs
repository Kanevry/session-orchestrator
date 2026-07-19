/**
 * tests/scripts/validate/check-commands.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-commands.mjs.
 * Spawns the script as a child process and verifies exit codes + output shape.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
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
  writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.0.0' }),
  );
  return dir;
}

function writeCommand(dir, filename, frontmatter) {
  mkdirSync(path.join(dir, 'commands'), { recursive: true });
  writeFileSync(path.join(dir, 'commands', filename), `---\n${frontmatter}\n---\n# Command body\n`);
}

// ---------------------------------------------------------------------------
// Smoke — current repo
// ---------------------------------------------------------------------------

describe('check-commands.mjs — smoke against current repo', () => {
  // Spawn once per describe — all three it()s use identical args (PLUGIN_REPO).
  let r;
  beforeAll(() => {
    r = run(PLUGIN_REPO);
  });

  it('exits 0 against the current plugin repo', () => {
    expect(r.status).toBe(0);
  });

  it('emits PASS line confirming commands directory contains .md files', () => {
    expect(r.stdout).toContain('  PASS: commands directory contains');
    expect(r.stdout).toContain('.md files');
  });

  it('reports "Results: 1 passed, 0 failed"', () => {
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
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when no commands/ directory exists', () => {
    dir = makeFixture();
    // commands/ dir not created
    const r = run(dir);
    expect(r.status).toBe(1);
  });

  it('emits FAIL line when commands/ directory is absent', () => {
    dir = makeFixture();
    const r = run(dir);
    expect(r.stdout).toContain(
      '  FAIL: commands directory not found at conventional location: ./commands',
    );
  });
});

// ---------------------------------------------------------------------------
// Empty commands/ directory (no .md files)
// ---------------------------------------------------------------------------

describe('check-commands.mjs — empty commands directory', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

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
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

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
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when commands/ contains at least one .md file', () => {
    dir = makeFixture();
    writeCommand(dir, 'session.md', 'description: Session command');
    const r = run(dir);
    expect(r.status).toBe(0);
  });

  it('emits PASS line reporting the count of .md files found', () => {
    dir = makeFixture();
    writeCommand(dir, 'session.md', 'description: Session command');
    writeCommand(dir, 'discovery.md', 'description: Discovery command');
    const r = run(dir);
    expect(r.stdout).toContain('  PASS: commands directory contains 2 .md files');
  });
});

// ---------------------------------------------------------------------------
// Semantic argument-hint frontmatter validation
// ---------------------------------------------------------------------------

describe('check-commands.mjs — semantic argument-hint validation', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a quoted argument-hint string', () => {
    dir = makeFixture();
    writeCommand(dir, 'quoted.md', 'description: Quoted hint\nargument-hint: "[mode: deep]"');
    const r = run(dir);
    expect(r.status).toBe(0);
  });

  it('keeps a date-like argument-hint as a string under CORE_SCHEMA', () => {
    dir = makeFixture();
    writeCommand(dir, 'core-schema.md', 'description: Date-like hint\nargument-hint: 2026-01-01');
    const r = run(dir);
    expect(r.status).toBe(0);
  });

  it('accepts an empty argument-hint string', () => {
    dir = makeFixture();
    writeCommand(dir, 'empty.md', 'description: Empty hint\nargument-hint: ""');
    const r = run(dir);
    expect(r.status).toBe(0);
  });

  it('accepts frontmatter that omits argument-hint', () => {
    dir = makeFixture();
    writeCommand(dir, 'omitted.md', 'description: Optional hint omitted');
    const r = run(dir);
    expect(r.status).toBe(0);
  });

  it('rejects a synthetic array through the real checker path (negative fake-regression)', () => {
    dir = makeFixture();
    writeCommand(dir, 'array-argument.md', 'description: Invalid array\nargument-hint: [one, two]');
    const r = run(dir);
    expect(r).toMatchObject({
      status: 1,
      stdout: expect.stringContaining('  FAIL: array-argument.md: argument-hint must be a string'),
    });
  });

  it('rejects malformed YAML with the filename and parser error', () => {
    dir = makeFixture();
    writeCommand(
      dir,
      'malformed-command.md',
      'description: Broken YAML\nargument-hint: [unterminated',
    );
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('  FAIL: malformed-command.md: invalid YAML frontmatter:');
    expect(r.stdout).toContain('unexpected end of the stream within a flow collection');
  });

  it.each([
    {
      name: 'null',
      filename: 'null-argument.md',
      frontmatter: 'description: Null hint\nargument-hint: null',
      diagnostic: '  FAIL: null-argument.md: argument-hint must be a string',
    },
    {
      name: 'object',
      filename: 'object-argument.md',
      frontmatter: 'description: Object hint\nargument-hint:\n  mode: deep',
      diagnostic: '  FAIL: object-argument.md: argument-hint must be a string',
    },
    {
      name: 'number',
      filename: 'number-argument.md',
      frontmatter: 'description: Number hint\nargument-hint: 42',
      diagnostic: '  FAIL: number-argument.md: argument-hint must be a string',
    },
    {
      name: 'boolean',
      filename: 'boolean-argument.md',
      frontmatter: 'description: Boolean hint\nargument-hint: true',
      diagnostic: '  FAIL: boolean-argument.md: argument-hint must be a string',
    },
  ])('rejects an argument-hint parsed as $name', ({ filename, frontmatter, diagnostic }) => {
    dir = makeFixture();
    writeCommand(dir, filename, frontmatter);
    const r = run(dir);
    expect(r).toMatchObject({ status: 1, stdout: expect.stringContaining(diagnostic) });
  });

  it('rejects a non-mapping frontmatter root with an actionable filename', () => {
    dir = makeFixture();
    writeCommand(dir, 'sequence-root.md', '- first\n- second');
    const r = run(dir);
    expect(r).toMatchObject({
      status: 1,
      stdout: expect.stringContaining(
        '  FAIL: sequence-root.md: YAML frontmatter must be a non-null mapping/object',
      ),
    });
  });
});
