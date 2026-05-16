/**
 * tests/scripts/gates/gate-helpers.test.mjs
 *
 * Unit tests for scripts/lib/gates/gate-helpers.mjs
 */

import { describe, it, expect } from 'vitest';
import {
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
  it('splits a simple csv into an array of strings', () => {
    expect(csvToJsonArray('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('trims whitespace around each entry', () => {
    expect(csvToJsonArray(' a , b , c ')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for an empty string', () => {
    expect(csvToJsonArray('')).toEqual([]);
  });

  it('returns an empty array when the input is only whitespace', () => {
    expect(csvToJsonArray('   ')).toEqual([]);
  });

  it('returns an empty array when input is null', () => {
    expect(csvToJsonArray(null)).toEqual([]);
  });

  it('returns an empty array when input is undefined', () => {
    expect(csvToJsonArray(undefined)).toEqual([]);
  });

  it('filters out empty segments caused by trailing commas', () => {
    expect(csvToJsonArray('a,b,')).toEqual(['a', 'b']);
  });

  it('returns a single-element array for a single item with no commas', () => {
    expect(csvToJsonArray('only')).toEqual(['only']);
  });
});

// ---------------------------------------------------------------------------
// extractCount
// ---------------------------------------------------------------------------

describe('extractCount', () => {
  it('counts regex matches in output (single match)', () => {
    expect(extractCount('a\nerror TS123\nb', /error TS\d+/)).toBe(1);
  });

  it('counts multiple matches using a string pattern (adds g flag internally)', () => {
    // When given a string, extractCount creates /pattern/gi — enabling global matching.
    expect(extractCount('error TS100\nerror TS200\nerror TS300', 'error TS\\d+')).toBe(3);
  });

  it('returns 0 when there are no matches', () => {
    expect(extractCount('everything is fine', /error TS\d+/)).toBe(0);
  });

  it('returns 0 for empty output', () => {
    expect(extractCount('', /error TS\d+/)).toBe(0);
  });

  it('returns 0 when output is null', () => {
    expect(extractCount(null, /error TS\d+/)).toBe(0);
  });

  it('accepts a string pattern and still counts matches', () => {
    expect(extractCount('warn: something\nwarn: other', 'warn')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// extractTestCounts
// ---------------------------------------------------------------------------

describe('extractTestCounts', () => {
  it('parses passed and failed from vitest-style output', () => {
    expect(extractTestCounts('Tests: 5 passed, 2 failed')).toEqual({
      passed: 5,
      failed: 2,
      total: 7,
    });
  });

  it('returns passed=0 when "passed" is absent', () => {
    expect(extractTestCounts('Tests: 3 failed')).toEqual({
      passed: 0,
      failed: 3,
      total: 3,
    });
  });

  it('returns failed=0 when "failed" is absent', () => {
    expect(extractTestCounts('42 passed')).toEqual({
      passed: 42,
      failed: 0,
      total: 42,
    });
  });

  it('returns all zeros for empty output', () => {
    expect(extractTestCounts('')).toEqual({ passed: 0, failed: 0, total: 0 });
  });

  it('returns all zeros for null output', () => {
    expect(extractTestCounts(null)).toEqual({ passed: 0, failed: 0, total: 0 });
  });

  it('computes total as passed + failed', () => {
    const result = extractTestCounts('10 passed, 5 failed');
    expect(result.total).toBe(15);
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
    const result = runCheck('echo hi');
    expect(result.status).toBe('pass');
    expect(result.output).toContain('hi');
    expect(result.exitCode).toBe(0);
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
