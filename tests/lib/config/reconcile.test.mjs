/**
 * reconcile.test.mjs — Unit tests for scripts/lib/config/reconcile.mjs (FA4 #697).
 *
 * Covers _parseReconcile:
 *   - Defaults when the reconcile: block is absent
 *   - Explicit override parsing (enabled, mode, targets, rule-expiry-days, confidence-floor,
 *     min-rule-days, min-insight-chars, max-proposals-per-run)
 *   - Tolerant parse: invalid mode / out-of-range confidence / non-numeric rule-expiry-days /
 *     malformed or non-positive min-rule-days / malformed or negative min-insight-chars
 *     all fall back to their safe defaults
 *   - CRITICAL: rule-expiry-days absent → MUST be null (never a number) so the engine's
 *     per-type TTL fallback is preserved. `toEqual` against the hardcoded DEFAULTS below
 *     pins this on EVERY row (toEqual distinguishes null from undefined and from 0).
 *   - Block boundary isolation
 *
 * Shape: one it.each table of {why, content, expected}, every row asserting the FULL
 * parsed object. The per-key `it` blocks this replaced asserted one key each, so none
 * of them could catch a parse of key A corrupting key B.
 * All expected values are hardcoded literals; no filesystem access, fully synchronous.
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
  'min-rule-days': 7,
  'min-insight-chars': 24,
  'max-proposals-per-run': 10,
};

const withDefaults = (overrides) => ({ ...DEFAULTS, ...overrides });
const block = (...lines) => ['reconcile:', ...lines].join('\n') + '\n';

describe('_parseReconcile', () => {
  it.each([
    // ── Defaults — block absent or empty ─────────────────────────────────────
    {
      why: 'returns all defaults when the reconcile: block is absent',
      content: 'persistence: true\nenforcement: warn\n',
      expected: DEFAULTS,
    },
    {
      why: 'returns all defaults on empty string (incl. rule-expiry-days === null)',
      content: '',
      expected: DEFAULTS,
    },
    {
      why: 'returns all defaults when the header is present but the body is empty',
      content: 'reconcile:\nnext-section: foo\n',
      expected: DEFAULTS,
    },

    // ── Explicit overrides ───────────────────────────────────────────────────
    { why: 'parses enabled: true', content: block('  enabled: true'), expected: withDefaults({ enabled: true }) },
    { why: 'parses mode: off', content: block('  mode: off'), expected: withDefaults({ mode: 'off' }) },
    { why: 'parses mode: warn', content: block('  mode: warn'), expected: withDefaults({ mode: 'warn' }) },
    { why: 'parses rule-expiry-days: 30 as integer 30', content: block('  rule-expiry-days: 30'), expected: withDefaults({ 'rule-expiry-days': 30 }) },
    { why: 'parses confidence-floor: 0.8', content: block('  confidence-floor: 0.8'), expected: withDefaults({ 'confidence-floor': 0.8 }) },
    { why: 'parses targets inline list [repo-local, global]', content: block('  targets: [repo-local, global]'), expected: withDefaults({ targets: ['repo-local', 'global'] }) },
    { why: 'parses targets as a single unbracketed value', content: block('  targets: repo-local'), expected: withDefaults({ targets: ['repo-local'] }) },
    { why: 'parses min-rule-days: 14 as integer 14', content: block('  min-rule-days: 14'), expected: withDefaults({ 'min-rule-days': 14 }) },
    { why: 'parses min-insight-chars: 40 as integer 40', content: block('  min-insight-chars: 40'), expected: withDefaults({ 'min-insight-chars': 40 }) },
    // 0 is an explicit opt-out, NOT a malformed value — must survive the >0 guard
    { why: 'parses min-insight-chars: 0 as integer 0 (explicit opt-out)', content: block('  min-insight-chars: 0'), expected: withDefaults({ 'min-insight-chars': 0 }) },
    {
      why: 'parses a full explicit block correctly',
      content: block(
        '  enabled: true',
        '  mode: off',
        '  targets: [repo-local]',
        '  rule-expiry-days: 60',
        '  confidence-floor: 0.75',
        '  min-rule-days: 14',
        '  min-insight-chars: 40',
        '  max-proposals-per-run: 5',
      ),
      expected: {
        enabled: true,
        mode: 'off',
        targets: ['repo-local'],
        'rule-expiry-days': 60,
        'confidence-floor': 0.75,
        'min-rule-days': 14,
        'min-insight-chars': 40,
        'max-proposals-per-run': 5,
      },
    },
    // NB: `mode: off` (not warn) so the comment-stripping assertion bites — a
    // commented `mode: warn` equals the default and would pass unstripped.
    {
      why: 'strips inline YAML comments from values',
      content: block('  enabled: true  # opt-in for FA3', '  mode: off  # advisory'),
      expected: withDefaults({ enabled: true, mode: 'off' }),
    },

    // ── Tolerant parse — invalid values fall back to safe defaults ────────────
    { why: 'invalid mode falls back to "warn"', content: block('  mode: invalid-mode'), expected: DEFAULTS },
    { why: 'mode: strict falls back to "warn" (only off|warn are valid)', content: block('  mode: strict'), expected: DEFAULTS },
    { why: 'confidence-floor above 1.0 falls back to 0.5', content: block('  confidence-floor: 1.5'), expected: DEFAULTS },
    { why: 'confidence-floor below 0.0 falls back to 0.5', content: block('  confidence-floor: -0.1'), expected: DEFAULTS },
    { why: 'non-numeric confidence-floor falls back to 0.5', content: block('  confidence-floor: not-a-number'), expected: DEFAULTS },
    { why: 'non-numeric rule-expiry-days falls back to null', content: block('  rule-expiry-days: thirty'), expected: DEFAULTS },
    // 0 is not > 0, so the parser keeps null and the per-type TTL fallback survives
    { why: 'rule-expiry-days: 0 (non-positive) falls back to null', content: block('  rule-expiry-days: 0'), expected: DEFAULTS },
    { why: 'rule-expiry-days: null yields null, not the string "null"', content: block('  rule-expiry-days: null'), expected: DEFAULTS },
    // Only the exact literal "true" flips the flag — "yes" must not
    { why: 'enabled: anything-not-true stays false', content: block('  enabled: yes'), expected: DEFAULTS },
    { why: 'non-numeric min-rule-days falls back to default 7', content: block('  min-rule-days: two-weeks'), expected: DEFAULTS },
    { why: 'min-rule-days: 0 (non-positive) falls back to default 7', content: block('  min-rule-days: 0'), expected: DEFAULTS },
    { why: 'negative min-rule-days falls back to default 7', content: block('  min-rule-days: -5'), expected: DEFAULTS },
    { why: 'non-numeric min-insight-chars falls back to default 24', content: block('  min-insight-chars: lots'), expected: DEFAULTS },
    { why: 'negative min-insight-chars falls back to default 24', content: block('  min-insight-chars: -10'), expected: DEFAULTS },

    // ── Block boundary isolation ─────────────────────────────────────────────
    // The memory: block's enabled:false must NOT leak into reconcile — and the
    // full-object assertion additionally pins that memory's nested keys leak nowhere.
    {
      why: 'stops parsing at the next top-level key after reconcile:',
      content: block('  enabled: true', '  rule-expiry-days: 90') + 'memory:\n  banner:\n    enabled: false\n',
      expected: withDefaults({ enabled: true, 'rule-expiry-days': 90 }),
    },
    {
      why: 'ignores keys that appear before the reconcile: header',
      // the pre-header `enabled: true` is NOT inside reconcile:; a leak would flip enabled
      content: 'persistence: true\nenabled: true\n' + block('  enabled: false'),
      expected: DEFAULTS,
    },
  ])('$why', ({ content, expected }) => {
    expect(_parseReconcile(content)).toEqual(expected);
  });
});
