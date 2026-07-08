/**
 * docs-staleness.test.mjs — Unit tests for scripts/lib/config/docs-staleness.mjs
 *
 * Tolerant parser: no throws. Covers defaults, enabled flag, mode, the
 * single `living` threshold sub-key, invalid/non-positive threshold values
 * are silently ignored, CRLF, inline comments, block boundary.
 */

import { describe, it, expect } from 'vitest';
import { _parseDocsStaleness } from '@lib/config/docs-staleness.mjs';

const DEFAULTS = {
  enabled: false,
  thresholds: { living: 90 },
  mode: 'warn',
};

describe('_parseDocsStaleness', () => {
  describe('empty and missing block', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseDocsStaleness('')).toEqual(DEFAULTS);
    });

    it('returns all defaults when docs-staleness block is absent', () => {
      expect(_parseDocsStaleness('persistence: true\n')).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty', () => {
      const content = 'docs-staleness:\n\nnext-section:\n';
      expect(_parseDocsStaleness(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag', () => {
    it('parses enabled: true', () => {
      const content = 'docs-staleness:\n  enabled: true\n';
      expect(_parseDocsStaleness(content).enabled).toBe(true);
    });

    it('defaults to false when enabled is absent from block', () => {
      const content = 'docs-staleness:\n  mode: strict\n';
      expect(_parseDocsStaleness(content).enabled).toBe(false);
    });
  });

  describe('mode', () => {
    it('parses mode: strict', () => {
      const content = 'docs-staleness:\n  mode: strict\n';
      expect(_parseDocsStaleness(content).mode).toBe('strict');
    });

    it('parses mode: off', () => {
      const content = 'docs-staleness:\n  mode: off\n';
      expect(_parseDocsStaleness(content).mode).toBe('off');
    });

    it('silently defaults to "warn" on invalid mode', () => {
      const content = 'docs-staleness:\n  mode: invalid\n';
      expect(_parseDocsStaleness(content).mode).toBe('warn');
    });
  });

  describe('thresholds sub-block', () => {
    it('parses the living threshold value', () => {
      const content = ['docs-staleness:', '  thresholds:', '    living: 30', ''].join('\n');
      expect(_parseDocsStaleness(content).thresholds).toEqual({ living: 30 });
    });

    it('keeps default for missing living key', () => {
      const content = 'docs-staleness:\n  thresholds:\n    unrelated: 14\n';
      const result = _parseDocsStaleness(content);
      expect(result.thresholds.living).toBe(90);
    });

    it('silently ignores non-positive living threshold values', () => {
      const content = ['docs-staleness:', '  thresholds:', '    living: 0', ''].join('\n');
      const result = _parseDocsStaleness(content);
      expect(result.thresholds.living).toBe(90);
    });

    it('silently ignores negative living threshold values', () => {
      const content = ['docs-staleness:', '  thresholds:', '    living: -5', ''].join('\n');
      const result = _parseDocsStaleness(content);
      expect(result.thresholds.living).toBe(90);
    });

    it('silently ignores non-numeric living threshold values', () => {
      const content = 'docs-staleness:\n  thresholds:\n    living: invalid\n';
      const result = _parseDocsStaleness(content);
      expect(result.thresholds.living).toBe(90);
    });

    it('uses default threshold when block is present but thresholds absent', () => {
      const content = 'docs-staleness:\n  enabled: true\n';
      expect(_parseDocsStaleness(content).thresholds).toEqual({ living: 90 });
    });
  });

  describe('CRLF tolerance and inline comments', () => {
    it('handles CRLF line endings', () => {
      const content = 'docs-staleness:\r\n  enabled: true\r\n  mode: strict\r\n';
      const result = _parseDocsStaleness(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('strict');
    });

    it('strips inline YAML comments', () => {
      const content = 'docs-staleness:\n  enabled: true  # opt-in\n  mode: warn  # default\n';
      const result = _parseDocsStaleness(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('warn');
    });
  });

  describe('block boundary', () => {
    it('stops parsing at next top-level key', () => {
      const content = 'docs-staleness:\n  enabled: true\nother-section:\n  enabled: false\n';
      expect(_parseDocsStaleness(content).enabled).toBe(true);
    });
  });

  describe('full block', () => {
    it('parses all fields together', () => {
      const content = [
        'docs-staleness:',
        '  enabled: true',
        '  thresholds:',
        '    living: 45',
        '  mode: strict',
        '',
      ].join('\n');
      expect(_parseDocsStaleness(content)).toEqual({
        enabled: true,
        thresholds: { living: 45 },
        mode: 'strict',
      });
    });
  });
});
