import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  verifyVitestResult,
  assertVitestGreenFile,
  inFlightFilesFromLog,
  inFlightFilesFromLogFile,
} from '../../../scripts/ci/assert-vitest-green.mjs';

const SCRIPT = resolve(
  fileURLToPath(new URL('../../../scripts/ci/assert-vitest-green.mjs', import.meta.url)),
);

// Glyphs constructed from charcodes so this source file stays free of raw
// "invisible"/look-alike control or special chars (learning:
// literal-invisible-chars-in-test-source). U+276F ❯ start, U+2713 ✓ pass,
// U+00D7 × fail, U+2717 ✗ alt-fail, U+2192 → arrow, U+001B ESC.
const G_START = String.fromCharCode(0x276f);
const G_PASS = String.fromCharCode(0x2713);
const G_FAIL = String.fromCharCode(0x00d7);
const G_FAIL_ALT = String.fromCharCode(0x2717);
const ARROW = String.fromCharCode(0x2192);
const ESC = String.fromCharCode(0x1b);

// A realistic vitest --reporter=default capture where two files started
// (`❯ …`) and were killed before completing, while one file completed (`✓ …`).
const HANG_LOG = [
  ' RUN  v4.1.5 /repo',
  '',
  ` ${G_PASS} tests/scripts/ci/assert-vitest-green.test.mjs (11 tests) 4ms`,
  ` ${G_START} tests/slow/alpha.test.mjs`,
  ` ${G_START} tests/slow/beta.test.mjs`,
  '',
].join('\n');

// A complete, all-passing vitest-4 JSON result (realistic field set).
const GREEN = {
  numTotalTestSuites: 446,
  numPassedTestSuites: 446,
  numFailedTestSuites: 0,
  numTotalTests: 9871,
  numPassedTests: 9871,
  numFailedTests: 0,
  success: true,
};

describe('verifyVitestResult — green path', () => {
  it('accepts a complete all-passing result', () => {
    const r = verifyVitestResult(GREEN);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('all tests passed');
    expect(r.summary.numPassedTests).toBe(9871);
  });
});

