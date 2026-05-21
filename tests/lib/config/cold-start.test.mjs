/**
 * cold-start.test.mjs — Unit tests for scripts/lib/config/cold-start.mjs
 *
 * Tolerant parser for the top-level `cold-start:` YAML block (PRD F1.3 / #500).
 * Covers defaults, enabled flag flip, malformed integer fallback, inline
 * comment stripping, and block boundary detection.
 *
 * Mirrors the style of tests/lib/config/vault-staleness.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { _parseColdStart } from '@lib/config/cold-start.mjs';

const DEFAULTS = {
  enabled: true,
  'nudge-after-hours': 1,
  'silence-after-sessions': 1,
};

describe('_parseColdStart', () => {
  describe('defaults (block absent or empty)', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseColdStart('')).toEqual(DEFAULTS);
    });

    it('returns all defaults when cold-start block is absent', () => {
      const content = 'persistence: true\nenforcement: warn\n';
      expect(_parseColdStart(content)).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty', () => {
      const content = 'cold-start:\n\nnext-section:\n';
      expect(_parseColdStart(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag flip', () => {
    it('flips enabled to false on explicit "false"', () => {
      const content = 'cold-start:\n  enabled: false\n';
      expect(_parseColdStart(content).enabled).toBe(false);
    });

    it('keeps enabled true on explicit "true"', () => {
      const content = 'cold-start:\n  enabled: true\n';
      expect(_parseColdStart(content).enabled).toBe(true);
    });

    it('keeps default enabled=true when key absent from non-empty block', () => {
      const content = 'cold-start:\n  nudge-after-hours: 5\n';
      expect(_parseColdStart(content).enabled).toBe(true);
    });
  });

  describe('malformed values fall back to defaults', () => {
    it('falls back to default nudge-after-hours when value is non-numeric', () => {
      const content = 'cold-start:\n  nudge-after-hours: abc\n';
      expect(_parseColdStart(content)['nudge-after-hours']).toBe(1);
    });

    it('falls back to default silence-after-sessions when value is non-numeric', () => {
      const content = 'cold-start:\n  silence-after-sessions: abc\n';
      expect(_parseColdStart(content)['silence-after-sessions']).toBe(1);
    });

    it('falls back to default when value is a negative integer', () => {
      // The /^\d+$/ regex rejects leading '-', so the parser leaves the
      // default in place. Verifies the regex guard does its job.
      const content = 'cold-start:\n  nudge-after-hours: -5\n';
      expect(_parseColdStart(content)['nudge-after-hours']).toBe(1);
    });

    it('accepts zero as a valid integer value', () => {
      const content = 'cold-start:\n  nudge-after-hours: 0\n';
      expect(_parseColdStart(content)['nudge-after-hours']).toBe(0);
    });

    it('parses valid integer overrides', () => {
      const content = [
        'cold-start:',
        '  enabled: true',
        '  nudge-after-hours: 12',
        '  silence-after-sessions: 3',
        '',
      ].join('\n');
      expect(_parseColdStart(content)).toEqual({
        enabled: true,
        'nudge-after-hours': 12,
        'silence-after-sessions': 3,
      });
    });
  });

  describe('inline comments + CRLF tolerance', () => {
    it('strips inline YAML comments', () => {
      const content = [
        'cold-start:',
        '  enabled: false  # opt-out of nudge',
        '  nudge-after-hours: 24  # 1 day',
        '',
      ].join('\n');
      const result = _parseColdStart(content);
      expect(result.enabled).toBe(false);
      expect(result['nudge-after-hours']).toBe(24);
    });

    it('handles CRLF line endings', () => {
      const content =
        'cold-start:\r\n  enabled: false\r\n  silence-after-sessions: 2\r\n';
      const result = _parseColdStart(content);
      expect(result.enabled).toBe(false);
      expect(result['silence-after-sessions']).toBe(2);
    });
  });

  describe('block boundary detection', () => {
    it('stops parsing at the next top-level key', () => {
      // The `enabled: true` after `other-section:` must NOT leak back into
      // cold-start. Block boundary = first non-indented non-empty line.
      const content = [
        'cold-start:',
        '  enabled: false',
        'other-section:',
        '  enabled: true',
        '',
      ].join('\n');
      expect(_parseColdStart(content).enabled).toBe(false);
    });

    it('ignores cold-start-like text outside the block', () => {
      // A `cold-start:` token nested inside another block (indented) is not
      // a block start. The parser only matches `^cold-start:\s*$` at column 0.
      const content = [
        'persistence: true',
        'enforcement: warn',
        '',
      ].join('\n');
      expect(_parseColdStart(content)).toEqual(DEFAULTS);
    });
  });
});
