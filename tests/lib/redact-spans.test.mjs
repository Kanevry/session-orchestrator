import { describe, it, expect } from 'vitest';
import { redactSpans } from '@lib/redact-spans.mjs';

/**
 * Contract tests for the shared overlap-safe span-redaction primitive (#974).
 * Exact output and marker counts catch prefix residue, doubled markers and
 * off-by-one splices in the shared helper used by secret-masker.
 * Scanner diagnostics now omit violation contents; its real no-echo contract
 * is tested in check-owner-leakage.test.mjs and the standalone husky suite.
 */

const M = '[REDACTED]';
const rx = (s, f = 'i') => new RegExp(s, f);
const markerCount = (s) => s.split(M).length - 1;

describe('redactSpans — overlap-safe merge', () => {
  it('merges two OVERLAPPING spans into exactly ONE marker (prefix collision, list order [short,long])', () => {
    // Bug caught: a naive per-pattern .replace() chain redacts `acme` first and leaks
    // the suffix residue `[REDACTED]-corp-secret`; a missing merge step emits two
    // nested markers. Both pass the existing suite's includes()-check.
    const out = redactSpans('x acme-corp-secret y', [rx('acme'), rx('acme-corp-secret')]);
    expect(out).toBe('x [REDACTED] y');
    expect(markerCount(out)).toBe(1);
  });

  it('produces the IDENTICAL result when the same spans are passed in REVERSE order', () => {
    // Bug caught: order-dependence. The order-independence invariant (Fix 2) is the
    // whole reason this primitive computes spans against the original string.
    const patterns = [rx('acme'), rx('acme-corp-secret')];
    const forward = redactSpans('x acme-corp-secret y', patterns);
    const reverse = redactSpans('x acme-corp-secret y', patterns.slice().reverse());
    expect(reverse).toBe(forward);
    expect(reverse).toBe('x [REDACTED] y');
  });

  it('collapses a span FULLY CONTAINED in another into ONE marker', () => {
    // Bug caught: a merge that only handles partial overlap (s <= last[1] but
    // e > last[1]) and forgets Math.max would truncate the enclosing span, splitting
    // one region into two markers and re-emitting the inner text.
    const out = redactSpans('aXbXc', [rx('XbX'), rx('b')]);
    expect(out).toBe('a[REDACTED]c');
    expect(markerCount(out)).toBe(1);
  });

  it('merges two spans that TOUCH at exactly one boundary into ONE marker', () => {
    // Bug caught: an off-by-one in the merge predicate. `s < last[1]` (instead of
    // `s <= last[1]`) leaves adjacent spans unmerged and emits `[REDACTED][REDACTED]`
    // — a doubled sentinel the existing includes()-check accepts as correct.
    const out = redactSpans('abcd', [rx('ab'), rx('cd')]);
    expect(out).toBe('[REDACTED]');
    expect(markerCount(out)).toBe(1);
  });

  it('redacts spans anchored at the START and the END of the string', () => {
    // Bug caught: an off-by-one in the splice prologue/epilogue — slice(cursor, s) with
    // a wrong bound eats or duplicates the boundary character when a span sits at
    // index 0 or runs to line.length.
    const out = redactSpans('acme MID acme', [rx('acme')]);
    expect(out).toBe('[REDACTED] MID [REDACTED]');
    expect(markerCount(out)).toBe(2);
  });
});

describe('redactSpans — pass-through paths', () => {
  // Byte-fidelity fixture built by CONCATENATION from explicit code units — never via
  // JSON.stringify, whose output cannot carry a raw control byte, so a pass-through
  // assert against a stringify-produced fixture could not bite (learnings-index:
  // "byte-for-byte pass-through asserts cannot bite on a JSON.stringify-produced fixture").
  const RAW_FIXTURE =
    'a' +
    String.fromCharCode(9, 0, 13, 10) + // TAB, NUL, CR, LF
    'b' +
    String.fromCharCode(160) + // NBSP
    'c' +
    String.fromCharCode(55357, 56832) + // astral surrogate pair
    'd';
  const EXPECTED_UNITS = [97, 9, 0, 13, 10, 98, 160, 99, 55357, 56832, 100];
  // NB: iterate by code UNIT (s.length), not via Array.from(s, …) — the string
  // iterator walks code POINTS and would collapse the surrogate pair, dropping the
  // trailing unit and making the comparison silently short.
  const codeUnits = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

  it.each([
    ['empty pattern list', []],
    ['patterns without matches', [rx('acme'), rx('nomatch')]],
  ])('preserves input code units for %s', (_case, patterns) => {
    const out = redactSpans(RAW_FIXTURE, patterns);
    expect(out).toBe(RAW_FIXTURE);
    expect(codeUnits(out)).toEqual(EXPECTED_UNITS);
  });

  it('TERMINATES on a zero-width pattern instead of spinning forever', { timeout: 2000 }, () => {
    // Bug caught: dropping the `g.lastIndex += 1` zero-width guard turns exec() into an
    // infinite loop. This runs as a BLOCKING .husky/pre-commit stage — a hang there
    // wedges every commit in the repo, and no assertion in the existing suite would
    // report it as a failure (the shard just never finishes).
    expect(redactSpans('abcabc', [rx('(?=a)')])).toBe('abcabc');
    expect(redactSpans('abcabc', [rx('')])).toBe('abcabc');
  });
});
