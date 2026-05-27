/**
 * auto-dream.test.mjs — Unit tests for scripts/lib/config/auto-dream.mjs
 *
 * Tolerant parser for the top-level `auto-dream:` YAML block (issue #566).
 * Covers defaults, float-range validation (0.0..1.0 inclusive), malformed
 * value fallback, inline comment stripping, CRLF tolerance, quoted values,
 * and block boundary detection.
 *
 * Mirrors the style of tests/lib/config/cold-start.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { _parseAutoDream } from '@lib/config/auto-dream.mjs';

const DEFAULTS = {
  'min-confidence': 0.5,
};

describe('_parseAutoDream', () => {
  describe('defaults (block absent or empty)', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseAutoDream('')).toEqual(DEFAULTS);
    });

    it('returns all defaults when auto-dream block is absent', () => {
      const content = 'persistence: true\nenforcement: warn\n';
      expect(_parseAutoDream(content)).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty', () => {
      const content = 'auto-dream:\n\nnext-section:\n';
      expect(_parseAutoDream(content)).toEqual(DEFAULTS);
    });
  });

  describe('valid min-confidence overrides', () => {
    it('parses a typical override (0.6)', () => {
      const content = 'auto-dream:\n  min-confidence: 0.6\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.6);
    });

    it('parses a higher floor (0.8)', () => {
      const content = 'auto-dream:\n  min-confidence: 0.8\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.8);
    });

    it('accepts integer 0 (boundary low)', () => {
      const content = 'auto-dream:\n  min-confidence: 0\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0);
    });

    it('accepts float 0.0 (explicit boundary low)', () => {
      const content = 'auto-dream:\n  min-confidence: 0.0\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.0);
    });

    it('accepts integer 1 (boundary high)', () => {
      const content = 'auto-dream:\n  min-confidence: 1\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(1);
    });

    it('accepts float 1.0 (explicit boundary high)', () => {
      const content = 'auto-dream:\n  min-confidence: 1.0\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(1.0);
    });
  });

  describe('malformed values fall back to default', () => {
    it('falls back when value is non-numeric', () => {
      const content = 'auto-dream:\n  min-confidence: abc\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.5);
    });

    it('falls back when value is empty', () => {
      const content = 'auto-dream:\n  min-confidence:\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.5);
    });

    it('falls back when value is above 1.0', () => {
      // The float-range guard in vault-mirror-quality.mjs:69-73 rejects f > 1.0.
      const content = 'auto-dream:\n  min-confidence: 1.5\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.5);
    });

    it('falls back when value is negative', () => {
      // The /^\d+(\.\d+)?$/ regex rejects leading '-', so the parser leaves
      // the default in place.
      const content = 'auto-dream:\n  min-confidence: -0.1\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.5);
    });

    it('falls back when value has scientific notation (not allowed by regex)', () => {
      // The regex /^\d+(\.\d+)?$/ excludes '1e-1' and similar — defensive
      // against value-shape surprises.
      const content = 'auto-dream:\n  min-confidence: 1e-1\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.5);
    });
  });

  describe('inline comments + CRLF tolerance + quoted values', () => {
    it('strips inline YAML comments', () => {
      const content = [
        'auto-dream:',
        '  min-confidence: 0.7  # raise the bar',
        '',
      ].join('\n');
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.7);
    });

    it('handles CRLF line endings', () => {
      const content = 'auto-dream:\r\n  min-confidence: 0.4\r\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.4);
    });

    it('strips surrounding double quotes from value', () => {
      const content = 'auto-dream:\n  min-confidence: "0.6"\n';
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.6);
    });

    it('strips surrounding single quotes from value', () => {
      const content = "auto-dream:\n  min-confidence: '0.6'\n";
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.6);
    });
  });

  describe('block boundary detection', () => {
    it('stops parsing at the next top-level key', () => {
      // The `min-confidence: 0.9` after `other-section:` must NOT leak back
      // into auto-dream. Block boundary = first non-indented non-empty line.
      const content = [
        'auto-dream:',
        '  min-confidence: 0.3',
        'other-section:',
        '  min-confidence: 0.9',
        '',
      ].join('\n');
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.3);
    });

    it('ignores auto-dream-like text outside the block', () => {
      // A non-matching prefix at column 0 should not start the block.
      const content = [
        'persistence: true',
        'enforcement: warn',
        '',
      ].join('\n');
      expect(_parseAutoDream(content)).toEqual(DEFAULTS);
    });

    it('only matches `^auto-dream:\\s*$` at column 0', () => {
      // Indented `auto-dream:` (nested under another key) is not a block start.
      const content = [
        'other:',
        '  auto-dream:',
        '    min-confidence: 0.9',
        '',
      ].join('\n');
      expect(_parseAutoDream(content)).toEqual(DEFAULTS);
    });

    it('ignores unknown keys inside the block', () => {
      // An unrelated key inside the block must NOT influence the default.
      const content = [
        'auto-dream:',
        '  unknown-key: 0.9',
        '  min-confidence: 0.4',
        '',
      ].join('\n');
      expect(_parseAutoDream(content)['min-confidence']).toBe(0.4);
    });
  });
});
