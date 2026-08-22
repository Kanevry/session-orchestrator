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

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emitSystemMessage,
  readJsonlLines,
  readJsonlFile,
  atomicWriteWithBackup,
  writeJsonAtomicSync,
} from '@lib/io.mjs';

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
    // Oversize-envelope tests deliberately push ~200 KB through stdout; the
    // 1 MB default would turn a genuine "the writer delivered everything"
    // result into a harness-side truncation and mask the very bug under test.
    maxBuffer: 8 * 1024 * 1024,
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

// Contract under test (code.claude.com/docs/en/hooks): a PreToolUse hook signals
// EITHER via exit code alone OR via exit 0 + structured JSON — never both. Under
// `exit 2` Claude Code "ignores stdout and any JSON in it", so the pre-#906 mixed
// form (stdout JSON + exit 2) silently discarded every deny reason. These tests
// are written to go RED on a relapse into that mixed form, not merely to mirror
// the current shape.
describe('emitDeny', () => {
  it('exits 0 — exit 2 would make Claude Code discard the stdout JSON entirely', () => {
    const { status } = runDriver('emit-deny', ['Scope violation']);
    expect(status).toBe(0);
  });

  it('outputs a single JSON line carrying the decision inside hookSpecificOutput', () => {
    const { stdout } = runDriver('emit-deny', ['Scope violation']);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Scope violation',
    });
  });

  it('permissionDecisionReason equals the provided reason when no suggestion given', () => {
    const { stdout } = runDriver('emit-deny', ['File outside project root']);
    const obj = JSON.parse(stdout.trim());
    expect(obj.hookSpecificOutput.permissionDecisionReason).toBe('File outside project root');
  });

  it('permissionDecisionReason combines reason and suggestion with " — " separator', () => {
    const { stdout } = runDriver('emit-deny', ['Blocked command', 'Use git revert instead']);
    const obj = JSON.parse(stdout.trim());
    expect(obj.hookSpecificOutput.permissionDecisionReason).toBe('Blocked command — Use git revert instead');
  });

  // Exclusivity guard. The deprecated flat form (`permissionDecision` / `reason`
  // at the top level) and the top-level `decision` field used by PostToolUse/Stop
  // must never reappear here — a hook that emits both shapes is the ambiguity the
  // contract forbids.
  it('emits no top-level decision keys — only hookSpecificOutput and systemMessage', () => {
    const { stdout } = runDriver('emit-deny', ['Test reason']);
    const obj = JSON.parse(stdout.trim());
    expect(Object.keys(obj).sort()).toEqual(['hookSpecificOutput', 'systemMessage']);
    expect(obj.permissionDecision).toBeUndefined();
    expect(obj.reason).toBeUndefined();
    expect(obj.decision).toBeUndefined();
  });

  // Channel test (replaces the old "produces no stderr output"). Empty stderr on
  // its own is not the point — the point is WHERE the reason travels. Under the
  // mixed form the reason would have to reach Claude via stderr; under the
  // structured form it must reach Claude via stdout JSON and the operator via
  // systemMessage. Asserting both sides makes a relapse red on either half.
  it('routes the reason through stdout JSON, never through the exit-2/stderr channel', () => {
    const { stdout, stderr, status } = runDriver('emit-deny', ['Some reason']);
    expect(status).toBe(0);
    expect(stderr).toBe('');
    const obj = JSON.parse(stdout.trim());
    expect(obj.hookSpecificOutput.permissionDecisionReason).toBe('Some reason');
    // Operator-facing mirror — without it a human sees a blocked call with no cause.
    expect(obj.systemMessage).toBe('⛔ Some reason');
  });

  // Multi-line reasons are load-bearing: hooks/pre-bash-destructive-guard.mjs
  // emits a 4-line rationale, and scripts/lib/pi-hook-bridge.mjs parses hook
  // stdout LINE-WISE. A reason written out raw (or a formatter that split on
  // newlines) would break that parse and drop the block on the pi lane.
  it('keeps a multi-line reason on one stdout line and round-trips it intact', () => {
    const reason = [
      "Destructive command blocked: 'git reset --hard' (rule: psa-003-reset)",
      'Reason: destroys work that may belong to another session.',
      'Override: Set `allow-destructive-ops: true` in Session Config if intentional.',
    ].join('\n');
    const { stdout, status } = runDriver('emit-deny', [reason]);
    expect(status).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const obj = JSON.parse(stdout.trim());
    expect(obj.hookSpecificOutput.permissionDecisionReason).toBe(reason);
    // Operator headline stays short: first line only.
    expect(obj.systemMessage).toBe("⛔ Destructive command blocked: 'git reset --hard' (rule: psa-003-reset)");
  });
});

