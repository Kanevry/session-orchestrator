/**
 * tests/lib/persona-panel/threshold.test.mjs
 *
 * Vitest tests for scripts/lib/persona-panel/threshold.mjs (issue #457).
 *
 * Covers the pure parseThreshold + thresholdMet contracts and the
 * InvalidThresholdError class. Per W1-D4 security guard M2:
 *   - Anchored regex, no back-tracking
 *   - M=0, M>N, N>20 all rejected
 *   - Malformed/empty/incomplete inputs all rejected
 *
 * Test list (12 tests):
 *   Accept:
 *     1. parseThreshold('5-of-6')   → {kind:'m-of-n', m:5, n:6}
 *     2. parseThreshold('3-of-3')   → {kind:'m-of-n', m:3, n:3}
 *     3. parseThreshold('all')      → {kind:'all'}
 *     4. parseThreshold('any')      → {kind:'any'}
 *   Reject (each throws InvalidThresholdError):
 *     5. parseThreshold('0-of-5')   — M=0
 *     6. parseThreshold('6-of-5')   — M>N
 *     7. parseThreshold('21-of-21') — N exceeds cap (_N_MAX=20)
 *     8. parseThreshold('abc')      — malformed
 *     9. parseThreshold('')         — empty
 *    10. parseThreshold('5-of-')    — incomplete
 *    11. parseThreshold('5/5')      — wrong separator
 *   thresholdMet:
 *    12. 5-of-6 with pass=5/total=6 → true; pass=4/total=6 → false
 *
 * Falsification check: removing parseThreshold/thresholdMet implementations
 * causes import or assertion failure in every test.
 */

import { describe, it, expect } from 'vitest';
import {
  parseThreshold,
  thresholdMet,
  InvalidThresholdError,
  _N_MAX,
} from '../../../scripts/lib/persona-panel/threshold.mjs';

// ---------------------------------------------------------------------------
// _N_MAX sanity (pins the cap so future drift surfaces explicitly)
// ---------------------------------------------------------------------------

describe('_N_MAX', () => {
  it('is the integer 20 (defense-in-depth cap)', () => {
    expect(_N_MAX).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// parseThreshold — accept
// ---------------------------------------------------------------------------

describe('parseThreshold — accepts valid spec', () => {
  it('parses "5-of-6" into {kind:"m-of-n", m:5, n:6}', () => {
    expect(parseThreshold('5-of-6')).toEqual({ kind: 'm-of-n', m: 5, n: 6 });
  });

  it('parses "3-of-3" into {kind:"m-of-n", m:3, n:3}', () => {
    expect(parseThreshold('3-of-3')).toEqual({ kind: 'm-of-n', m: 3, n: 3 });
  });

  it('parses "all" into {kind:"all"}', () => {
    expect(parseThreshold('all')).toEqual({ kind: 'all' });
  });

  it('parses "any" into {kind:"any"}', () => {
    expect(parseThreshold('any')).toEqual({ kind: 'any' });
  });
});

// ---------------------------------------------------------------------------
// parseThreshold — reject (InvalidThresholdError)
// ---------------------------------------------------------------------------

describe('parseThreshold — rejects invalid spec with InvalidThresholdError', () => {
  it.each([
    ['0-of-5'],
    ['6-of-5'],
    ['21-of-21'],
    ['abc'],
    [''],
    ['5-of-'],
    ['5/5'],
  ])('throws InvalidThresholdError for spec "%s"', (spec) => {
    expect(() => parseThreshold(spec)).toThrow(InvalidThresholdError);
  });
});

// ---------------------------------------------------------------------------
// thresholdMet
// ---------------------------------------------------------------------------

describe('thresholdMet — m-of-n', () => {
  it('returns true when pass-count meets m exactly (5 of 6, threshold 5-of-6)', () => {
    expect(
      thresholdMet({ kind: 'm-of-n', m: 5, n: 6 }, { pass: 5, total: 6 }),
    ).toBe(true);
  });

  it('returns false when pass-count is below m (4 of 6, threshold 5-of-6)', () => {
    expect(
      thresholdMet({ kind: 'm-of-n', m: 5, n: 6 }, { pass: 4, total: 6 }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseThreshold — non-string input guard (M2, #492)
//
// The post-#483-LOW-3 change added an explicit type guard at the top of
// parseThreshold (threshold.mjs L56-60): any non-string input throws
// InvalidThresholdError with the message "threshold spec must be a string
// (got <typeof>)". This is the intended defensive contract, NOT a bug — the
// tests below pin the ACTUAL current behaviour with hardcoded expectations.
//
// Note `typeof null === 'object'` and `typeof [] === 'object'` in JS, so the
// guard reports "got object" for null, arrays, and plain objects alike.
// ---------------------------------------------------------------------------

describe('parseThreshold — rejects non-string input with InvalidThresholdError (M2)', () => {
  it.each([
    [42],
    [0],
    [null],
    [undefined],
    [true],
    [false],
    [{ kind: 'all' }],
    [['5-of-6']],
  ])('throws InvalidThresholdError for non-string input %o', (input) => {
    expect(() => parseThreshold(input)).toThrow(InvalidThresholdError);
  });

  it('error message names the offending type as "number" for a numeric input', () => {
    expect(() => parseThreshold(5)).toThrow('threshold spec must be a string (got number)');
  });

  it('error message names the offending type as "object" for null (typeof null === "object")', () => {
    expect(() => parseThreshold(null)).toThrow('threshold spec must be a string (got object)');
  });

  it('error message names the offending type as "undefined" for undefined input', () => {
    expect(() => parseThreshold(undefined)).toThrow(
      'threshold spec must be a string (got undefined)',
    );
  });

  it('error message names the offending type as "object" for an array input', () => {
    expect(() => parseThreshold(['5-of-6'])).toThrow(
      'threshold spec must be a string (got object)',
    );
  });

  it('error message names the offending type as "boolean" for a boolean input', () => {
    expect(() => parseThreshold(true)).toThrow('threshold spec must be a string (got boolean)');
  });

  it('rejects numeric input via the type guard, not the empty/regex check (string coercion does NOT happen)', () => {
    // If the guard were missing and the value were coerced via String(6), it would
    // hit the regex path and produce a "must match M-of-N" message. The type-guard
    // message proves the non-string branch fired first.
    expect(() => parseThreshold(6)).toThrow('threshold spec must be a string (got number)');
  });
});

// ---------------------------------------------------------------------------
// parseThreshold — whitespace handling boundary (M2, #492)
//
// The guard trims before the empty check (L62-65). A whitespace-only string is
// a string (passes the type guard) but trims to '' → rejected as empty. A spec
// with surrounding whitespace trims to a valid token and parses successfully.
// These boundaries are uncovered by the existing accept/reject lists.
// ---------------------------------------------------------------------------

describe('parseThreshold — whitespace boundary (M2)', () => {
  it('rejects a whitespace-only string (trims to empty) with InvalidThresholdError', () => {
    expect(() => parseThreshold('   ')).toThrow(InvalidThresholdError);
  });

  it('whitespace-only string is rejected as empty, not as a non-string', () => {
    expect(() => parseThreshold('   ')).toThrow('threshold spec must not be empty');
  });

  it('parses "  all  " (surrounding whitespace trimmed) into {kind:"all"}', () => {
    expect(parseThreshold('  all  ')).toEqual({ kind: 'all' });
  });

  it('parses " 5-of-6 " (surrounding whitespace trimmed) into {kind:"m-of-n", m:5, n:6}', () => {
    expect(parseThreshold(' 5-of-6 ')).toEqual({ kind: 'm-of-n', m: 5, n: 6 });
  });
});
