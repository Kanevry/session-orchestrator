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