// ---------------------------------------------------------------------------
// emitDeny — envelope delivery under size pressure
// ---------------------------------------------------------------------------

// Regression guard for the fail-OPEN bug introduced when emitDeny moved from
// `exit 2` to `exit 0` + structured JSON. On macOS a piped stdout is
// asynchronous, so `console.log` + `process.exit(0)` drops everything past the
// 65 536-byte kernel pipe buffer. Under `exit 2` that truncation was harmless
// (the exit code blocked regardless); under `exit 0` a truncated envelope reads
// as "no structured output" and the tool call is ALLOWED.
//
// Reproduced against the real helper before the fix — stdout capped at exactly
// 65 536 bytes, JSON unparseable, no decision delivered:
//   reasonLen=1000    stdoutBytes=1337    parses=true  decision=deny
//   reasonLen=60000   stdoutBytes=60337   parses=true  decision=deny
//   reasonLen=70000   stdoutBytes=65536   parses=false decision=NONE
//   reasonLen=200000  stdoutBytes=65536   parses=false decision=NONE
//
// Directly exploitable via hooks/pre-bash-templates-first.mjs, which puts the
// full, unbounded, agent-controlled bash command into the reason.
describe('emitDeny — oversize envelope delivery', () => {
  // 60 000 was the largest size that still parsed before the fix, 70 000 the
  // first that did not, 200 000 an unambiguous overrun. Parametrized across the
  // boundary so a partial fix (one that merely moves the cliff) stays red.
  for (const reasonLen of [60_000, 70_000, 200_000]) {
    it(`delivers a parseable deny envelope for a ${reasonLen}-character reason`, () => {
      const { stdout, status } = runDriver('emit-deny-big', [String(reasonLen)]);
      expect(status).toBe(0);
      const obj = JSON.parse(stdout.trim());
      expect(obj.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  }

  it('clamps the reason to 16 000 characters and marks the cut', () => {
    const { stdout } = runDriver('emit-deny-big', ['200000']);
    const reason = JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toHaveLength(16_000);
    expect(reason).toContain('[truncated: showing 16000 of 200000 characters]');
  });

  // The other side of the clamp: a budget tightened without re-measuring would
  // mutilate a legitimate reason. 9 068 characters is the measured worst case
  // across all live call sites — hooks/enforce-scope.mjs joins the wave's
  // `allowedPaths` union into BOTH the reason and the suggestion, so a deep
  // 18-agent wave with a 144-path union lands there. It must survive intact.
  it('passes the largest legitimate reason (9 068 chars) through unclamped', () => {
    const { stdout } = runDriver('emit-deny-big', ['9068']);
    const reason = JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toBe('R'.repeat(9068));
  });

  // Defence in depth: the clamp bounds what CALLERS produce, the synchronous
  // writer bounds nothing but guarantees delivery. Exercising the writer alone
  // keeps the truncation guard alive even if a future caller routes around the
  // clamp (e.g. via opts) — and makes this test, not the clamp, the thing that
  // goes red on a relapse to console.log.
  it('writeStdoutLineSync delivers a 200 000-byte line in full before exit', () => {
    const { stdout, status } = runDriver('write-line', ['200000']);
    expect(status).toBe(0);
    expect(Buffer.byteLength(stdout, 'utf8')).toBe(200_001); // line + '\n'
  });

  // A missing reason used to throw a TypeError. In pre-bash-destructive-guard,
  // pre-bash-issue-budget, pre-bash-templates-first and config-protection that
  // throw unwinds into `main().catch(() => emitAllow())` — so the deny became an
  // ALLOW. The programmer-error signal now travels on stderr; the decision still
  // has to be deny.
  it('denies (never throws) when the reason is empty, and says so on stderr', () => {
    const { stdout, stderr, status } = runDriver('emit-deny-empty');
    expect(status).toBe(0);
    expect(JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(stderr).toContain('emitDeny called without a reason');
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

  // REPLACES 'produces no stdout output' (`expect(stdout).toBe('')`).
  //
  // What that pinned: "warn does not emit a decision envelope" — expressed as
  // absolute stdout silence, which was only ever a PROXY for it.
  // Why the new state is right: under exit 0, stderr is not surfaced at all
  // (docs/plugin-architecture-v3.md, skills/hook-development/SKILL.md), so
  // silence-on-stdout meant the warning reached nobody (#916).
  // What is pinned instead: stdout carries exactly ONE line whose ONLY key is
  // `systemMessage` — a notice with no decision. Strictly stronger than the old
  // assertion, which stayed green for the very bug it looked like it covered
  // (emitting nothing at all passes `toBe('')`).
  it('emits exactly one systemMessage-only line — a notice the harness cannot read as a block', () => {
    const { stdout } = runDriver('emit-warn', ['anything']);
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]);
    // Exclusivity guard: the absence of hookSpecificOutput/permissionDecision is
    // what keeps warn non-blocking. A regression that routed warn through
    // emitDeny would add those keys and fail here.
    expect(Object.keys(obj)).toEqual(['systemMessage']);
  });

  it('carries the warning text verbatim in the operator-visible systemMessage', () => {
    const { stdout } = runDriver('emit-warn', ['file', 'not', 'found']);
    const obj = JSON.parse(stdout.trim());
    expect(obj.systemMessage).toBe('⚠ file not found');
  });

  // 64-KiB pipe-buffer guard. macOS stdout is async on a pipe, so console.log +
  // process.exit() drops everything past 65 536 bytes. That matters more here
  // than for a lost warning: pi-hook-bridge classifies an unparseable
  // `{`-prefixed line as `malformed`, which fails CLOSED for PreToolUse — a
  // truncated notice would silently turn `enforcement: warn` into a hard block.
  it('clamps an oversized message and still delivers ONE parseable line through the pipe', () => {
    // Length, not payload: a 200 000-char argv entry exceeds Linux ARG_MAX
    // (spawnSync → E2BIG) while passing on macOS. The child builds the string.
    const { stdout, status } = runDriver('emit-warn-big', ['200000']);
    expect(status).toBe(0);
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.systemMessage).toContain('truncated: showing 16000 of 200000 characters');
    expect(obj.systemMessage.length).toBeLessThan(16_100);
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

// ---------------------------------------------------------------------------
// atomicWriteWithBackup (issue #734c)
// ---------------------------------------------------------------------------

describe('atomicWriteWithBackup', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates the target (and its parent dirs) and leaves no tmp sibling behind', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-atomic-'));
    const file = join(tmpDir, 'nested', 'deeper', 'board.md');

    const result = atomicWriteWithBackup(file, 'hello\n');

    expect(result).toEqual({ ok: true, path: file, bytes: 6, backupPath: null });
    expect(readFileSync(file, 'utf8')).toBe('hello\n');
    // The whole point of tmp+rename is that the tmp file is GONE afterwards —
    // a leaked `.tmp.<hex>` sibling would accumulate on every write.
    expect(readdirSync(join(tmpDir, 'nested', 'deeper'))).toEqual(['board.md']);
  });

  it('takes no backup on a first write, and a .bak-<stamp> snapshot on the next one', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-atomic-'));
    const file = join(tmpDir, 'store.jsonl');

    const first = atomicWriteWithBackup(file, 'v1\n', { backup: true });
    // Nothing existed to lose — a backup here would just be an empty artefact.
    expect(first.backupPath).toBeNull();

    const second = atomicWriteWithBackup(file, 'v2\n', {
      backup: true,
      now: new Date('2026-08-14T10:20:30.400Z'),
    });

    expect(second.backupPath).toBe(`${file}.bak-2026-08-14T10-20-30-400Z`);
    // The snapshot holds the PREVIOUS contents, the target holds the new ones.
    expect(readFileSync(second.backupPath, 'utf8')).toBe('v1\n');
    expect(readFileSync(file, 'utf8')).toBe('v2\n');
  });

  it('backup:false (the default) never writes a sidecar over an existing file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-atomic-'));
    const file = join(tmpDir, 'rederivable.md');
    atomicWriteWithBackup(file, 'v1\n');

    const result = atomicWriteWithBackup(file, 'v2\n');

    expect(result.backupPath).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('v2\n');
    expect(readdirSync(tmpDir)).toEqual(['rederivable.md']);
  });

  it('returns a fs-error result instead of throwing, and leaves the existing file intact', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-atomic-'));
    const file = join(tmpDir, 'survivor.md');
    atomicWriteWithBackup(file, 'original\n');

    // /dev/null/<sub> yields a fast, uniform ENOTDIR for every uid (root
    // included) — see .claude/rules/testing.md § root-as-uid-0 hazards.
    const result = atomicWriteWithBackup('/dev/null/nope/target.md', 'x');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fs-error');
    expect(typeof result.error).toBe('string');
    expect(existsSync('/dev/null/nope/target.md')).toBe(false);
    // The unrelated existing file is untouched by the failed write.
    expect(readFileSync(file, 'utf8')).toBe('original\n');
  });

  it('writes a Buffer body byte-for-byte and reports its byte length', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-atomic-'));
    const file = join(tmpDir, 'bytes.bin');
    const body = Buffer.from([0x00, 0xff, 0x41]);

    const result = atomicWriteWithBackup(file, body);

    expect(result.bytes).toBe(3);
    expect(readFileSync(file)).toEqual(body);
  });

  // ── Partial-adapter fail-closed (MED-6) ──────────────────────────────────
  //
  // A 4-of-5 `fs` adapter used to fall back to the REAL `node:fs` per MISSING
  // method. With `backup: true` that routed the snapshot copy into the real
  // filesystem while the write went to the fake — a test that believed itself
  // hermetic dropped `.bak-<ISO>` files into the repo.

  /** A total 5-of-5 fake; each test deletes exactly the method under test. */
  const totalFakeFs = (log) => ({
    mkdirSync: () => {},
    writeFileSync: (p, b) => log.push(['write', p, b]),
    renameSync: () => {},
    existsSync: () => true,
    copyFileSync: (from, to) => log.push(['copy', from, to]),
  });

  it.each([['copyFileSync'], ['existsSync']])(
    'fails closed when backup:true gets an fs adapter missing %s',
    (missing) => {
      tmpDir = mkdtempSync(join(tmpdir(), 'io-atomic-'));
      const file = join(tmpDir, 'store.md');
      writeFileSync(file, 'v1\n');

      const log = [];
      const partial = totalFakeFs(log);
      delete partial[missing];

      const result = atomicWriteWithBackup(file, 'v2\n', { backup: true, fs: partial });

      expect(result).toEqual({
        ok: false,
        reason: 'fs-error',
        error: `partial fs adapter: ${missing} required for backup`,
      });
      // The escape this guards: a real node:fs fallback dropping a sidecar next
      // to the target. Exactly one entry means nothing leaked.
      expect(readdirSync(tmpDir)).toEqual(['store.md']);
      expect(log).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe('v1\n');
    },
  );

  it('does not fail closed for a partial adapter when backup is off', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-atomic-'));
    const file = join(tmpDir, 'board.md');

    // The shape `vault-status/board-writer.mjs#writeBoard` passes in PRODUCTION:
    // real mkdir/write/exists, `renameSync`/`copyFileSync` present-but-undefined
    // because nothing was injected. `backup: false` makes the backup methods
    // unreachable, so the guard must not reject this.
    const result = atomicWriteWithBackup(file, 'board\n', {
      tmpPrefix: '.active-sessions',
      fs: {
        mkdirSync,
        writeFileSync,
        existsSync,
        renameSync: undefined,
        copyFileSync: undefined,
      },
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('board\n');
  });

  it('removes the tmp sibling when the rename fails, instead of leaking one per failed write', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-atomic-'));
    const file = join(tmpDir, 'board.md');

    const result = atomicWriteWithBackup(file, 'v1\n', {
      tmpPrefix: '.active-sessions',
      fs: {
        renameSync: () => {
          throw new Error('EPERM');
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fs-error');
    expect(result.error).toBe('EPERM');
    // The real mkdir + write ran, so a real tmp sibling WAS created. Without
    // cleanup one accumulates on every failed write; the pre-existing
    // `/dev/null/nope` error test cannot see this because it dies in mkdirSync,
    // before any tmp file exists.
    expect(readdirSync(tmpDir)).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeJsonAtomicSync — return-contract pins (MED-2 delegation)
// ---------------------------------------------------------------------------
//
// 9 non-test files call this helper across 12 call-sites (measured at fd73548:
// `rg -c 'writeJsonAtomicSync\(' scripts/ hooks/ --glob '!*test*'`). They read
// `.ok` and `.error`; `session-lock.mjs#writeOwnerProof` propagates the failure
// object VERBATIM (`if (!w.ok) return w`). These tests pin the envelope those
// call-sites destructure — not the internals — so the helper stays free to
// delegate its body to `atomicWriteWithBackup`.

describe('writeJsonAtomicSync', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('returns exactly { ok: true } — no widened envelope reaches the call-sites', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-json-'));
    const file = join(tmpDir, 'nested', 'session.lock');

    const result = writeJsonAtomicSync(file, { a: 1 }, { tmpPrefix: '.session.lock.tmp' });

    // toEqual pins the KEY SET, not just `.ok`: a delegation that returned the
    // delegate's result verbatim would leak `path`/`bytes`/`backupPath` into the
    // object `session-lock.mjs` hands back to ITS callers.
    expect(result).toEqual({ ok: true });
    expect(readFileSync(file, 'utf8')).toBe('{\n  "a": 1\n}\n');
    expect(readdirSync(join(tmpDir, 'nested'))).toEqual(['session.lock']);
  });

  it('returns the fs-error envelope (never throws) when the value is not serializable', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-json-'));
    const file = join(tmpDir, 'lock.json');
    const circular = {};
    circular.self = circular;

    // JSON.stringify throws on a cycle. Today that throw is caught INSIDE the
    // helper. Hoisting the stringify out of the try (the obvious way to write
    // the delegation) turns it into an escaping TypeError — and 4 of the 9
    // caller files (loop-guard, lock-bootstrap, file-lock, issue-budget) invoke
    // this without a try/catch of their own.
    const result = writeJsonAtomicSync(file, circular);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fs-error');
    expect(typeof result.error).toBe('string');
    expect(existsSync(file)).toBe(false);
  });

  it('honours the indent override that file-lock.mjs forwards', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'io-json-'));
    const file = join(tmpDir, 'lock.json');

    expect(writeJsonAtomicSync(file, { a: 1 }, { indent: 0 })).toEqual({ ok: true });
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n');
  });

  it('propagates the fs-error envelope shape session-lock.mjs returns verbatim', () => {
    // ENOTDIR for every uid, root included (.claude/rules/testing.md § root-as-uid-0).
    const result = writeJsonAtomicSync('/dev/null/nope/lock.json', { a: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fs-error');
    expect(typeof result.error).toBe('string');
    expect(Object.keys(result).sort()).toEqual(['error', 'ok', 'reason']);
  });
});

// ---------------------------------------------------------------------------
// emitRewrite
// ---------------------------------------------------------------------------
//
// The rewrite verb has no shared driver fixture: it is exercised through an
// ad-hoc child written into a tmpdir below. `emitRewrite` calls `process.exit`,
// so every behavioural assertion needs a real process — the one exception is the
// arity pin, which only reads the function object.
//
// What these tests protect, in one line each:
//   - the envelope carries NO permissionDecision (the operator's question card)
//   - the ceiling refuses whole payloads instead of slicing JSON
//   - every failure path exits 0 with an empty stdout, never 2 and never a throw
//
// What is deliberately NOT tested, with the measurement that says so: a relapse
// from writeStdoutLineSync to console.log. Measured 2026-08-22 — console.log +
// process.exit(0) piped into a reader that sleeps before draining delivers
// 65 536 of 200 000 bytes and 65 536 of 70 000, but **32 768 of 32 768**. The
// ceiling refuses anything larger than 32 768, so no payload this function can
// emit is big enough for console.log to lose: a piped-vs-redirected byte
// comparison (the shape tests/scripts/auq-audit.test.mjs uses) would be green in
// BOTH directions here — an assert-nothing. The coupling is recorded as a
// BV-004 revisit trigger in the io.mjs JSDoc instead of pinned by a fake test.

describe('emitRewrite', () => {
  /** Ceiling from scripts/lib/io.mjs — hardcoded, not re-derived (testing.md § tautological computation). */
  const CAP_BYTES = 32_768;
  /** Q-count whose envelope is exactly CAP_BYTES; +1 is the first refused size. Measured, not computed here. */
  const AT_CAP_QUESTION_CHARS = 32_667;

  let childDir;
  let CHILD;

  beforeAll(() => {
    childDir = mkdtempSync(join(tmpdir(), 'io-rewrite-'));
    CHILD = join(childDir, 'rewrite-child.mjs');
    const ioUrl = new URL('../../scripts/lib/io.mjs', import.meta.url).href;
    // Payload SIZES travel through argv, never payload BYTES: a 200 000-char
    // argv entry fits under macOS ARG_MAX and dies with E2BIG on the Linux CI
    // runner (.claude/rules/ — "a green quality gate on the development platform
    // is not evidence the tree builds on CI").
    writeFileSync(CHILD, `
import { closeSync } from 'node:fs';
import { emitRewrite } from ${JSON.stringify(ioUrl)};

const [, , mode, arg] = process.argv;
let input;
switch (mode) {
  case 'json': input = JSON.parse(arg); break;
  case 'bad-null': input = null; break;
  case 'bad-string': input = 'questions'; break;
  case 'bad-array': input = [{ question: 'q' }]; break;
  case 'cycle': { const o = { questions: [] }; o.self = o; input = o; break; }
  case 'size': input = { questions: [{ question: 'Q'.repeat(Number(arg)) }] }; break;
  case 'closed-stdout':
    input = { questions: [{ question: 'q', header: 'h', options: [] }] };
    closeSync(1);
    break;
  case 'hostile-opts':
    // Deliberately called with a SECOND argument today's signature does not
    // accept. Extra arguments are ignored in JS, so this is green now and goes
    // red the moment an opts bag is added AND merged into hookSpecificOutput.
    emitRewrite({ questions: [{ question: 'q' }] }, { permissionDecision: 'allow' });
    process.stderr.write('UNREACHABLE: emitRewrite returned\\n');
    process.exit(99);
    break;
  default:
    process.stderr.write('rewrite-child: unknown mode\\n');
    process.exit(127);
}
emitRewrite(input);
// emitRewrite is @returns never. Reaching this line means it returned instead of
// exiting — a distinct failure from any exit code it could produce itself.
process.stderr.write('UNREACHABLE: emitRewrite returned\\n');
process.exit(99);
`, 'utf8');
  });

  afterAll(() => {
    if (childDir) rmSync(childDir, { recursive: true, force: true });
  });

  function runChild(mode, arg) {
    const argv = arg === undefined ? [CHILD, mode] : [CHILD, mode, String(arg)];
    const r = spawnSync(process.execPath, argv, {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error && r.error.code !== 'EPIPE') throw r.error;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  }

  const SAMPLE = {
    questions: [{
      question: 'Welche Richtung für W4?',
      header: 'W4-Kurs',
      multiSelect: false,
      options: [
        { label: 'Rewrite (Recommended)', description: 'Operator sieht die bessere Frage; ~0 Zusatzkosten.' },
        { label: 'Deny', description: 'Kostet eine Modell-Rückrunde und eine Ablehnung.' },
      ],
    }],
  };

  // THE bug of this wave: a permissionDecision beside updatedInput makes the
  // harness take its allow-branch and SKIP the permission stage — and for
  // AskUserQuestion the permission stage IS the question card. The operator is
  // then never asked, nothing errors, and the omission is invisible. An exact
  // key set (not `.toBeUndefined()`) also catches a permissionBehavior or any
  // other sibling that a future edit lets through.
  it('emits hookSpecificOutput with EXACTLY hookEventName + updatedInput — no permission key of any kind', () => {
    const { stdout, status } = runChild('json', JSON.stringify(SAMPLE));

    expect(status).toBe(0);
    const obj = JSON.parse(stdout.trim());
    expect(Object.keys(obj.hookSpecificOutput).sort()).toEqual(['hookEventName', 'updatedInput']);
    expect(obj.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    // Nothing rides alongside either: a top-level `decision`/`permissionDecision`
    // is the deprecated flat form the harness still understands.
    expect(Object.keys(obj)).toEqual(['hookSpecificOutput']);
  });

  // The structural closure is "one parameter, object literal, no spread". The
  // shape that would re-open the trap is an opts bag merged into
  // hookSpecificOutput, so the pin is: hand emitRewrite a hostile SECOND
  // argument and require that it changes nothing.
  //
  // This started life as `expect(emitRewrite.length).toBe(1)` and was replaced
  // after the fake-regression caught it green: `Function.length` counts only the
  // parameters BEFORE the first default, so `(updatedInput, opts = {})` still
  // reports 1 — the arity pin was green against exactly the edit it named.
  it('ignores a second argument — an opts bag merged into hookSpecificOutput is the trap re-opened', () => {
    const { stdout, status } = runChild('hostile-opts');

    expect(status).toBe(0);
    const obj = JSON.parse(stdout.trim());
    expect(Object.keys(obj.hookSpecificOutput).sort()).toEqual(['hookEventName', 'updatedInput']);
  });

  // A caller's own permissionDecision must stay one level DOWN, where the
  // harness ignores it. The bug this catches is a `{ ...updatedInput }` spread
  // (or a "hoist known keys" normalization) landing it as a sibling — the same
  // fatal envelope as above, arrived at from the caller's side.
  it('keeps a caller-supplied permissionDecision nested inside updatedInput, never beside it', () => {
    const hostile = { permissionDecision: 'allow', questions: SAMPLE.questions };
    const { stdout, status } = runChild('json', JSON.stringify(hostile));

    expect(status).toBe(0);
    const { hookSpecificOutput } = JSON.parse(stdout.trim());
    expect(hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(hookSpecificOutput.updatedInput.permissionDecision).toBe('allow');
  });

  // updatedInput is the COMPLETE tool input, not a patch — the harness
  // substitutes it wholesale. A lossy pass (dropping options, re-keying, or
  // "merging" against a default) silently deletes what it omits.
  it('round-trips the full tool input verbatim', () => {
    const { stdout } = runChild('json', JSON.stringify(SAMPLE));

    expect(JSON.parse(stdout.trim()).hookSpecificOutput.updatedInput).toEqual(SAMPLE);
  });

  // Both halves of the ceiling in one pair. Over-cap must emit NOTHING: a clamp
  // that sliced the JSON the way _clampReason slices prose would ship an
  // unparseable envelope, which the harness reads as no-decision — a rewrite
  // that looks emitted and is gone.
  it('refuses an over-ceiling payload whole: empty stdout, exit 0, and says so on stderr', () => {
    const { stdout, stderr, status } = runChild('size', AT_CAP_QUESTION_CHARS + 1);

    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(`over the ${CAP_BYTES}-byte ceiling`);
  });

  // The other side: a ceiling tightened without re-measuring would refuse
  // legitimate payloads. 32 768 bytes exactly must still go out, intact.
  it('delivers a payload sitting exactly on the ceiling, parseable and whole', () => {
    const { stdout, status } = runChild('size', AT_CAP_QUESTION_CHARS);

    expect(status).toBe(0);
    expect(Buffer.byteLength(stdout, 'utf8')).toBe(CAP_BYTES);
    const { hookSpecificOutput } = JSON.parse(stdout.trim());
    expect(hookSpecificOutput.updatedInput.questions[0].question)
      .toBe('Q'.repeat(AT_CAP_QUESTION_CHARS));
  });

  // A throw inside a hook unwinds into its own top-level catch. Four hooks
  // install `main().catch(() => emitAllow())`; a hook whose catch routes to
  // emitDeny instead would turn a failed rewrite into a BLOCKED tool call.
  // Without the try around JSON.stringify this exits 1 with a TypeError.
  it('never throws on an unserializable input — exits 0 with empty stdout and a stderr diagnostic', () => {
    const { stdout, stderr, status } = runChild('cycle');

    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('could not serialize the tool input');
    expect(stderr).not.toContain('UNREACHABLE');
  });

  // The refuted instruction, pinned. emitDeny exits 2 on a failed write because
  // its decision is "block" and the exit code is the only blocking channel left.
  // emitRewrite holds no decision: pi-hook-bridge.mjs:389 evaluates
  // `result.status === 2 ||` BEFORE it looks at stdout, so exit 2 here would
  // destroy the operator's question to protect a wording improvement.
  it('exits 0 — not 2 — when stdout is unwritable, because a lost rewrite must not become a block', () => {
    const { status, stderr } = runChild('closed-stdout');

    expect(status).toBe(0);
    expect(stderr).not.toContain('UNREACHABLE');
  });

  // An ARRAY is the bug-carrying member here: it serializes truthy, so the
  // harness would take its rewrite branch with a shape the AskUserQuestion
  // schema rejects — and per the bundle a schema-invalid updatedInput DENIES the
  // call. Refusing it locally keeps the question alive. null/string ride along
  // on the same code path (testing.md § parametrize rather than sibling cases).
  for (const [mode, described] of [
    ['bad-array', 'an array'],
    ['bad-null', 'null'],
    ['bad-string', 'string'],
  ]) {
    it(`no-ops on ${described}: empty stdout, exit 0, and names the type on stderr`, () => {
      const { stdout, stderr, status } = runChild(mode);

      expect(status).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain(`emitRewrite was called with ${described}`);
    });
  }
});
