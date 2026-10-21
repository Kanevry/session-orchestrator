/**
 * tests/scripts/gates/gate-full.test.mjs
 *
 * Integration tests for scripts/lib/gates/gate-full.mjs
 * Spawns the script via node, injects env vars, and asserts on JSON stdout + exit codes.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/gates/gate-full.mjs',
);
const TEST_LEDGER_ROOT = mkdtempSync(path.join(tmpdir(), 'gate-test-ledger-'));
afterAll(() => rmSync(TEST_LEDGER_ROOT, { recursive: true, force: true }));

/**
 * Spawn gate-full.mjs with the given extra env vars.
 */
function run(extraEnv = {}, cwd = undefined) {
  const env = { ...process.env };
  // Never let a spawned gate script register its children in the LIVE
  // .orchestrator/runtime/gate-processes.jsonl of this checkout (q-1 H1, W5).
  env.GATE_LEDGER_ROOT = TEST_LEDGER_ROOT;
  for (const key of ['TYPECHECK_CMD', 'TEST_CMD', 'LINT_CMD', 'FILES', 'SESSION_START_REF']) {
    delete env[key];
  }
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
    ...(cwd ? { cwd } : {}),
  });
}

// ---------------------------------------------------------------------------
// All skip → exit 0
// ---------------------------------------------------------------------------

