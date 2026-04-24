/**
 * tests/scripts/emit-session.test.mjs
 *
 * Vitest suite for scripts/emit-session.mjs — the validating writer for
 * session JSONL entries (Issue #249 follow-up). Exercises the CLI via
 * child_process so exit codes and stdout/stderr contracts are verified
 * end-to-end, not just the library surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'emit-session.mjs');

function validEntry(overrides = {}) {
  return {
    session_id: 'main-2026-04-24-1600',
    session_type: 'deep',
    started_at: '2026-04-24T16:00:00Z',
    completed_at: '2026-04-24T16:30:00Z',
    total_waves: 5,
    waves: [{ wave: 1, role: 'Discovery' }],
    agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 },
    total_agents: 3,
    total_files_changed: 2,
    ...overrides,
  };
}

function runCli(args, stdin = null) {
  const input = stdin ?? undefined;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('emit-session.mjs CLI', () => {
  let tmp;
  let targetFile;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'emit-session-'));
    targetFile = join(tmp, 'sessions.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('appends a valid entry and exits 0', () => {
    const entry = validEntry();
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const contents = readFileSync(targetFile, 'utf8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.session_id).toBe(entry.session_id);
    expect(parsed.schema_version).toBe(1);
  });

  it('stamps schema_version:1 on entries that omit it', () => {
    const entry = validEntry();
    delete entry.schema_version;
    runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    const parsed = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(parsed.schema_version).toBe(1);
  });

  it('emits a summary JSON line on stdout', () => {
    const entry = validEntry();
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    const summary = JSON.parse(r.stdout.trim());
    expect(summary.action).toBe('appended');
    expect(summary.session_id).toBe(entry.session_id);
    expect(summary.schema_version).toBe(1);
    expect(summary.path).toBe(targetFile);
  });

  it('exits 1 on validation error and does NOT touch the file', () => {
    const entry = validEntry({ session_type: 'bogus' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/validation failed.*session_type/);
    expect(existsSync(targetFile)).toBe(false);
  });

  it('exits 1 on missing required field', () => {
    const entry = validEntry();
    delete entry.session_id;
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/session_id/);
    expect(existsSync(targetFile)).toBe(false);
  });

  it('exits 2 on non-JSON input', () => {
    const r = runCli(['--file', targetFile, '--entry', 'not-json{']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not valid JSON/);
  });

  it('exits 2 on empty stdin and no --entry', () => {
    const r = runCli(['--file', targetFile], '');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no entry provided/);
  });

  it('reads from stdin when --entry is omitted', () => {
    const entry = validEntry();
    const r = runCli(['--file', targetFile], JSON.stringify(entry));
    expect(r.status).toBe(0);
    const lines = readFileSync(targetFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).session_id).toBe(entry.session_id);
  });

  it('exits 2 on unknown argument', () => {
    const r = runCli(['--bogus', 'x'], JSON.stringify(validEntry()));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown argument/);
  });

  it('appends multiple invocations atomically (line-per-call)', () => {
    runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry({ session_id: 'a' }))]);
    runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry({ session_id: 'b' }))]);
    runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry({ session_id: 'c' }))]);
    const lines = readFileSync(targetFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).session_id).toBe('a');
    expect(JSON.parse(lines[1]).session_id).toBe('b');
    expect(JSON.parse(lines[2]).session_id).toBe('c');
  });

  it('creates parent directories if missing', () => {
    const deep = join(tmp, 'deep', 'nested', 'sessions.jsonl');
    const r = runCli(['--file', deep, '--entry', JSON.stringify(validEntry())]);
    expect(r.status).toBe(0);
    expect(existsSync(deep)).toBe(true);
    expect(statSync(deep).size).toBeGreaterThan(0);
  });

  it('--help exits 0 with usage text', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: node scripts\/emit-session\.mjs/);
  });
});
