/**
 * reconcile.test.mjs — Unit tests for scripts/lib/config/reconcile.mjs (FA4 #697).
 *
 * Covers _parseReconcile:
 *   - Defaults when the reconcile: block is absent
 *   - Explicit override parsing (enabled, mode, targets, rule-expiry-days, confidence-floor)
 *   - Tolerant parse: invalid mode / out-of-range confidence / non-numeric rule-expiry-days
 *     all fall back to their safe defaults
 *   - CRITICAL: rule-expiry-days absent → MUST be null (never a number) so the engine's
 *     per-type TTL fallback is preserved
 *
 * Style mirrors tests/lib/config/memory.test.mjs: direct content-string injection,
 * no filesystem access, fully synchronous. All expected values are hardcoded literals.
 */

import { describe, it, expect } from 'vitest';
import { _parseReconcile } from '@lib/config/reconcile.mjs';

// ---------------------------------------------------------------------------
// Hardcoded default shape — never recomputed from production logic
// ---------------------------------------------------------------------------

const DEFAULTS = {
  enabled: false,
  mode: 'warn',
  targets: ['repo-local'],
  'rule-expiry-days': null,
  'confidence-floor': 0.5,
};

// ---------------------------------------------------------------------------
// Defaults — block absent or empty
// ---------------------------------------------------------------------------

describe('_parseReconcile — defaults (block absent or empty)', () => {
  it('returns all defaults when reconcile: block is absent', () => {
    expect(_parseReconcile('persistence: true\nenforcement: warn\n')).toEqual(DEFAULTS);
  });

  it('returns all defaults on empty string', () => {
    expect(_parseReconcile('')).toEqual(DEFAULTS);
  });

  it('returns all defaults when reconcile: block header is present but body is empty', () => {
    const content = 'reconcile:\nnext-section: foo\n';
    expect(_parseReconcile(content)).toEqual(DEFAULTS);
  });

  it('CRITICAL: rule-expiry-days defaults to null — NOT a number', () => {
    const result = _parseReconcile('');
    // Must be strictly null so emitter.mjs falls back to per-type TTL
    expect(result['rule-expiry-days']).toBeNull();
    expect(result['rule-expiry-days']).not.toBeTypeOf('number');
  });
});

// ---------------------------------------------------------------------------
// Explicit overrides parse correctly
// ---------------------------------------------------------------------------

