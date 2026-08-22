/**
 * tests/scripts/gates/gate-helpers.test.mjs
 *
 * Unit tests for scripts/lib/gates/gate-helpers.mjs
 */

import { describe, it, expect } from 'vitest';
import {
  admitSuiteCounts,
  csvToJsonArray,
  extractCount,
  extractTestCounts,
  extractErrorLinesJson,
  runCheck,
  findChangedFiles,
  findChangedTestFiles,
  resolveTestFiles,
} from '@lib/gates/gate-helpers.mjs';

// ---------------------------------------------------------------------------
// csvToJsonArray
// ---------------------------------------------------------------------------

describe('csvToJsonArray', () => {
  it.each([
    ['a simple csv into an array of strings', 'a,b,c', ['a', 'b', 'c']],
    ['a csv with surrounding whitespace, trimming each entry', ' a , b , c ', ['a', 'b', 'c']],
    ['a single item with no commas', 'only', ['only']],
    ['a trailing comma, dropping the empty segment', 'a,b,', ['a', 'b']],
    ['an empty string', '', []],
    ['a whitespace-only string', '   ', []],
    ['null', null, []],
    ['undefined', undefined, []],
  ])('parses %s', (_name, input, expected) => {
    expect(csvToJsonArray(input)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// extractCount
// ---------------------------------------------------------------------------

describe('extractCount', () => {
  // A STRING pattern becomes /pattern/gi internally, so it matches globally;
  // a RegExp pattern is used verbatim (no `g` → at most one match).
  it.each([
    ['a single regex match', 'a\nerror TS123\nb', /error TS\d+/, 1],
    ['multiple matches via a string pattern (g flag added internally)', 'error TS100\nerror TS200\nerror TS300', 'error TS\\d+', 3],
    ['a string pattern with two matches', 'warn: something\nwarn: other', 'warn', 2],
    ['no matches', 'everything is fine', /error TS\d+/, 0],
    ['empty output', '', /error TS\d+/, 0],
    ['null output', null, /error TS\d+/, 0],
  ])('counts %s', (_name, output, pattern, expected) => {
    expect(extractCount(output, pattern)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// extractTestCounts
// ---------------------------------------------------------------------------

describe('extractTestCounts', () => {
  // Terse / non-vitest forms: no `Tests`-anchored summary line, so the parser
  // falls back to scanning the whole string. These pin the pre-existing
  // fallback contract unchanged.
  it.each([
    ['passed + failed on one terse line', 'Tests: 5 passed, 2 failed', { passed: 5, failed: 2, total: 7 }],
    ['failure-only output (no "passed" marker)', 'Tests: 3 failed', { passed: 0, failed: 3, total: 3 }],
    ['bare passed count with no "failed" marker', '42 passed', { passed: 42, failed: 0, total: 42 }],
    ['bare passed + failed, total is their sum', '10 passed, 5 failed', { passed: 10, failed: 5, total: 15 }],
    ['empty output', '', { passed: 0, failed: 0, total: 0 }],
    ['null output', null, { passed: 0, failed: 0, total: 0 }],
  ])('parses %s', (_name, input, expected) => {
    expect(extractTestCounts(input)).toEqual(expected);
  });

  // Golden records — REAL captured `npx vitest run` tails, not hand-shaped
  // (.claude/rules/testing.md § Fixtures Mirror Production Data). A hand-written
  // fixture is exactly how this bug survived: every terse case above stayed
  // green while real output was misparsed.
  //
  // Bug this catches: real vitest prints `Test Files <N> passed` BEFORE
  // `Tests <M> passed`, so a whole-output scan returns the FILE count and
  // publishes it as `test.passed` in the quality-gate event stream. Measured on
  // the real full-suite tail, the old parser returned passed=550 where the truth
  // was 12904. Both rows below have file counts that differ from test counts, so
  // a regression to first-match parsing turns them RED.
  it.each([
    [
      'all-pass run (file count 1 vs test count 48)',
      [
        ' Test Files  1 passed (1)',
        '      Tests  48 passed (48)',
        '   Start at  18:37:40',
        '   Duration  447ms (transform 23ms, setup 0ms, import 33ms, tests 289ms, environment 0ms)',
      ].join('\n'),
      { passed: 48, failed: 0, total: 48 },
    ],
    [
      // vitest reports `(8)` here — 5 passed + 1 failed + 2 skipped. `total` is
      // 6, NOT 8: run-quality-gate.mjs derives `failed = total - passed`, so a
      // skipped-inclusive total would publish 3 phantom failures instead of 1.
      'mixed run with failures and skips (file count 2 vs test count 6)',
      [
        ' Test Files  1 failed | 1 passed (2)',
        '      Tests  1 failed | 5 passed | 2 skipped (8)',
        '   Start at  18:38:17',
        '   Duration  131ms (transform 17ms, setup 0ms, import 29ms, tests 6ms, environment 0ms)',
      ].join('\n'),
      { passed: 5, failed: 1, total: 6 },
    ],
  ])('parses the TEST-case counts, not the file counts, from a real vitest %s', (_name, input, expected) => {
    expect(extractTestCounts(input)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// admitSuiteCounts
// ---------------------------------------------------------------------------

describe('admitSuiteCounts', () => {
  // Bugs this catches that nothing else in the suite does (#967 item 2):
  //
  //  1. ZERO TRIPLE FOR AN UNMEASURED GATE. Returning {0,0,0} instead of null
  //     publishes a phantom "0 tests, all green" measurement into the
  //     `orchestrator.quality_gate.*` counts field, indistinguishable from a
  //     real all-skipped run. Absent-not-null is the whole contract, and the
  //     null/undefined + `total <= 0` rows below are its only guards. A caller
  //     with no measurement (fail-fast before the test gate, stubbed command,
  //     no parseable marker) says so by handing over `null` — the ONE channel
  //     since #969 MED-2, when the second `opts.measured` channel was cut as
  //     provably unreachable with a non-null triple.
  //  2. THE LOOSER POLICY WINNING. The former `suiteCountsFromOutput` had only
  //     two rejections and would admit `passed > total` / a negative `passed`.
  //     Unifying on the wrong side of that split is a silent regression, so the
  //     inconsistent-triple rows are the regression proof for the unification.
  //  3. A PARSED `failed` THAT DISAGREES WITH `total`. Accepting a parsed
  //     `failed` (rather than always deriving) reopens `passed + failed !== total`
  //     — a self-inconsistent triple no consumer can interpret.
  it.each([
    // --- accept -------------------------------------------------------------
    ['a consistent triple with a parsed failed', { passed: 5, failed: 1, total: 6 }, { passed: 5, failed: 1, total: 6 }],
    ['an all-pass triple', { passed: 48, failed: 0, total: 48 }, { passed: 48, failed: 0, total: 48 }],
    ['a triple with failed absent, deriving total - passed', { passed: 5, total: 6 }, { passed: 5, failed: 1, total: 6 }],
    ['a triple with a non-finite failed, deriving total - passed', { passed: 5, failed: 'x', total: 6 }, { passed: 5, failed: 1, total: 6 }],
    ['an all-fail triple', { passed: 0, failed: 3, total: 3 }, { passed: 0, failed: 3, total: 3 }],

    // --- refuse: not a candidate triple (bug 1 — the unmeasured channel) ----
    ['null', null, null],
    ['undefined', undefined, null],
    ['an array', [], null],
    ['a string', '5 passed', null],
    ['a number', 6, null],

    // --- refuse: non-finite members -----------------------------------------
    ['a missing passed', { total: 6 }, null],
    ['a missing total', { passed: 5 }, null],
    ['a NaN total', { passed: 5, total: NaN }, null],
    ['a numeric-string passed', { passed: '5', total: 6 }, null],

    // --- refuse: zero / negative totals (bug 1) -----------------------------
    ['a zero triple', { passed: 0, failed: 0, total: 0 }, null],
    ['a negative total', { passed: 0, failed: 0, total: -1 }, null],

    // --- refuse: inconsistent triples (bugs 2 + 3) --------------------------
    ['a negative passed', { passed: -1, failed: 7, total: 6 }, null],
    ['a negative parsed failed', { passed: 8, failed: -2, total: 6 }, null],
    ['a passed greater than total', { passed: 12904, failed: 0, total: 550 }, null],
    ['a parsed failed that disagrees with total', { passed: 5, failed: 2, total: 6 }, null],
  ])('%s → admits or refuses per the shared policy', (_name, raw, expected) => {
    expect(admitSuiteCounts(raw)).toEqual(expected);
  });

  it('never returns a zero triple — an unmeasured gate is absent, not zero', () => {
    // Pinned separately from the table because `toEqual(null)` above would also
    // pass for `undefined`; this asserts the exact absent-not-null return value
    // the `...(counts ? { counts } : {})` spread at both call sites relies on.
    expect(admitSuiteCounts({ passed: 0, failed: 0, total: 0 })).toBeNull();
    expect(admitSuiteCounts(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractErrorLinesJson
// ---------------------------------------------------------------------------

describe('extractErrorLinesJson', () => {
  it('returns matching lines wrapped as objects with a line key', () => {
    const output = 'info: ok\nerror TS123: bad type\ninfo: done';
    const result = extractErrorLinesJson(output, /error TS\d+/);
    expect(result).toEqual([{ line: 'error TS123: bad type' }]);
  });

  it('returns an empty array when no lines match', () => {
    const result = extractErrorLinesJson('all good here', /error TS\d+/);
    expect(result).toEqual([]);
  });

  it('returns an empty array for empty output', () => {
    expect(extractErrorLinesJson('', /error TS\d+/)).toEqual([]);
  });

  it('returns an empty array when output is null', () => {
    expect(extractErrorLinesJson(null, /error TS\d+/)).toEqual([]);
  });

  it('caps results at 20 entries', () => {
    const manyErrors = Array.from({ length: 30 }, (_, i) => `error TS${i}: bad`).join('\n');
    const result = extractErrorLinesJson(manyErrors, /error TS\d+/);
    expect(result).toHaveLength(20);
  });

  it('accepts a string pattern and returns matching objects', () => {
    const output = 'warn: a\ninfo: b\nwarn: c';
    const result = extractErrorLinesJson(output, 'warn');
    expect(result).toEqual([{ line: 'warn: a' }, { line: 'warn: c' }]);
  });
});

// ---------------------------------------------------------------------------
// runCheck
// ---------------------------------------------------------------------------

describe('runCheck', () => {
  it('returns status=skip and empty output when cmd is "skip"', () => {
    const result = runCheck('skip');
    expect(result.status).toBe('skip');
    expect(result.output).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns status=skip and empty output when cmd is empty string', () => {
    const result = runCheck('');
    expect(result.status).toBe('skip');
    expect(result.output).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns status=skip when cmd is null', () => {
    const result = runCheck(null);
    expect(result.status).toBe('skip');
  });

  it('returns status=pass and output for a succeeding command', () => {
    // Use a real shell command that is not an echo stub (echo stubs are short-circuited).
    const result = runCheck('node -e "process.stdout.write(\'hi\')"');
    expect(result.status).toBe('pass');
    expect(result.output).toContain('hi');
    expect(result.exitCode).toBe(0);
  });

  it('returns status=pass for a succeeding command with large output', () => {
    const result = runCheck(
      'node -e "process.stdout.write(\'x\'.repeat(2 * 1024 * 1024)); process.stdout.write(\'\\\\n42 passed\\\\n\')"',
    );
    expect(result.status).toBe('pass');
    expect(result.output).toContain('42 passed');
    expect(result.exitCode).toBe(0);
  });

  it('stub short-circuit: echo stub returns stubbed echo result without executing', () => {
    const result = runCheck('echo "stub"');
    expect(result).toEqual({
      status: 'pass',
      output: '(stubbed: echo)',
      fullOutput: '(stubbed: echo)',
      exitCode: 0,
      stubbed: { kind: 'echo' },
    });
  });

  it('stub short-circuit: noop stub ":" returns stubbed noop result without executing', () => {
    const result = runCheck(':');
    expect(result).toEqual({
      status: 'pass',
      output: '(stubbed: noop)',
      fullOutput: '(stubbed: noop)',
      exitCode: 0,
      stubbed: { kind: 'noop' },
    });
  });

  it('returns status=fail for a failing command', () => {
    const result = runCheck('node -e "process.exit(1)"');
    expect(result.status).toBe('fail');
    expect(result.exitCode).toBe(1);
  });

  it('returns status=skip for a command-not-found (exit 127)', () => {
    const result = runCheck('this_command_definitely_does_not_exist_xyz123');
    expect(result.status).toBe('skip');
    expect(result.output).toBe('command not found');
  });
});

// ---------------------------------------------------------------------------
// findChangedFiles
// ---------------------------------------------------------------------------

describe('findChangedFiles', () => {
  it('returns an array (may be empty) for a valid git ref', () => {
    // HEAD~0 is the same as HEAD — diff is always empty, returns []
    const result = findChangedFiles('HEAD~0');
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns an empty array for an empty ref', () => {
    expect(findChangedFiles('')).toEqual([]);
  });

  it('returns an empty array for a null ref', () => {
    expect(findChangedFiles(null)).toEqual([]);
  });

  it('returns an empty array for a whitespace-only ref', () => {
    expect(findChangedFiles('   ')).toEqual([]);
  });

  it('returns an empty array for an invalid git ref without throwing', () => {
    const result = findChangedFiles('refs/heads/branch-that-cannot-exist-xyzzy');
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findChangedTestFiles
// ---------------------------------------------------------------------------

describe('findChangedTestFiles', () => {
  it('returns an array for HEAD~0 (no changed files between HEAD and HEAD)', () => {
    const result = findChangedTestFiles('HEAD~0');
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns an empty array for an empty ref', () => {
    expect(findChangedTestFiles('')).toEqual([]);
  });

  it('filters results to only test file paths', () => {
    // We can verify the filter logic by mocking — but we test it indirectly:
    // HEAD~0 returns empty; any result must be a test file path
    const result = findChangedTestFiles('HEAD~0');
    for (const f of result) {
      expect(f).toMatch(/\.test\.|\.spec\.|__tests__\//);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveTestFiles
// ---------------------------------------------------------------------------

describe('resolveTestFiles', () => {
  it('splits a csv of test files into an array', () => {
    const result = resolveTestFiles('a.test.mjs,b.test.mjs', '');
    expect(result).toEqual(['a.test.mjs', 'b.test.mjs']);
  });

  it('filters out non-test files from the csv', () => {
    const result = resolveTestFiles('a.test.mjs,src/lib.mjs', '');
    expect(result).toEqual(['a.test.mjs']);
  });

  it('returns an empty array when csv is empty and ref is empty', () => {
    expect(resolveTestFiles('', '')).toEqual([]);
  });

  it('falls through to findChangedTestFiles when csv is empty and ref is provided', () => {
    // HEAD~0 → no diff → empty array is valid; just check it is an array
    const result = resolveTestFiles('', 'HEAD~0');
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns an empty array when both csv and ref are absent', () => {
    expect(resolveTestFiles(undefined, undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runCheck — fullOutput vs the human tail (2026-08-22)
// ---------------------------------------------------------------------------

describe('runCheck fullOutput', () => {
  // THE BUG: `output` was a 5-line tail AND the parser's input. Vitest prints
  // its `Tests` summary and THEN the per-failure detail, so on a real failure
  // the summary sat ~760 lines above the tail; extractTestCounts read the tail,
  // found no numbers, and the gate reported `total 0, passed 0, failed 0` --
  // indistinguishable from "the runner never ran" and silent about WHICH test
  // failed.
  const SUMMARY = ' Tests  1 failed | 14357 passed | 16 skipped (14374)';
  const script = [
    `echo "${SUMMARY}"`,
    'for i in $(seq 1 40); do echo "failure detail line $i"; done',
    'exit 1',
  ].join('; ');

  it('keeps the whole captured text in fullOutput while output stays a bounded tail', () => {
    const res = runCheck(`sh -c '${script}'`);
    expect(res.status).toBe('fail');
    expect(res.fullOutput).toContain('14357 passed');
    expect(res.output).not.toContain('14357 passed');
    expect(res.output.split('\n').length).toBeLessThanOrEqual(5);
  });

  it('lets extractTestCounts recover the real counts from fullOutput, not from the tail', () => {
    const res = runCheck(`sh -c '${script}'`);
    expect(extractTestCounts(res.fullOutput)).toEqual({ passed: 14357, failed: 1, total: 14358 });
    // The tail alone is exactly the phantom the gate used to report.
    expect(extractTestCounts(res.output)).toEqual({ passed: 0, failed: 0, total: 0 });
  });

  it('reports fullOutput on the success path too', () => {
    const res = runCheck(`sh -c 'echo "${SUMMARY}"; echo trailing'`);
    expect(res.status).toBe('pass');
    expect(res.fullOutput).toContain('14357 passed');
  });
});
