/**
 * events-rotation.test.mjs — Unit tests for scripts/lib/config/events-rotation.mjs
 *
 * NOTE: this tests the CONFIG PARSER at scripts/lib/config/events-rotation.mjs,
 * NOT the top-level rotation engine.
 *
 * Tolerant parser: no throws. Out-of-range values silently fall back to defaults.
 * Covers: defaults, enabled flag, max-size-mb bounds (1..1024), max-backups
 * bounds (1..20), out-of-range silently ignored, CRLF, inline comments.
 */

import { describe, it, expect } from 'vitest';
import { _parseEventsRotation } from '../../../scripts/lib/config/events-rotation.mjs';

const DEFAULTS = {
  enabled: true,
  'max-size-mb': 10,
  'max-backups': 5,
};

describe('_parseEventsRotation', () => {
  describe('empty and missing block', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseEventsRotation('')).toEqual(DEFAULTS);
    });

    it('returns all defaults when events-rotation block is absent', () => {
      expect(_parseEventsRotation('persistence: true\n')).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty', () => {
      const content = 'events-rotation:\n\nnext-section:\n';
      expect(_parseEventsRotation(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag', () => {
    it('defaults to true when not specified', () => {
      const content = 'events-rotation:\n  max-size-mb: 5\n';
      expect(_parseEventsRotation(content).enabled).toBe(true);
    });

    it('parses enabled: false', () => {
      const content = 'events-rotation:\n  enabled: false\n';
      expect(_parseEventsRotation(content).enabled).toBe(false);
    });

    it('treats any value other than "false" as enabled (true by default)', () => {
      const content = 'events-rotation:\n  enabled: TRUE\n';
      // "TRUE".toLowerCase() !== "false" → enabled remains true
      expect(_parseEventsRotation(content).enabled).toBe(true);
    });
  });

  describe('max-size-mb bounds (1..1024)', () => {
    it('parses a valid max-size-mb of 5', () => {
      const content = 'events-rotation:\n  max-size-mb: 5\n';
      expect(_parseEventsRotation(content)['max-size-mb']).toBe(5);
    });

    it('parses the minimum valid value of 1', () => {
      const content = 'events-rotation:\n  max-size-mb: 1\n';
      expect(_parseEventsRotation(content)['max-size-mb']).toBe(1);
    });

    it('parses the maximum valid value of 1024', () => {
      const content = 'events-rotation:\n  max-size-mb: 1024\n';
      expect(_parseEventsRotation(content)['max-size-mb']).toBe(1024);
    });

    it('silently ignores value 0 (below minimum), keeping default 10', () => {
      const content = 'events-rotation:\n  max-size-mb: 0\n';
      expect(_parseEventsRotation(content)['max-size-mb']).toBe(10);
    });

    it('silently ignores value 1025 (above maximum), keeping default 10', () => {
      const content = 'events-rotation:\n  max-size-mb: 1025\n';
      expect(_parseEventsRotation(content)['max-size-mb']).toBe(10);
    });

    it('silently ignores non-digit value for max-size-mb', () => {
      const content = 'events-rotation:\n  max-size-mb: large\n';
      expect(_parseEventsRotation(content)['max-size-mb']).toBe(10);
    });
  });

  describe('max-backups bounds (1..20)', () => {
    it('parses a valid max-backups of 3', () => {
      const content = 'events-rotation:\n  max-backups: 3\n';
      expect(_parseEventsRotation(content)['max-backups']).toBe(3);
    });

    it('parses the minimum valid value of 1', () => {
      const content = 'events-rotation:\n  max-backups: 1\n';
      expect(_parseEventsRotation(content)['max-backups']).toBe(1);
    });

    it('parses the maximum valid value of 20', () => {
      const content = 'events-rotation:\n  max-backups: 20\n';
      expect(_parseEventsRotation(content)['max-backups']).toBe(20);
    });

    it('silently ignores value 0 (below minimum), keeping default 5', () => {
      const content = 'events-rotation:\n  max-backups: 0\n';
      expect(_parseEventsRotation(content)['max-backups']).toBe(5);
    });

    it('silently ignores value 21 (above maximum), keeping default 5', () => {
      const content = 'events-rotation:\n  max-backups: 21\n';
      expect(_parseEventsRotation(content)['max-backups']).toBe(5);
    });

    it('silently ignores non-digit value for max-backups', () => {
      const content = 'events-rotation:\n  max-backups: many\n';
      expect(_parseEventsRotation(content)['max-backups']).toBe(5);
    });
  });

  describe('CRLF tolerance and inline comments', () => {
    it('handles CRLF line endings', () => {
      const content = 'events-rotation:\r\n  enabled: false\r\n  max-size-mb: 20\r\n';
      const result = _parseEventsRotation(content);
      expect(result.enabled).toBe(false);
      expect(result['max-size-mb']).toBe(20);
    });

    it('strips inline YAML comments', () => {
      const content =
        'events-rotation:\n  max-size-mb: 50  # 50 MB cap\n  max-backups: 3  # keep 3\n';
      const result = _parseEventsRotation(content);
      expect(result['max-size-mb']).toBe(50);
      expect(result['max-backups']).toBe(3);
    });
  });

  describe('block boundary', () => {
    it('stops parsing at next top-level key', () => {
      const content =
        'events-rotation:\n  max-size-mb: 20\nother-section:\n  max-size-mb: 999\n';
      expect(_parseEventsRotation(content)['max-size-mb']).toBe(20);
    });
  });

  describe('full block', () => {
    it('parses all fields together', () => {
      const content = [
        'events-rotation:',
        '  enabled: false',
        '  max-size-mb: 25',
        '  max-backups: 10',
        '',
      ].join('\n');
      expect(_parseEventsRotation(content)).toEqual({
        enabled: false,
        'max-size-mb': 25,
        'max-backups': 10,
      });
    });
  });
});