describe('_parseReconcile — explicit overrides', () => {
  it('parses enabled: true', () => {
    const content = 'reconcile:\n  enabled: true\n';
    const result = _parseReconcile(content);
    expect(result.enabled).toBe(true);
  });

  it('parses mode: off', () => {
    const content = 'reconcile:\n  mode: off\n';
    const result = _parseReconcile(content);
    expect(result.mode).toBe('off');
  });

  it('parses mode: warn', () => {
    const content = 'reconcile:\n  mode: warn\n';
    const result = _parseReconcile(content);
    expect(result.mode).toBe('warn');
  });

  it('parses rule-expiry-days: 30 as integer 30', () => {
    const content = 'reconcile:\n  rule-expiry-days: 30\n';
    const result = _parseReconcile(content);
    expect(result['rule-expiry-days']).toBe(30);
  });

  it('parses confidence-floor: 0.8', () => {
    const content = 'reconcile:\n  confidence-floor: 0.8\n';
    const result = _parseReconcile(content);
    expect(result['confidence-floor']).toBe(0.8);
  });

  it('parses targets inline list: [repo-local, global]', () => {
    const content = 'reconcile:\n  targets: [repo-local, global]\n';
    const result = _parseReconcile(content);
    expect(result.targets).toEqual(['repo-local', 'global']);
  });

  it('parses targets as a single unbracketed value', () => {
    const content = 'reconcile:\n  targets: repo-local\n';
    const result = _parseReconcile(content);
    expect(result.targets).toEqual(['repo-local']);
  });

  it('parses a full explicit block correctly', () => {
    const content = [
      'reconcile:',
      '  enabled: true',
      '  mode: off',
      '  targets: [repo-local]',
      '  rule-expiry-days: 60',
      '  confidence-floor: 0.75',
    ].join('\n') + '\n';

    const result = _parseReconcile(content);
    expect(result).toEqual({
      enabled: true,
      mode: 'off',
      targets: ['repo-local'],
      'rule-expiry-days': 60,
      'confidence-floor': 0.75,
    });
  });

  it('strips inline YAML comments from values', () => {
    const content = 'reconcile:\n  enabled: true  # opt-in for FA3\n  mode: warn  # advisory\n';
    const result = _parseReconcile(content);
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// Tolerant parse — invalid values fall back to safe defaults
// ---------------------------------------------------------------------------

describe('_parseReconcile — tolerant parse (invalid values → safe defaults)', () => {
  it('invalid mode falls back to "warn"', () => {
    const content = 'reconcile:\n  mode: invalid-mode\n';
    const result = _parseReconcile(content);
    expect(result.mode).toBe('warn');
  });

  it('mode: strict falls back to "warn" (only off|warn are valid)', () => {
    const content = 'reconcile:\n  mode: strict\n';
    const result = _parseReconcile(content);
    expect(result.mode).toBe('warn');
  });

  it('confidence-floor above 1.0 falls back to 0.5', () => {
    const content = 'reconcile:\n  confidence-floor: 1.5\n';
    const result = _parseReconcile(content);
    expect(result['confidence-floor']).toBe(0.5);
  });

  it('confidence-floor below 0.0 falls back to 0.5', () => {
    const content = 'reconcile:\n  confidence-floor: -0.1\n';
    const result = _parseReconcile(content);
    expect(result['confidence-floor']).toBe(0.5);
  });

  it('non-numeric confidence-floor falls back to 0.5', () => {
    const content = 'reconcile:\n  confidence-floor: not-a-number\n';
    const result = _parseReconcile(content);
    expect(result['confidence-floor']).toBe(0.5);
  });

  it('non-numeric rule-expiry-days falls back to null', () => {
    const content = 'reconcile:\n  rule-expiry-days: thirty\n';
    const result = _parseReconcile(content);
    expect(result['rule-expiry-days']).toBeNull();
  });

  it('rule-expiry-days: 0 (non-positive) falls back to null', () => {
    const content = 'reconcile:\n  rule-expiry-days: 0\n';
    const result = _parseReconcile(content);
    // 0 is not > 0 so the parser keeps null
    expect(result['rule-expiry-days']).toBeNull();
  });

  it('rule-expiry-days: null string produces null (not string "null")', () => {
    const content = 'reconcile:\n  rule-expiry-days: null\n';
    const result = _parseReconcile(content);
    expect(result['rule-expiry-days']).toBeNull();
  });

  it('enabled: anything-not-true stays false', () => {
    const content = 'reconcile:\n  enabled: yes\n';
    const result = _parseReconcile(content);
    // Only exact "true" flips the flag
    expect(result.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Boundary isolation — reconcile block does not bleed into sibling sections
// ---------------------------------------------------------------------------

describe('_parseReconcile — block boundary isolation', () => {
  it('stops parsing at the next top-level key after reconcile:', () => {
    const content = [
      'reconcile:',
      '  enabled: true',
      '  rule-expiry-days: 90',
      'memory:',
      '  banner:',
      '    enabled: false',
    ].join('\n') + '\n';

    const result = _parseReconcile(content);
    expect(result.enabled).toBe(true);
    expect(result['rule-expiry-days']).toBe(90);
    // The memory block's enabled:false must NOT leak into reconcile
  });

  it('ignores keys that appear before the reconcile: header', () => {
    const content = [
      'persistence: true',
      'enabled: true',  // this is NOT inside reconcile:
      'reconcile:',
      '  enabled: false',
    ].join('\n') + '\n';

    const result = _parseReconcile(content);
    // Must read the value from inside the reconcile: block
    expect(result.enabled).toBe(false);
  });
});
