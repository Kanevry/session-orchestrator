/**
 * tests/lib/test-runner/fingerprint.test.mjs
 *
 * Unit tests for scripts/lib/test-runner/fingerprint.mjs.
 *
 * Coverage:
 *   - fingerprintFinding: stability, discriminability, length invariant,
 *     canonical hardcoded value, type guards, unicode, long input,
 *     separator-separation proof.
 *
 * Expected hash values are pre-computed externally and hardcoded as literals.
 * No computation mirrors production logic (test-quality.md anti-pattern #3).
 */

import { describe, it, expect } from 'vitest';
import { fingerprintFinding } from '@lib/test-runner/fingerprint.mjs';

// ---------------------------------------------------------------------------
// Stability — same inputs always produce the same output
// ---------------------------------------------------------------------------

describe('fingerprintFinding — stability', () => {
  it('returns the same value on three successive calls with identical inputs', () => {
    const a = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn' });
    const b = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn' });
    const c = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns the hardcoded canonical value for the reference tuple', () => {
    // Pre-computed externally: node -e "import('./fingerprint.mjs').then(m =>
    //   console.log(m.fingerprintFinding({scope:'a11y',checkId:'wcag-2.1-aa',locator:'.btn'})))"
    // → d4f3b590194d027e
    // This test catches accidental algorithm changes (hash function swap, join separator change).
    expect(
      fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn' }),
    ).toBe('d4f3b590194d027e');
  });
});

// ---------------------------------------------------------------------------
// Discriminability — different inputs produce different outputs
// ---------------------------------------------------------------------------

describe('fingerprintFinding — discriminability', () => {
  it('produces different fingerprints when scope differs', () => {
    const base = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn' });
    const other = fingerprintFinding({ scope: 'color-contrast', checkId: 'wcag-2.1-aa', locator: '.btn' });
    expect(other).toBe('48502c44e99aaf71');
    expect(other).not.toBe(base);
  });

  it('produces different fingerprints when checkId differs', () => {
    const base = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn' });
    const other = fingerprintFinding({ scope: 'a11y', checkId: 'step-count', locator: '.btn' });
    expect(other).toBe('adb0cd016b965b51');
    expect(other).not.toBe(base);
  });

  it('produces different fingerprints when locator differs', () => {
    const base = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn' });
    const other = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '#main' });
    expect(other).toBe('85d26eb63a018d7f');
    expect(other).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Length invariant — output is always exactly 16 lowercase hex chars
// ---------------------------------------------------------------------------

describe('fingerprintFinding — length and format invariant', () => {
  it('output is exactly 16 characters long', () => {
    expect(
      fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn' }),
    ).toHaveLength(16);
  });

  it('output matches /^[0-9a-f]{16}$/ (lowercase hex only)', () => {
    const fp = fingerprintFinding({ scope: 'console', checkId: 'no-errors', locator: '*' });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Type guards — non-string args throw TypeError
// ---------------------------------------------------------------------------

describe('fingerprintFinding — type guards', () => {
  it('throws TypeError when scope is a number', () => {
    expect(() => fingerprintFinding({ scope: 42, checkId: 'id', locator: '.x' })).toThrow(TypeError);
  });

  it('throws TypeError when checkId is undefined', () => {
    expect(() => fingerprintFinding({ scope: 'a11y', checkId: undefined, locator: '.x' })).toThrow(TypeError);
  });

  it('throws TypeError when locator is null', () => {
    expect(() => fingerprintFinding({ scope: 'a11y', checkId: 'id', locator: null })).toThrow(TypeError);
  });

  it('thrown TypeError message mentions the field names', () => {
    let caught;
    try {
      fingerprintFinding({ scope: 42, checkId: 'id', locator: '.x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught.message).toContain('scope');
  });
});

// ---------------------------------------------------------------------------
// Unicode input — produces valid 16-char hex, differs from ASCII baseline
// ---------------------------------------------------------------------------

describe('fingerprintFinding — unicode locator', () => {
  it('returns a valid 16-char hex fingerprint for a unicode locator', () => {
    const fp = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn—ü' });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('unicode locator produces a different fingerprint from the ASCII baseline', () => {
    const ascii = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn' });
    const unicode = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: '.btn—ü' });
    // Pre-computed: be829af4c1a353a1
    expect(unicode).toBe('be829af4c1a353a1');
    expect(unicode).not.toBe(ascii);
  });
});

// ---------------------------------------------------------------------------
// Long locator — does not crash, returns 16-char hex
// ---------------------------------------------------------------------------

describe('fingerprintFinding — long locator', () => {
  it('does not throw for a 1000-character locator', () => {
    const longLocator = 'a'.repeat(1000);
    expect(() =>
      fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: longLocator }),
    ).not.toThrow();
  });

  it('returns a valid 16-char hex fingerprint for a 1000-character locator', () => {
    const longLocator = 'a'.repeat(1000);
    const fp = fingerprintFinding({ scope: 'a11y', checkId: 'wcag-2.1-aa', locator: longLocator });
    // Pre-computed: node --input-type=module -e "
    //   import { createHash } from 'node:crypto';
    //   const j = ['a11y','wcag-2.1-aa','a'.repeat(1000)].join('\n');
    //   console.log(createHash('sha256').update(j).digest('hex').slice(0,16));"
    // → 0fe479a86a7319f0
    expect(fp).toBe('0fe479a86a7319f0');
  });
});

// ---------------------------------------------------------------------------
// Separator separation — proves the \n join prevents cross-field collisions
// ---------------------------------------------------------------------------

describe('fingerprintFinding — separator separation', () => {
  it('(scope="ab", checkId="c") differs from (scope="a", checkId="bc") with same locator', () => {
    // Without a separator, both would join to "abc" + locator — identical.
    // With \n separator: "ab\nc\nd" vs "a\nbc\nd" — genuinely different strings.
    const fp1 = fingerprintFinding({ scope: 'ab', checkId: 'c', locator: 'd' });
    const fp2 = fingerprintFinding({ scope: 'a', checkId: 'bc', locator: 'd' });
    // Pre-computed values:
    expect(fp1).toBe('8c5c6b69ad2699d0');
    expect(fp2).toBe('19474d3d57394f6d');
    expect(fp1).not.toBe(fp2);
  });
});