describe('gate-full — all skip', () => {
  // Consolidated from 9 single-assertion `it`s that each re-spawned the gate to
  // read ONE field of the SAME envelope (TV-002 duplication). One spawn, one
  // envelope, whole-object assertions — which are also tighter than the
  // per-field `toBe`s they replace.
  it('emits the documented all-skip envelope and exits 0', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    expect(r.status).toBe(0);

    const json = JSON.parse(r.stdout);
    expect(json.variant).toBe('full-gate');
    expect(json.typecheck).toEqual({ status: 'skip', error_count: 0 });
    // `failed` is published explicitly since #967 item 1 — a skipped test gate
    // must still carry the key (as 0), or the consumer's
    // `passed + failed === total` drift check silently degrades to a derivation.
    //
    // The file-level four are the OPPOSITE case and are ABSENT here: a skipped
    // gate produced no `Test Files` line, so nothing about files was measured.
    // Publishing `files_*: 0` + `suite_died: false` stated a verdict nobody
    // checked — this whole-object `toEqual` is what pins their absence.
    expect(json.test).toEqual({
      status: 'skip',
      total: 0,
      passed: 0,
      failed: 0,
    });
    expect(json.lint).toEqual({ status: 'skip', warnings: 0 });
    expect(json.debug_artifacts).toEqual([]);
    expect(typeof json.duration_seconds).toBe('number');
    expect(json.duration_seconds).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Typecheck failure → exit 2
// ---------------------------------------------------------------------------

describe('gate-full — typecheck failure', () => {
  // Consolidated from 4 `it`s (3 of which re-spawned the identical command).
  it('exits 2, reports status "fail", and counts 0 errors without TS error lines', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    expect(r.status).toBe(2);
    const json = JSON.parse(r.stdout);
    // The inner kill ladder is MEASURED for a spawned command (#1457): not killed.
    expect(json.typecheck).toEqual({
      status: 'fail', error_count: 0, timed_out: false, kill_signals: [], survivors: [],
    });
  });

  it('typecheck.error_count is >= 1 when output contains TS error lines', () => {
    const cmd = `node -e "process.stdout.write('error TS2304: Cannot find name\\n'); process.exit(1)"`;
    const r = run({ TYPECHECK_CMD: cmd, TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.error_count).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test failure → exit 2
// ---------------------------------------------------------------------------

describe('gate-full — test failure', () => {
  // Consolidated from 2 `it`s that re-spawned the identical command.
  it('exits 2 and reports test.status "fail" when TEST_CMD fails', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'node -e "process.exit(1)"', LINT_CMD: 'skip' });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).test.status).toBe('fail');
  });

  // #1149 — a suite that dies at import is a file-level failure. Vitest omits
  // `N failed` on the `Tests` line when zero test CASES ran, so the test-case
  // triple stays `failed: 0` even though a file died. `files_failed` and the
  // self-diagnosing `suite_died` boolean must still land on the ONE stdout
  // JSON document, so the contradiction is greppable instead of silent.
  it('publishes files_failed and suite_died:true when a suite dies at import with no test-case failed segment (#1149)', () => {
    const cmd =
      'node -e "process.stdout.write(\' Test Files  1 failed (1)\\n      Tests  5 passed (5)\\n\'); process.exit(1)"';
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: cmd, LINT_CMD: 'skip' });
    expect(r.status).toBe(2);

    const parsed = JSON.parse(r.stdout);
    expect(parsed.test).toEqual({
      status: 'fail',
      total: 5,
      passed: 5,
      failed: 0,
      files_total: 1,
      files_passed: 0,
      files_failed: 1,
      // Measured, and EMPTY: this stub prints the summary line only, so the
      // file-level measurement exists but names nothing. Absent would mean
      // "no file-level measurement at all" — the case the sibling row below
      // pins. See `failed_files` in gate-full.mjs.
      failed_files: [],
      suite_died: true,
      timed_out: false,
      kill_signals: [],
      survivors: [],
    });
    // Contract: consumers parse exactly one JSON document from stdout.
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  // THE BUG this row names, measured 2026-09-06: the pre-push gate BLOCKED a
  // push with `files_failed: 1` out of 662 and no file name anywhere in the
  // envelope, and reconstructing WHICH file died cost a full manual
  // re-materialisation of the tracked tree. The runner had printed the path all
  // along — `extractTestCounts` just never looked past the two summary lines.
  it('names the failing files in failed_files and on stderr (vitest transcript shape)', () => {
    const transcript = [
      ' \\u276f tests/red.test.mjs (2 tests | 1 failed) 4ms',
      ' FAIL  tests/red.test.mjs > red > fails',
      ' \\u276f tests/red.test.mjs:3:33',
      ' FAIL  tests/dead.test.mjs [ tests/dead.test.mjs ]',
      ' Test Files  2 failed (2)',
      '      Tests  1 failed | 1 passed (2)',
    ].join('\\n');
    const cmd = `node -e "process.stdout.write('${transcript}\\n'); process.exit(1)"`;
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: cmd, LINT_CMD: 'skip' });
    expect(r.status).toBe(2);

    const parsed = JSON.parse(r.stdout);
    expect(parsed.test.files_failed).toBe(2);
    expect(parsed.test.failed_files).toEqual(['tests/red.test.mjs', 'tests/dead.test.mjs']);
    // The operator under pre-push reads stderr, so the names must be there too —
    // with the command that reproduces them.
    expect(r.stderr).toContain('failing test files (2)');
    expect(r.stderr).toContain('npx vitest run tests/red.test.mjs tests/dead.test.mjs');
  });

  // The sibling of the row above, and the bug it names: a FAILING runner that
  // prints no `Test Files` line at all (non-vitest, or a terse reporter) used to
  // publish `files_total/passed/failed: 0` plus `suite_died: false` — an
  // unmeasured zero the envelope could not tell from a measured one, and a
  // "the suite did not die" verdict derived from it. Absent, not zero.
  it('omits every files_* key AND suite_died when the runner printed no Test Files line', () => {
    const cmd = 'node -e "process.stdout.write(\'      Tests  3 passed (3)\\n\'); process.exit(1)"';
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: cmd, LINT_CMD: 'skip' });
    expect(r.status).toBe(2);

    const parsed = JSON.parse(r.stdout);
    expect(parsed.test).toEqual({
      status: 'fail', total: 3, passed: 3, failed: 0, timed_out: false, kill_signals: [], survivors: [],
    });
    expect(parsed.test).not.toHaveProperty('files_total');
    expect(parsed.test).not.toHaveProperty('files_passed');
    expect(parsed.test).not.toHaveProperty('files_failed');
    expect(parsed.test).not.toHaveProperty('failed_files');
    // The load-bearing half: `suite_died: false` here would be a claim about a
    // file-level measurement that never happened.
    expect(parsed.test).not.toHaveProperty('suite_died');
  });
});

// ---------------------------------------------------------------------------
// All pass → exit 0
// ---------------------------------------------------------------------------

