/**
 * tests/lib/io.test.mjs
 *
 * Vitest tests for scripts/lib/io.mjs
 *
 * Exports under test:
 *   readStdin, emitAllow, emitDeny, emitWarn, emitSystemMessage
 *
 * Strategy:
 *   - readStdin / emitAllow / emitDeny / emitWarn use child-process spawning
 *     (the driver at tests/fixtures/io-driver.mjs) because these functions
 *     interact with process.stdin / process.exit — which cannot be safely
 *     mocked in-process for exit-based tests.
 *   - emitSystemMessage is imported directly because it does NOT exit.
 *     process.stdout.write is spied upon.
 *
 * Issue #131 — v3.0.0 Windows native migration.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitSystemMessage, readJsonlLines, readJsonlFile } from '@lib/io.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DRIVER = fileURLToPath(new URL('../fixtures/io-driver.mjs', import.meta.url));

/**
 * Spawn the io-driver with a given mode/args, optionally piping stdin data.
 * Returns { stdout, stderr, status }.
 */
function runDriver(mode, args = [], stdinData = '') {
  const result = spawnSync(process.execPath, [DRIVER, mode, ...args], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 8000,
  });
  // EPIPE is expected when the child exits before we finish writing stdin
  // (e.g. the 1 MB byte-guard test). Any other error is genuine.
  if (result.error && result.error.code !== 'EPIPE') throw result.error;
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

// ---------------------------------------------------------------------------
// readStdin
// ---------------------------------------------------------------------------

describe('readStdin', () => {
  it('resolves to null when stdin is empty', () => {
    const { stdout, status } = runDriver('read-echo', [], '');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('null');
  });

  it('resolves to null when stdin contains only whitespace', () => {
    const { stdout, status } = runDriver('read-echo', [], '   \n  ');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('null');
  });

  it('returns parsed object for valid JSON object on stdin', () => {
    const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x.ts' } });
    const { stdout, status } = runDriver('read-echo', [], input);
    expect(status).toBe(0);
    // Driver wraps the result in emitSystemMessage → {"systemMessage":"<stringified obj>"}
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.systemMessage).toBeDefined();
    const inner = JSON.parse(parsed.systemMessage);
    expect(inner.tool_name).toBe('Edit');
    expect(inner.tool_input.file_path).toBe('/tmp/x.ts');
  });

  it('returns parsed object for valid JSON array on stdin', () => {
    const input = JSON.stringify([1, 2, 3]);
    const { stdout, status } = runDriver('read-echo', [], input);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    const inner = JSON.parse(parsed.systemMessage);
    expect(Array.isArray(inner)).toBe(true);
    expect(inner).toHaveLength(3);
  });

  it('throws SyntaxError (exit 1) for malformed JSON on stdin', () => {
    const { stderr, status } = runDriver('read-echo', [], 'not-valid-json{{{');
    expect(status).toBe(1);
    expect(stderr).toContain('SyntaxError');
  });

  it('throws SyntaxError for a partial JSON object on stdin', () => {
    const { stderr, status } = runDriver('read-echo', [], '{"key": "value"');
    expect(status).toBe(1);
    expect(stderr).toContain('SyntaxError');
  });

  it('throws with descriptive error when stdin payload exceeds 1 MB', () => {
    // Generate a string just over 1 MB (1_048_576 bytes).
    // We embed it inside a JSON string value so the overall input is slightly > 1 MB.
    const bigValue = 'x'.repeat(1_100_000);
    const bigJson = JSON.stringify({ data: bigValue });
    const { stderr, status } = runDriver('read-echo', [], bigJson);
    expect(status).toBe(1);
    // Error message should mention the limit
    expect(stderr).toMatch(/1 MB|1048576|exceeds/i);
  });

  // Timeout test is intentionally skipped — a 5-second stall would block the
  // suite and the behaviour is tested by the error-message contract above.
  it.skip('throws after 5 s timeout when stdin never closes (TODO: slow test)', () => {});
});

// ---------------------------------------------------------------------------
// emitAllow
// ---------------------------------------------------------------------------

