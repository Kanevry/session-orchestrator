/**
 * vault-mirror-quality.test.mjs — Unit tests for scripts/lib/config/vault-mirror-quality.mjs
 *
 * Tolerant parser for the top-level `vault-mirror:` YAML block, extracting the
 * nested `quality:` sub-block (PRD F1.2 / issue #504).
 *
 * Returns shape: `{ quality: { "min-narrative-chars": int, "min-confidence": float } }`.
 * Tolerant: malformed values silently fall back to defaults.
 *
 * Shape: one it.each table of {name, lines, expected}. Every row asserts the FULL
 * returned object, so a row that only meant to pin one key also pins that the
 * sibling key kept its default — the pair-of-tests-per-key shape this replaced
 * asserted one key each and could not catch cross-key contamination.
 */

import { describe, it, expect } from 'vitest';
import { _parseVaultMirrorQuality } from '@lib/config/vault-mirror-quality.mjs';

const DEFAULTS = {
  quality: {
    'min-narrative-chars': 400,
    'min-confidence': 0.5,
  },
};

const q = (chars, conf) => ({ quality: { 'min-narrative-chars': chars, 'min-confidence': conf } });

describe('_parseVaultMirrorQuality', () => {
  it.each([
    // --- defaults (block absent, empty, or unrelated) ---
    {
      name: 'returns all defaults when vault-mirror block is absent',
      lines: ['persistence: true', 'enforcement: warn', ''],
      expected: DEFAULTS,
    },
    {
      name: 'returns all defaults when block is present but empty (heading-only)',
      lines: ['vault-mirror:', '', 'next-section:', ''],
      expected: DEFAULTS,
    },
    {
      name: 'returns all defaults when block contains only unrelated keys',
      lines: ['vault-mirror:', '  other-key: value', ''],
      expected: DEFAULTS,
    },

    // --- single-key overrides (each row also pins the sibling default) ---
    {
      name: 'min-confidence: 0.7 overrides its default and leaves min-narrative-chars at 400',
      lines: ['vault-mirror:', '  quality:', '    min-confidence: 0.7', ''],
      expected: q(400, 0.7),
    },
    {
      name: 'min-narrative-chars: 999 overrides its default and leaves min-confidence at 0.5',
      lines: ['vault-mirror:', '  quality:', '    min-narrative-chars: 999', ''],
      expected: q(999, 0.5),
    },

    // --- malformed values fall back to defaults ---
    {
      name: 'falls back to default min-narrative-chars when value is non-numeric ("abc")',
      lines: ['vault-mirror:', '  quality:', '    min-narrative-chars: abc', ''],
      expected: DEFAULTS,
    },
    {
      name: 'falls back to default min-confidence when value is non-numeric ("xyz")',
      lines: ['vault-mirror:', '  quality:', '    min-confidence: xyz', ''],
      expected: DEFAULTS,
    },

    // --- min-confidence bounds [0.0, 1.0] ---
    {
      name: 'falls back to default 0.5 when min-confidence is negative (-0.1)',
      lines: ['vault-mirror:', '  quality:', '    min-confidence: -0.1', ''],
      expected: DEFAULTS,
    },
    {
      name: 'falls back to default 0.5 when min-confidence exceeds 1.0 (2.0)',
      lines: ['vault-mirror:', '  quality:', '    min-confidence: 2.0', ''],
      expected: DEFAULTS,
    },
    {
      name: 'accepts the boundary value 0.0',
      lines: ['vault-mirror:', '  quality:', '    min-confidence: 0.0', ''],
      expected: q(400, 0.0),
    },
    {
      name: 'accepts the boundary value 1.0',
      lines: ['vault-mirror:', '  quality:', '    min-confidence: 1.0', ''],
      expected: q(400, 1.0),
    },

    // --- block boundary detection ---
    {
      name: 'stops parsing at the next top-level key (first block wins)',
      lines: [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: 0.9',
        'next-section:',
        '  quality:',
        '    min-confidence: 0.1',
        '',
      ],
      expected: q(400, 0.9),
    },

    // --- inline comment stripping ---
    // NB: the value must differ from the default, or a parser that dropped the
    // whole line would still produce the expected number (assert-nothing).
    {
      name: 'strips inline YAML comments from min-confidence',
      lines: ['vault-mirror:', '  quality:', '    min-confidence: 0.9  # raised', ''],
      expected: q(400, 0.9),
    },
    {
      name: 'strips inline YAML comments from min-narrative-chars',
      lines: ['vault-mirror:', '  quality:', '    min-narrative-chars: 600  # raised', ''],
      expected: q(600, 0.5),
    },

    // --- full block ---
    {
      name: 'parses both fields together',
      lines: [
        'vault-mirror:',
        '  quality:',
        '    min-narrative-chars: 500',
        '    min-confidence: 0.8',
        '',
      ],
      expected: q(500, 0.8),
    },
  ])('$name', ({ lines, expected }) => {
    expect(_parseVaultMirrorQuality(lines.join('\n'))).toEqual(expected);
  });
});
