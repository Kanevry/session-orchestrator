/**
 * tests/scripts/emit-event.test.mjs
 *
 * Behavioural tests for the scripts/emit-event.mjs CLI (issue #611).
 *
 * The CLI wraps emitEvent(); these tests invoke it as a REAL subprocess so the
 * exit-code contract (0 success / 1 user-input / 2 system — per
 * .claude/rules/cli-design.md) is exercised exactly as a shell caller sees it.
 *
 * Coverage:
 *   - happy path: emits an event, exit 0, record written
 *   - --file override: writes to the supplied path
 *   - --json: structured stdout result
 *   - --help: usage to stdout, exit 0
 *   - missing --type → exit 1 (user/input error)
 *   - malformed --payload JSON → exit 1
 *   - non-object --payload (JSON array) → exit 1
 *   - write failure (parent of --file is a regular file) → exit 2 (system error)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'scripts', 'emit-event.mjs');

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'emit-event-cli-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run the CLI and capture { status, stdout, stderr }. execFileSync throws on a
 * non-zero exit, so we normalise both outcomes into the same shape.
 *
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCli(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      // Keep CLANK webhook off; isolate the project dir so any default
      // resolution can't touch the real repo events.jsonl.
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir, CLANK_EVENT_SECRET: '', CLANK_EVENT_URL: '' },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 2,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
    };
  }
}

describe('emit-event.mjs CLI — happy path', () => {
  it('emits an event to --file and exits 0', () => {
    const out = join(tmpDir, 'events.jsonl');
    const res = runCli([
      '--type', 'orchestrator.grounding.injected',
      '--file', out,
      '--payload', '{"file":"src/x.ts","lines":42}',
    ]);
    expect(res.status).toBe(0);

    const record = JSON.parse(readFileSync(out, 'utf8').trim().split('\n')[0]);
    expect(record.event).toBe('orchestrator.grounding.injected');
    expect(record.file).toBe('src/x.ts');
    expect(record.lines).toBe(42);
    // emitEvent generates the timestamp — the CLI must not require it.
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it('creates parent directories recursively for a nested --file target', () => {
    const out = join(tmpDir, 'a', 'b', 'c', 'events.jsonl');
    const res = runCli([
      '--type', 'test.nested.file',
      '--file', out,
      '--payload', '{"scope":"cli","depth":3}',
    ]);
    expect(res.status).toBe(0);
    expect(existsSync(dirname(out))).toBe(true);

    const record = JSON.parse(readFileSync(out, 'utf8').trim().split('\n')[0]);
    expect(record.event).toBe('test.nested.file');
    expect(record.scope).toBe('cli');
    expect(record.depth).toBe(3);
  });

  it('defaults --payload to {} when omitted (record has only timestamp + event)', () => {
    const out = join(tmpDir, 'events.jsonl');
    const res = runCli(['--type', 'test.no.payload', '--file', out]);
    expect(res.status).toBe(0);

    const record = JSON.parse(readFileSync(out, 'utf8').trim().split('\n')[0]);
    expect(record.event).toBe('test.no.payload');
    expect(Object.keys(record).sort()).toEqual(['event', 'timestamp']);
  });

  it('--json prints a structured success object to stdout', () => {
    const out = join(tmpDir, 'events.jsonl');
    const res = runCli(['--type', 'test.json.flag', '--file', out, '--json']);
    expect(res.status).toBe(0);

    const result = JSON.parse(res.stdout.trim());
    expect(result).toEqual({ ok: true, event: 'test.json.flag', file: out });
  });
});

describe('emit-event.mjs CLI — --help', () => {
  it('prints usage to stdout and exits 0', () => {
    const res = runCli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage: emit-event.mjs');
    expect(res.stdout).toContain('--type');
  });
});

describe('emit-event.mjs CLI — user/input errors (exit 1)', () => {
  it('missing --type exits 1 with a stderr diagnostic', () => {
    const res = runCli(['--payload', '{"a":1}']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--type is required');
  });

  it('malformed --payload JSON exits 1', () => {
    const out = join(tmpDir, 'events.jsonl');
    const res = runCli(['--type', 'bad.payload', '--file', out, '--payload', 'not json']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--payload is not valid JSON');
    // Nothing should have been written on an input error.
    expect(existsSync(out)).toBe(false);
  });

  it('non-object --payload (JSON array) exits 1', () => {
    const res = runCli(['--type', 'array.payload', '--payload', '[1,2,3]']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--payload must be a JSON object');
  });

  it('--json on a user error still emits a JSON error object to stdout', () => {
    const res = runCli(['--payload', '{"a":1}', '--json']);
    expect(res.status).toBe(1);
    const result = JSON.parse(res.stdout.trim());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('--type is required');
  });
});

describe('emit-event.mjs CLI — system errors (exit 2)', () => {
  it('exits 2 when the write fails (parent of --file is a regular file → ENOTDIR)', () => {
    // Create a regular FILE, then target a path that treats it as a directory.
    // emitEvent() does mkdir(dirname(filePath)) which fails with ENOTDIR
    // because the parent segment is a file — a genuine system/IO error (exit 2).
    const regularFile = join(tmpDir, 'blocker');
    writeFileSync(regularFile, 'i am a file, not a dir', 'utf8');
    const badTarget = join(regularFile, 'events.jsonl');

    const res = runCli(['--type', 'sys.error', '--file', badTarget]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('failed to emit event');
  });
});