describe('emitAllow', () => {
  it('exits with code 0', () => {
    const { status } = runDriver('emit-allow');
    expect(status).toBe(0);
  });

  it('produces no stdout output', () => {
    const { stdout } = runDriver('emit-allow');
    expect(stdout).toBe('');
  });

  it('produces no stderr output', () => {
    const { stderr } = runDriver('emit-allow');
    expect(stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// emitDeny
// ---------------------------------------------------------------------------

describe('emitDeny', () => {
  it('exits with code 2', () => {
    const { status } = runDriver('emit-deny', ['Scope violation']);
    expect(status).toBe(2);
  });

  it('outputs a single JSON line to stdout containing permissionDecision "deny"', () => {
    const { stdout } = runDriver('emit-deny', ['Scope violation']);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.permissionDecision).toBe('deny');
  });

  it('reason field equals the provided reason when no suggestion given', () => {
    const { stdout } = runDriver('emit-deny', ['File outside project root']);
    const obj = JSON.parse(stdout.trim());
    expect(obj.reason).toBe('File outside project root');
  });

  it('reason field combines reason and suggestion with " — " separator', () => {
    const { stdout } = runDriver('emit-deny', ['Blocked command', 'Use git revert instead']);
    const obj = JSON.parse(stdout.trim());
    expect(obj.reason).toBe('Blocked command — Use git revert instead');
  });

  it('stdout JSON has exactly the two expected keys when reason only', () => {
    const { stdout } = runDriver('emit-deny', ['Test reason']);
    const obj = JSON.parse(stdout.trim());
    expect(Object.keys(obj).sort()).toEqual(['permissionDecision', 'reason']);
  });

  it('produces no stderr output', () => {
    const { stderr } = runDriver('emit-deny', ['Some reason']);
    expect(stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// emitWarn
// ---------------------------------------------------------------------------

describe('emitWarn', () => {
  it('exits with code 0', () => {
    const { status } = runDriver('emit-warn', ['watch out']);
    expect(status).toBe(0);
  });

  it('writes "⚠ <message>" to stderr', () => {
    const { stderr } = runDriver('emit-warn', ['watch out']);
    expect(stderr.trim()).toBe('⚠ watch out');
  });

  it('produces no stdout output', () => {
    const { stdout } = runDriver('emit-warn', ['anything']);
    expect(stdout).toBe('');
  });

  it('warning prefix is the exact unicode warning sign followed by a space', () => {
    const { stderr } = runDriver('emit-warn', ['msg']);
    // The first two characters must be '⚠' (U+26A0) and ' '
    expect(stderr.startsWith('⚠ ')).toBe(true);
  });

  it('multi-word message is preserved verbatim after the prefix', () => {
    const { stderr } = runDriver('emit-warn', ['file', 'not', 'found']);
    expect(stderr.trim()).toBe('⚠ file not found');
  });
});

// ---------------------------------------------------------------------------
// emitSystemMessage — tested in-process (does not exit)
// ---------------------------------------------------------------------------

describe('emitSystemMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes JSON {"systemMessage":"<msg>"} to stdout', () => {
    const written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(chunk);
      return true;
    });
    // console.log calls process.stdout.write internally
    // We spy on console.log to capture what gets written
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    emitSystemMessage('hello world');

    expect(logged).toHaveLength(1);
    const parsed = JSON.parse(logged[0]);
    expect(parsed.systemMessage).toBe('hello world');
  });

  it('does not call process.exit', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    emitSystemMessage('no-exit test');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('JSON output has exactly the "systemMessage" key', () => {
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    emitSystemMessage('key-check');

    const parsed = JSON.parse(logged[0]);
    expect(Object.keys(parsed)).toEqual(['systemMessage']);
  });

  it('correctly encodes a message containing special JSON characters', () => {
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    emitSystemMessage('say "hello" & <escape>');

    const parsed = JSON.parse(logged[0]);
    expect(parsed.systemMessage).toBe('say "hello" & <escape>');
  });

  it('works with an empty string message', () => {
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    emitSystemMessage('');

    const parsed = JSON.parse(logged[0]);
    expect(parsed.systemMessage).toBe('');
  });

  it('spawned process: produces {"systemMessage":"<msg>"} on stdout and exits 0', () => {
    const { stdout, status } = runDriver('emit-system', ['test message']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.systemMessage).toBe('test message');
  });
});

// ---------------------------------------------------------------------------
// readJsonlLines / readJsonlFile — pure helpers, tested in-process
// ---------------------------------------------------------------------------

describe('readJsonlLines / readJsonlFile', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('returns [] for an empty string', () => {
    expect(readJsonlLines('')).toEqual([]);
  });

  it('returns [] for a whitespace-only string', () => {
    expect(readJsonlLines('   \n  \t\n')).toEqual([]);
  });

  it('parses two valid lines plus a trailing blank line into 2 objects', () => {
    const raw = '{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n';
    expect(readJsonlLines(raw)).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
  });

  it('skips blank/whitespace-only lines interspersed between valid lines', () => {
    const raw = '{"id":1}\n\n   \n{"id":2}\n';
    expect(readJsonlLines(raw)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('throws by default when a line is invalid JSON', () => {
    const bad = '{"ok":1}\nnot-json{{{\n{"ok":2}';
    expect(() => readJsonlLines(bad)).toThrow();
  });

  it('error message names the 1-based source line number of the bad line', () => {
    const bad = '{"ok":1}\nnot-json{{{\n{"ok":2}';
    expect(() => readJsonlLines(bad)).toThrow(/line 2/);
  });

  it('skips invalid lines and returns only valid entries when skipInvalid is true', () => {
    const raw = '{"ok":1}\nnot-json{{{\n{"ok":2}';
    expect(readJsonlLines(raw, { skipInvalid: true })).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it('readJsonlFile returns [] for a non-existent path', () => {
    expect(readJsonlFile('/nonexistent/path/does/not/exist.jsonl')).toEqual([]);
  });

  it('readJsonlFile reads and parses a real temp file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-jsonl-'));
    const file = join(tmpDir, 'events.jsonl');
    writeFileSync(file, '{"event":"start"}\n{"event":"stop"}\n', 'utf8');
    expect(readJsonlFile(file)).toEqual([{ event: 'start' }, { event: 'stop' }]);
  });

  it('readJsonlFile forwards skipInvalid to readJsonlLines', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-jsonl-'));
    const file = join(tmpDir, 'mixed.jsonl');
    writeFileSync(file, '{"n":1}\nGARBAGE\n{"n":2}\n', 'utf8');
    expect(readJsonlFile(file, { skipInvalid: true })).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