describe('gate-full — all pass', () => {
  // Consolidated from 2 `it`s that re-spawned the identical env.
  it('exits 0 with all three statuses "pass" when commands succeed', () => {
    const r = run({
      TYPECHECK_CMD: 'echo TC_OK',
      TEST_CMD: 'echo TEST_OK',
      LINT_CMD: 'echo LINT_OK',
    });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.status).toBe('pass');
    expect(json.test.status).toBe('pass');
    expect(json.lint.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// stubbed field in emitted JSON
// ---------------------------------------------------------------------------

describe('gate-full — stubbed field in emitted JSON', () => {
  it('JSON contains stubbed as an empty object when all commands are real (not stubs)', () => {
    const r = run({
      TYPECHECK_CMD: 'node -e "process.exit(0)"',
      TEST_CMD: 'node -e "process.exit(0)"',
      LINT_CMD: 'node -e "process.exit(0)"',
    });
    const json = JSON.parse(r.stdout);
    expect(json.stubbed).toEqual({});
  });

  it('JSON contains stubbed key even when all checks are skipped', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json).toHaveProperty('stubbed');
    expect(json.stubbed).toEqual({});
  });

  // Consolidated from 3 `it`s that re-spawned the identical echo-stub env.
  it('flags an echo TEST_CMD as a stub while still passing the gate', () => {
    const r = run({
      TYPECHECK_CMD: 'node -e "process.exit(0)"',
      TEST_CMD: 'echo "no tests yet"',
      LINT_CMD: 'node -e "process.exit(0)"',
    });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.stubbed.test).toEqual({ kind: 'echo' });
    expect(json.test.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Missing env vars
// ---------------------------------------------------------------------------

describe('gate-full — missing env vars', () => {
  it('exits 1 when TYPECHECK_CMD is not set', () => {
    const env = { ...process.env };
    delete env.TYPECHECK_CMD;
    env.TEST_CMD = 'skip';
    env.LINT_CMD = 'skip';
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TYPECHECK_CMD');
  });

  it('exits 1 when TEST_CMD is not set', () => {
    const env = { ...process.env };
    delete env.TEST_CMD;
    env.TYPECHECK_CMD = 'skip';
    env.LINT_CMD = 'skip';
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TEST_CMD');
  });

  it('exits 1 when LINT_CMD is not set', () => {
    const env = { ...process.env };
    delete env.LINT_CMD;
    env.TYPECHECK_CMD = 'skip';
    env.TEST_CMD = 'skip';
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('LINT_CMD');
  });
});

// ---------------------------------------------------------------------------
// Inner per-command kill reaches the envelope (#1457 point 1)
// ---------------------------------------------------------------------------

describe('gate-full — inner per-command kill ladder', () => {
  // Bug: a command killed by the INNER ceiling (`runCheck`, GATE_TIMEOUT_MS)
  // left no trace in the envelope, so run-quality-gate.mjs emitted
  // `timed_out: false` for a gate that had in fact killed a command.
  it('publishes timed_out/kill_signals on the killed command, omits them for skipped ones', () => {
    const r = run({
      GATE_TIMEOUT_MS: '300',
      TYPECHECK_CMD: 'sleep 30',
      TEST_CMD: 'skip',
      LINT_CMD: 'skip',
    });
    expect(r.status).toBe(2);
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.status).toBe('fail');
    expect(json.typecheck.timed_out).toBe(true);
    expect(json.typecheck.kill_signals[0]).toBe('SIGTERM');
    expect(Array.isArray(json.typecheck.survivors)).toBe(true);
    // Skipped commands spawned nothing: absent, never `false`.
    expect(json.lint).not.toHaveProperty('timed_out');
    expect(json.test).not.toHaveProperty('timed_out');
  });
});

// ---------------------------------------------------------------------------
// Serial re-run of timeout-only failures (#1673)
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('gate-full — serial re-run of timeout-only failures', () => {
  const FIRST_SUMMARY = [' Test Files  1 failed | 4 passed (5)', '      Tests  1 failed | 9 passed (10)'];
  const SLOW = 'tests/slow.test.mjs';
  const timeoutBlock = (file) => [` FAIL  ${file} > slow`, 'Error: Test timed out in 10000ms.'];
  const firstRun = (blocks, summary = FIRST_SUMMARY) =>
    [...blocks.flatMap((b, i) => ['', ...b, `⎯⎯[${i + 1}/${blocks.length}]⎯`]), '', ...summary].join('\n');

  /**
   * A tmp project whose TEST_CMD is its own `node_modules/.bin/vitest run` — the
   * re-run appends to that same command (Codex review round 2, H2). The stub
   * records every argv; without `--outputFile.json` it replays `first` with
   * exit `firstRc`, with it it writes `report` (vitest's JSON-reporter shape,
   * names relative to the project) there and exits `rerunRc`.
   */
  const dirs = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const STUB_TEST_CMD = 'node_modules/.bin/vitest run';
  function project({ first, report = null, rerunRc = 0, firstRc = 1, firstSignal = null }) {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-full-rerun-'));
    dirs.push(dir);
    mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(path.join(dir, 'tests', 'other', 'tests'), { recursive: true });
    for (const f of [SLOW, 'tests/other/tests/slow.test.mjs']) writeFileSync(path.join(dir, f), '');
    writeFileSync(path.join(dir, 'first.txt'), first);
    const absolute = report && { ...report, testResults: report.testResults.map((t) => ({ ...t, name: path.join(dir, t.name) })) };
    writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ report: absolute, rerunRc, firstRc, firstSignal }));
    writeFileSync(path.join(dir, 'node_modules', '.bin', 'vitest'), [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const dir = ${JSON.stringify(dir)};`,
      "fs.appendFileSync(dir + '/calls.txt', process.argv.slice(2).join(' ') + '\\n');",
      "const spec = JSON.parse(fs.readFileSync(dir + '/spec.json', 'utf8'));",
      "const out = process.argv.find((a) => a.startsWith('--outputFile.json='));",
      "if (!out) { fs.writeSync(1, fs.readFileSync(dir + '/first.txt', 'utf8')); if (spec.firstSignal) process.kill(process.pid, spec.firstSignal); else process.exit(spec.firstRc); }",
      "if (spec.report) fs.writeFileSync(out.slice('--outputFile.json='.length), JSON.stringify(spec.report));",
      'process.exit(spec.rerunRc);',
    ].join('\n'), { mode: 0o755 });
    return dir;
  }
  const cleanReport = (files) => ({
    success: true, numPassedTests: 3, numFailedTests: 0, testResults: files.map((name) => ({ name, status: 'passed' })),
  });
  const gate = (dir, testCmd = STUB_TEST_CMD) => run({ TYPECHECK_CMD: 'skip', LINT_CMD: 'skip', TEST_CMD: testCmd }, dir);
  const calls = (dir) => readFileSync(path.join(dir, 'calls.txt'), 'utf8').trim().split('\n');

  // The #1673 block: a load-only timeout used to fail the push; a clean serial
  // re-run of exactly that file now passes it and names it.
  it('passes the gate when every failure was a timeout and the serial re-run is clean', () => {
    const dir = project({ first: firstRun([timeoutBlock(SLOW)]), report: cleanReport([SLOW]) });
    const r = gate(dir);
    expect(r.status).toBe(0);
    // Same command, same selection: only the filters and reporters are added.
    expect(calls(dir)).toEqual([
      'run',
      expect.stringMatching(/^run --no-file-parallelism --reporter=default --reporter=json --outputFile.json=\S+ tests\/slow\.test\.mjs$/),
    ]);
    const json = JSON.parse(r.stdout);
    expect(json.test.status).toBe('pass');
    // The first run's measurement is kept, not rewritten.
    expect(json.test.failed).toBe(1);
    expect(json.test.suite_died).toBe(false);
    expect(json.test.rerun).toMatchObject({ files: [SLOW], status: 'pass', failed: 0, passed: 3 });
    expect(r.stderr).toContain('re-ran serially → pass');
    expect(r.stderr).toContain(`  ${SLOW}`);
  });

  it('keeps the gate red when the serial re-run still fails', () => {
    const report = { success: false, numPassedTests: 2, numFailedTests: 1, testResults: [{ name: SLOW, status: 'failed' }] };
    const dir = project({ first: firstRun([timeoutBlock(SLOW)]), report, rerunRc: 1 });
    const r = gate(dir);
    expect(r.status).toBe(2);
    const json = JSON.parse(r.stdout);
    expect(json.test.status).toBe('fail');
    expect(json.test.rerun).toMatchObject({ files: [SLOW], status: 'fail', reason: 'exit-non-zero' });
    expect(r.stderr).toContain('test re-run FAILED');
  });

  // Exit 0 and a passed count are not proof (Codex review of de97b46c, H2):
  // only the report shows WHICH file ran. A filter that matched another file
  // must stay red, and so must a re-run that wrote no report at all.
  it.each([
    ['another file ran', cleanReport(['tests/other/tests/slow.test.mjs']), 'file-set-mismatch'],
    ['no report', null, 'report-unreadable'],
  ])('keeps the gate red when the re-run exits 0 but the report proves nothing (%s)', (_label, report, reason) => {
    const dir = project({ first: firstRun([timeoutBlock(SLOW)]), report });
    const r = gate(dir);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).test.rerun).toMatchObject({ status: 'fail', reason });
  });

  // Lead 32, 2026-10-20: an assertion failure is never re-run, even beside
  // timeouts. Codex review M3: neither is a first run that did not exit 1.
  // Round 2, H2: nor a test command whose trailing arguments may not reach vitest.
  it.each([
    ['an assertion failure', firstRun([timeoutBlock(SLOW), [' FAIL  tests/bad.test.mjs > bad', 'AssertionError: expected 1 to be 2']],
      [' Test Files  2 failed | 3 passed (5)', '      Tests  2 failed | 8 passed (10)']), 1, STUB_TEST_CMD],
    ['a first run that did not exit 1', firstRun([timeoutBlock(SLOW)]), 143, STUB_TEST_CMD],
    ['a test command of unknown shape', firstRun([timeoutBlock(SLOW)]), 1, `${STUB_TEST_CMD} && true`],
    ['a wrapper in front of vitest', firstRun([timeoutBlock(SLOW)]), 1, `node node_modules/.bin/vitest run`],
  ])('does not re-run anything after %s', (_label, first, firstRc, testCmd) => {
    const dir = project({ first, report: cleanReport([SLOW]), firstRc });
    const r = gate(dir, testCmd);
    expect(r.status).toBe(2);
    expect(calls(dir)).toEqual(['run']);
    expect(JSON.parse(r.stdout).test).not.toHaveProperty('rerun');
  });

  // Codex review round 3, M3: with `exec` the test process IS the spawned
  // child, so a signal ends it with no exit code — which `exitCode` reports as
  // 1. Only `exitSignal` tells this run from a normal failure.
  it('does not re-run anything after a first run that ended by a signal', () => {
    const dir = project({ first: firstRun([timeoutBlock(SLOW)]), report: cleanReport([SLOW]), firstSignal: 'SIGTERM' });
    const r = gate(dir, `exec ${STUB_TEST_CMD}`);
    expect(r.status).toBe(2);
    expect(calls(dir)).toEqual(['run']);
    expect(JSON.parse(r.stdout).test).not.toHaveProperty('rerun');
  });

  // Codex review rounds 2+3, M4: a re-run that cannot even start (no temp dir)
  // keeps the step red, names the files, and does not crash the gate.
  it('stays red and names the files when the re-run cannot start', () => {
    const dir = project({ first: firstRun([timeoutBlock(SLOW)]), report: cleanReport([SLOW]) });
    const r = run({ TYPECHECK_CMD: 'skip', LINT_CMD: 'skip', TEST_CMD: STUB_TEST_CMD, TMPDIR: path.join(dir, 'missing') }, dir);
    expect(r.status).toBe(2);
    const json = JSON.parse(r.stdout);
    expect(json.test.rerun).toMatchObject({ files: [SLOW], status: 'fail', reason: 'rerun-error: ENOENT' });
    expect(r.stderr).toContain('(not run: rerun-error: ENOENT)');
  });
});