describe('verifyVitestResult — fail-closed paths', () => {
  it('rejects when numFailedTests > 0', () => {
    const r = verifyVitestResult({ ...GREEN, success: false, numFailedTests: 12, numPassedTests: 9859 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('12 failed test(s)');
  });

  it('rejects when a suite failed even if test counts look clean', () => {
    const r = verifyVitestResult({ ...GREEN, success: false, numFailedTestSuites: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('1 failed test suite(s)');
  });

  it('rejects when success is false but counts were not parsed (success guard fires first)', () => {
    const r = verifyVitestResult({ ...GREEN, success: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('success is false (expected true)');
  });

  it('rejects a truncated run below the default 5000-test floor', () => {
    const r = verifyVitestResult({ ...GREEN, numTotalTests: 120, numPassedTests: 120 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('only 120 total tests (< floor 5000) — truncated or partial run');
  });

  it('rejects when a required numeric field is missing (half-written JSON)', () => {
    const partial = { success: true, numPassedTests: 9871, numFailedTests: 0, numFailedTestSuites: 0 };
    const r = verifyVitestResult(partial);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing/invalid field "numTotalTests" (truncated or wrong-shape JSON)');
  });

  it('rejects a non-object result', () => {
    expect(verifyVitestResult(null).ok).toBe(false);
    expect(verifyVitestResult('done').ok).toBe(false);
  });

  it('honors a custom minTests floor', () => {
    const r = verifyVitestResult({ ...GREEN, numTotalTests: 200, numPassedTests: 200 }, { minTests: 100 });
    expect(r.ok).toBe(true);
  });
});

describe('assertVitestGreenFile — file IO fail-closed', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assert-vitest-green-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns ok for a green result file', () => {
    const p = join(dir, 'result.json');
    writeFileSync(p, JSON.stringify(GREEN));
    expect(assertVitestGreenFile(p).ok).toBe(true);
  });

  it('fails closed when the file is absent', () => {
    const r = assertVitestGreenFile(join(dir, 'does-not-exist.json'));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cannot read result file');
  });

  it('fails closed on unparseable JSON', () => {
    const p = join(dir, 'garbage.json');
    writeFileSync(p, 'this is not json {');
    const r = assertVitestGreenFile(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not valid JSON');
  });
});

describe('inFlightFilesFromLog — in-flight detection', () => {
  it('returns files started but never completed', () => {
    expect(inFlightFilesFromLog(HANG_LOG)).toEqual([
      'tests/slow/alpha.test.mjs',
      'tests/slow/beta.test.mjs',
    ]);
  });

  it('returns [] when every started file completed', () => {
    const log = [
      ` ${G_START} tests/a.test.mjs`,
      ` ${G_PASS} tests/a.test.mjs (3 tests) 5ms`,
      ` ${G_START} tests/b.test.mjs`,
      ` ${G_FAIL} tests/b.test.mjs (2 tests | 1 failed) 9ms`,
    ].join('\n');
    expect(inFlightFilesFromLog(log)).toEqual([]);
  });

  it('returns [] for empty or non-string input', () => {
    expect(inFlightFilesFromLog('')).toEqual([]);
    expect(inFlightFilesFromLog(null)).toEqual([]);
    expect(inFlightFilesFromLog(undefined)).toEqual([]);
  });

  it('treats a CRLF log identically — \\r does not break the path match', () => {
    // CI captures stdout; on a CRLF-terminated capture the trailing \r must not
    // defeat the \b boundary after the path. alpha is in-flight, beta completed.
    const log = [
      ` ${G_START} tests/slow/alpha.test.mjs`,
      ` ${G_PASS} tests/fast/beta.test.mjs (3 tests) 5ms`,
    ].join('\r\n');
    expect(inFlightFilesFromLog(log)).toEqual(['tests/slow/alpha.test.mjs']);
  });

  it('recognizes the U+2717 alt-fail glyph as a completion marker (not in-flight)', () => {
    // The source header names only the U+2713/U+00D7 completion glyphs, but the
    // COMPLETED regex also accepts U+2717. A file completed with it is finished.
    const log = [
      ` ${G_START} tests/a.test.mjs`,
      ` ${G_FAIL_ALT} tests/a.test.mjs (2 tests | 1 failed) 9ms`,
    ].join('\n');
    expect(inFlightFilesFromLog(log)).toEqual([]);
  });

  it('does not report a file queued twice then completed (retry-style dedup)', () => {
    // A file can appear with the start glyph more than once. As long as a
    // completion marker eventually lands, it is NOT in-flight.
    const log = [
      ` ${G_START} tests/a.test.mjs`,
      ` ${G_START} tests/a.test.mjs`,
      ` ${G_PASS} tests/a.test.mjs (3 tests) 5ms`,
    ].join('\n');
    expect(inFlightFilesFromLog(log)).toEqual([]);
  });

  it('does not report a file whose completion line precedes its start line', () => {
    // Completion is tracked by membership, not ordering.
    const log = [
      ` ${G_PASS} tests/a.test.mjs (3 tests) 5ms`,
      ` ${G_START} tests/a.test.mjs`,
    ].join('\n');
    expect(inFlightFilesFromLog(log)).toEqual([]);
  });

  it('does not parse an ANSI-colored log — the --no-color CI precondition is load-bearing', () => {
    // CI runs the reporter with --no-color (see source header). A colorized log
    // wraps the glyph in ESC sequences so "glyph + whitespace + path" never
    // matches and nothing is reported. Pinning this documents WHY --no-color is
    // mandatory: with color the diagnostic silently yields [].
    const log = [
      ` ${ESC}[36m${G_START}${ESC}[0m tests/slow/alpha.test.mjs`,
      ` ${ESC}[32m${G_PASS}${ESC}[0m tests/fast/beta.test.mjs (3 tests) 5ms`,
    ].join('\n');
    expect(inFlightFilesFromLog(log)).toEqual([]);
  });

  it('reports only the in-flight file when some siblings completed (mixed run)', () => {
    const log = [
      ` ${G_PASS} tests/done/one.test.mjs (5 tests) 12ms`,
      ` ${G_FAIL} tests/done/two.test.mjs (3 tests | 1 failed) 8ms`,
      ` ${G_START} tests/hung/three.test.mjs`,
    ].join('\n');
    expect(inFlightFilesFromLog(log)).toEqual(['tests/hung/three.test.mjs']);
  });

  it('matches .test and .spec file paths across js/ts/mjs/cjs extensions', () => {
    // The STARTED/COMPLETED patterns key off the *.{test,spec}.{c,m}{j,t}sx?
    // suffix. A started .spec.ts that never completes is reported.
    const log = [
      ` ${G_START} src/components/Button.spec.tsx`,
      ` ${G_PASS} src/util/format.test.cjs (4 tests) 2ms`,
    ].join('\n');
    expect(inFlightFilesFromLog(log)).toEqual(['src/components/Button.spec.tsx']);
  });

  it('strips control/ESC bytes from a captured path (security-review Q2 NICE — no terminal-escape passthrough to stderr)', () => {
    // A malicious log line embeds an ANSI clear-screen escape inside the path
    // token. `\S+` would capture it; stripCtrl must neutralize C0/DEL bytes so
    // the in-flight hint cannot smuggle terminal-control sequences into a CI log.
    const log = ` ${G_START} ${ESC}[2Jtests/evil/${ESC}[1;1Hpwn.test.mjs`;
    const out = inFlightFilesFromLog(log);
    expect(out).toEqual(['?[2Jtests/evil/?[1;1Hpwn.test.mjs']);
    expect(out[0]).not.toContain(ESC);
  });
});

describe('inFlightFilesFromLogFile — file IO fail-soft', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assert-vitest-green-log-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extracts in-flight files from a log file', () => {
    const p = join(dir, 'vitest.log');
    writeFileSync(p, HANG_LOG);
    expect(inFlightFilesFromLogFile(p)).toEqual([
      'tests/slow/alpha.test.mjs',
      'tests/slow/beta.test.mjs',
    ]);
  });

  it('returns [] when the log file does not exist (fail-soft)', () => {
    expect(inFlightFilesFromLogFile(join(dir, 'nope.log'))).toEqual([]);
  });
});

describe(`CLI --log diagnostic (exit-code contract unchanged, message enriched)`, () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assert-vitest-green-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(args) {
    return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  }

  it(`missing JSON + log with in-flight files ${ARROW} lists them, still exits 1`, () => {
    const logPath = join(dir, 'vitest.log');
    writeFileSync(logPath, HANG_LOG);
    const missingJson = join(dir, 'no-result.json');
    const r = run([missingJson, `--log=${logPath}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('2 test file(s) in-flight when killed');
    expect(r.stderr).toContain('tests/slow/alpha.test.mjs');
    expect(r.stderr).toContain('tests/slow/beta.test.mjs');
  });

  it(`missing JSON + no --log ${ARROW} identical bare fail-closed, exits 1, no hint`, () => {
    const missingJson = join(dir, 'no-result.json');
    const r = run([missingJson]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL-CLOSED: cannot read result file');
    expect(r.stderr).not.toContain('in-flight when killed');
  });

  it(`missing JSON + --log pointing at a nonexistent file ${ARROW} graceful fallback, exits 1, no hint`, () => {
    const missingJson = join(dir, 'no-result.json');
    const r = run([missingJson, `--log=${join(dir, 'absent.log')}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL-CLOSED: cannot read result file');
    expect(r.stderr).not.toContain('in-flight when killed');
  });

  it(`green JSON ${ARROW} exits 0 regardless of --log`, () => {
    const jsonPath = join(dir, 'result.json');
    writeFileSync(jsonPath, JSON.stringify({ ...GREEN, numTotalTests: 1600, numPassedTests: 1600 }));
    const r = run([jsonPath, '--min-tests=1500', `--log=${join(dir, 'absent.log')}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('suite verifiably green');
  });
});
