/**
 * vault-staleness.test.mjs — Unit tests for scripts/lib/config/vault-staleness.mjs
 *
 * Tolerant parser: no throws. Covers defaults, enabled flag, mode,
 * thresholds sub-block (top/active/archived), invalid/non-positive threshold
 * values are silently ignored, CRLF, inline comments, block boundary.
 */

import { describe, it, expect } from 'vitest';
import { _parseVaultStaleness } from '../../../scripts/lib/config/vault-staleness.mjs';

const DEFAULTS = {
  enabled: false,
  thresholds: { top: 30, active: 60, archived: 180 },
  mode: 'warn',
};

describe('_parseVaultStaleness', () => {
  describe('empty and missing block', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseVaultStaleness('')).toEqual(DEFAULTS);
    });

    it('returns all defaults when vault-staleness block is absent', () => {
      expect(_parseVaultStaleness('persistence: true\n')).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty', () => {
      const content = 'vault-staleness:\n\nnext-section:\n';
      expect(_parseVaultStaleness(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag', () => {
    it('parses enabled: true', () => {
      const content = 'vault-staleness:\n  enabled: true\n';
      expect(_parseVaultStaleness(content).enabled).toBe(true);
    });

    it('defaults to false when enabled is absent from block', () => {
      const content = 'vault-staleness:\n  mode: strict\n';
      expect(_parseVaultStaleness(content).enabled).toBe(false);
    });
  });

  describe('mode', () => {
    it('parses mode: strict', () => {
      const content = 'vault-staleness:\n  mode: strict\n';
      expect(_parseVaultStaleness(content).mode).toBe('strict');
    });

    it('parses mode: off', () => {
      const content = 'vault-staleness:\n  mode: off\n';
      expect(_parseVaultStaleness(content).mode).toBe('off');
    });

    it('silently defaults to "warn" on invalid mode', () => {
      const content = 'vault-staleness:\n  mode: invalid\n';
      expect(_parseVaultStaleness(content).mode).toBe('warn');
    });
  });

  describe('thresholds sub-block', () => {
    it('parses all three threshold values', () => {
      const content = [
        'vault-staleness:',
        '  thresholds:',
        '    top: 14',
        '    active: 30',
        '    archived: 90',
        '',
      ].join('\n');
      expect(_parseVaultStaleness(content).thresholds).toEqual({
        top: 14,
        active: 30,
        archived: 90,
      });
    });

    it('keeps default for missing threshold keys', () => {
      const content = 'vault-staleness:\n  thresholds:\n    top: 14\n';
      const result = _parseVaultStaleness(content);
      expect(result.thresholds.top).toBe(14);
      expect(result.thresholds.active).toBe(60);
      expect(result.thresholds.archived).toBe(180);
    });

    it('silently ignores non-positive threshold values', () => {
      const content = [
        'vault-staleness:',
        '  thresholds:',
        '    top: 0',
        '    active: -5',
        '    archived: 90',
        '',
      ].join('\n');
      const result = _parseVaultStaleness(content);
      // non-positive → keep defaults
      expect(result.thresholds.top).toBe(30);
      expect(result.thresholds.active).toBe(60);
      expect(result.thresholds.archived).toBe(90);
    });

    it('silently ignores non-numeric threshold values', () => {
      const content = 'vault-staleness:\n  thresholds:\n    top: invalid\n';
      const result = _parseVaultStaleness(content);
      expect(result.thresholds.top).toBe(30);
    });

    it('uses default thresholds when block is present but thresholds absent', () => {
      const content = 'vault-staleness:\n  enabled: true\n';
      expect(_parseVaultStaleness(content).thresholds).toEqual({
        top: 30,
        active: 60,
        archived: 180,
      });
    });
  });

  describe('CRLF tolerance and inline comments', () => {
    it('handles CRLF line endings', () => {
      const content =
        'vault-staleness:\r\n  enabled: true\r\n  mode: strict\r\n';
      const result = _parseVaultStaleness(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('strict');
    });

    it('strips inline YAML comments', () => {
      const content =
        'vault-staleness:\n  enabled: true  # opt-in\n  mode: warn  # default\n';
      const result = _parseVaultStaleness(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('warn');
    });
  });

  describe('block boundary', () => {
    it('stops parsing at next top-level key', () => {
      const content =
        'vault-staleness:\n  enabled: true\nother-section:\n  enabled: false\n';
      expect(_parseVaultStaleness(content).enabled).toBe(true);
    });
  });

  describe('full block', () => {
    it('parses all fields together', () => {
      const content = [
        'vault-staleness:',
        '  enabled: true',
        '  thresholds:',
        '    top: 14',
        '    active: 45',
        '    archived: 120',
        '  mode: strict',
        '',
      ].join('\n');
      expect(_parseVaultStaleness(content)).toEqual({
        enabled: true,
        thresholds: { top: 14, active: 45, archived: 120 },
        mode: 'strict',
      });
    });
  });
});
