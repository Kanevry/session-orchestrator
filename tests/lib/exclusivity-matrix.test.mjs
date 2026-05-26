/**
 * tests/lib/exclusivity-matrix.test.mjs
 *
 * Vitest suite for scripts/lib/exclusivity-matrix.mjs (#569 P1.1).
 *
 * Covers:
 *  - EXCLUSIVITY_MATRIX shape, exact member arrays, and deep-freeze invariant
 *  - classifyMode happy-path for all 10 documented modes (parameterised)
 *  - classifyMode whitespace-trim defensive behaviour
 *  - classifyMode error path: unknown modes, empty string, wrong casing
 *  - Error message content: includes the queried mode name and known-modes list
 */

import { describe, it, expect } from 'vitest';
import { EXCLUSIVITY_MATRIX, classifyMode } from '@lib/exclusivity-matrix.mjs';

// ---------------------------------------------------------------------------
// Group A — EXCLUSIVITY_MATRIX shape
// ---------------------------------------------------------------------------

describe('EXCLUSIVITY_MATRIX shape', () => {
  it('has exactly 3 top-level keys: exclusive, parallel-ok, always-ok', () => {
    expect(Object.keys(EXCLUSIVITY_MATRIX).sort()).toEqual([
      'always-ok',
      'exclusive',
      'parallel-ok',
    ]);
  });

  it('exclusive array equals [bootstrap, housekeeping, memory-cleanup]', () => {
    expect(EXCLUSIVITY_MATRIX.exclusive).toEqual([
      'bootstrap',
      'housekeeping',
      'memory-cleanup',
    ]);
  });

  it('parallel-ok array equals [deep, feature]', () => {
    expect(EXCLUSIVITY_MATRIX['parallel-ok']).toEqual(['deep', 'feature']);
  });

  it('always-ok array equals [discovery, evolve, plan, repo-audit, portfolio]', () => {
    expect(EXCLUSIVITY_MATRIX['always-ok']).toEqual([
      'discovery',
      'evolve',
      'plan',
      'repo-audit',
      'portfolio',
    ]);
  });

  it('top-level object is frozen', () => {
    expect(Object.isFrozen(EXCLUSIVITY_MATRIX)).toBe(true);
  });

  it('exclusive inner array is frozen', () => {
    expect(Object.isFrozen(EXCLUSIVITY_MATRIX.exclusive)).toBe(true);
  });

  it('parallel-ok inner array is frozen', () => {
    expect(Object.isFrozen(EXCLUSIVITY_MATRIX['parallel-ok'])).toBe(true);
  });

  it('always-ok inner array is frozen', () => {
    expect(Object.isFrozen(EXCLUSIVITY_MATRIX['always-ok'])).toBe(true);
  });

  it('mutating exclusive array throws TypeError', () => {
    expect(() => EXCLUSIVITY_MATRIX.exclusive.push('x')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Group B — classifyMode happy-path (parameterised, hardcoded fixture)
// ---------------------------------------------------------------------------

describe('classifyMode — happy path', () => {
  // Hardcoded fixture — values are NOT computed from EXCLUSIVITY_MATRIX.
  // This prevents tautological-computation bugs (test-quality.md §3).
  const MODE_FIXTURE = [
    ['bootstrap', 'exclusive'],
    ['housekeeping', 'exclusive'],
    ['memory-cleanup', 'exclusive'],
    ['deep', 'parallel-ok'],
    ['feature', 'parallel-ok'],
    ['discovery', 'always-ok'],
    ['evolve', 'always-ok'],
    ['plan', 'always-ok'],
    ['repo-audit', 'always-ok'],
    ['portfolio', 'always-ok'],
  ];

  it.each(MODE_FIXTURE)(
    'classifyMode("%s") returns "%s"',
    (mode, expectedClass) => {
      expect(classifyMode(mode)).toBe(expectedClass);
    },
  );

  it('trims leading/trailing whitespace before lookup', () => {
    expect(classifyMode('  deep  ')).toBe('parallel-ok');
  });

  it('trims leading whitespace before lookup (housekeeping)', () => {
    expect(classifyMode('  housekeeping')).toBe('exclusive');
  });
});

// ---------------------------------------------------------------------------
// Group C — classifyMode error path
// ---------------------------------------------------------------------------

describe('classifyMode — error path', () => {
  it('throws Error for a completely unknown mode', () => {
    expect(() => classifyMode('unknown-mode')).toThrow(Error);
  });

  it('error message starts with classifyMode: unknown mode "unknown-mode"', () => {
    let caughtMessage;
    try {
      classifyMode('unknown-mode');
    } catch (err) {
      caughtMessage = err.message;
    }
    expect(caughtMessage).toMatch(/^classifyMode: unknown mode "unknown-mode"/);
  });

  it('error message includes the queried unknown mode name verbatim', () => {
    let caughtMessage;
    try {
      classifyMode('nonexistent');
    } catch (err) {
      caughtMessage = err.message;
    }
    expect(caughtMessage).toContain('"nonexistent"');
  });

  it('error message includes bootstrap in the known-modes list', () => {
    let caughtMessage;
    try {
      classifyMode('bad-mode');
    } catch (err) {
      caughtMessage = err.message;
    }
    expect(caughtMessage).toContain('bootstrap');
  });

  it('error message includes housekeeping in the known-modes list', () => {
    let caughtMessage;
    try {
      classifyMode('bad-mode');
    } catch (err) {
      caughtMessage = err.message;
    }
    expect(caughtMessage).toContain('housekeeping');
  });

  it('throws for empty string after trim', () => {
    expect(() => classifyMode('')).toThrow(Error);
  });

  it('throws for whitespace-only string (trims to empty, unknown)', () => {
    expect(() => classifyMode('   ')).toThrow(Error);
  });

  it('throws for capital-D "Deep" — lookup is case-sensitive', () => {
    expect(() => classifyMode('Deep')).toThrow(Error);
  });

  it('throws for capital-H "Housekeeping" — lookup is case-sensitive', () => {
    expect(() => classifyMode('Housekeeping')).toThrow(Error);
  });

  it('throws for "DEEP" in all-caps — lookup is case-sensitive', () => {
    expect(() => classifyMode('DEEP')).toThrow(Error);
  });
});
