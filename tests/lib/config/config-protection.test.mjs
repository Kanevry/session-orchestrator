/**
 * config-protection.test.mjs — Unit tests for
 * scripts/lib/config/config-protection.mjs
 *
 * Tolerant parser for the top-level `config-protection:` YAML block
 * (ecc-analysis / #622). Two exports:
 *   - _parseConfigProtection(content) → { enabled, mode }
 *   - _isConfigWeakeningAllowed(content) → boolean  (Session-Config bypass scan)
 *
 * Covers: defaults, enabled flip, mode validation (warn/strict/unknown→warn,
 * case-insensitive), block-boundary detection, and the `allow-config-weakening`
 * bypass scan. Pins the SUPPORTED plain `allow-config-weakening: true` form and
 * asserts the bold-markdown `- **allow-config-weakening:** true` form is NOT
 * honored (dead defensive code copied from another guard — see report).
 *
 * Mirrors the style of tests/lib/config/cold-start.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import {
  _parseConfigProtection,
  _isConfigWeakeningAllowed,
} from '@lib/config/config-protection.mjs';

const DEFAULTS = { enabled: true, mode: 'warn' };

describe('_parseConfigProtection', () => {
  describe('defaults (block absent or empty)', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseConfigProtection('')).toEqual(DEFAULTS);
    });

    it('returns all defaults on non-string input', () => {
      expect(_parseConfigProtection(null)).toEqual(DEFAULTS);
      expect(_parseConfigProtection(undefined)).toEqual(DEFAULTS);
    });

    it('returns all defaults when config-protection block is absent', () => {
      const content = 'persistence: true\nenforcement: warn\n';
      expect(_parseConfigProtection(content)).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty', () => {
      const content = 'config-protection:\n\nnext-section:\n';
      expect(_parseConfigProtection(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag', () => {
    it('flips enabled to false on explicit "false"', () => {
      const content = 'config-protection:\n  enabled: false\n';
      expect(_parseConfigProtection(content).enabled).toBe(false);
    });

    it('keeps enabled true on explicit "true"', () => {
      const content = 'config-protection:\n  enabled: true\n';
      expect(_parseConfigProtection(content).enabled).toBe(true);
    });

    it('keeps default enabled=true when key absent from a non-empty block', () => {
      const content = 'config-protection:\n  mode: strict\n';
      expect(_parseConfigProtection(content).enabled).toBe(true);
    });
  });

  describe('mode validation', () => {
    it('accepts mode: warn', () => {
      const content = 'config-protection:\n  mode: warn\n';
      expect(_parseConfigProtection(content).mode).toBe('warn');
    });

    it('accepts mode: strict', () => {
      const content = 'config-protection:\n  mode: strict\n';
      expect(_parseConfigProtection(content).mode).toBe('strict');
    });

    it('falls back to warn on an unknown mode value', () => {
      const content = 'config-protection:\n  mode: bogus\n';
      expect(_parseConfigProtection(content).mode).toBe('warn');
    });

    it('lowercases the mode value (STRICT → strict)', () => {
      const content = 'config-protection:\n  mode: STRICT\n';
      expect(_parseConfigProtection(content).mode).toBe('strict');
    });

    it('strips inline comments before validating the mode', () => {
      const content = 'config-protection:\n  mode: strict  # block loosening edits\n';
      expect(_parseConfigProtection(content).mode).toBe('strict');
    });

    it('strips surrounding quotes from the mode value', () => {
      const content = 'config-protection:\n  mode: "strict"\n';
      expect(_parseConfigProtection(content).mode).toBe('strict');
    });
  });

  describe('combined + boundary', () => {
    it('parses enabled=false and mode=strict together', () => {
      const content = 'config-protection:\n  enabled: false\n  mode: strict\n';
      expect(_parseConfigProtection(content)).toEqual({ enabled: false, mode: 'strict' });
    });

    it('handles CRLF line endings', () => {
      const content = 'config-protection:\r\n  enabled: false\r\n  mode: strict\r\n';
      expect(_parseConfigProtection(content)).toEqual({ enabled: false, mode: 'strict' });
    });

    it('stops parsing at the next top-level key', () => {
      const content = [
        'config-protection:',
        '  mode: strict',
        'other-section:',
        '  mode: warn',
        '',
      ].join('\n');
      expect(_parseConfigProtection(content).mode).toBe('strict');
    });
  });
});

describe('_isConfigWeakeningAllowed', () => {
  const withSessionConfig = (line) =>
    ['## Session Config', '', line, ''].join('\n');

  describe('supported plain form (honored)', () => {
    it('returns true for the plain `allow-config-weakening: true` form', () => {
      expect(_isConfigWeakeningAllowed(withSessionConfig('allow-config-weakening: true'))).toBe(true);
    });

    it('returns false for the plain form set to false', () => {
      expect(_isConfigWeakeningAllowed(withSessionConfig('allow-config-weakening: false'))).toBe(false);
    });

    it('is case-insensitive on the value (TRUE → true)', () => {
      expect(_isConfigWeakeningAllowed(withSessionConfig('allow-config-weakening: TRUE'))).toBe(true);
    });
  });

  describe('bold-markdown form is NOT honored (dead defensive code)', () => {
    // The regex `(?::\*\*)?\s*:\s*` cannot match `:** true` (no second literal
    // colon after the bold close), so the bold form silently returns false even
    // though the regex appears to support it. The plain form above is the
    // documented/supported bypass; this pins the actual behaviour so a future
    // refactor cannot quietly "fix" the dead branch without a deliberate choice.
    it('returns false for the bold `- **allow-config-weakening:** true` form', () => {
      expect(
        _isConfigWeakeningAllowed(withSessionConfig('- **allow-config-weakening:** true')),
      ).toBe(false);
    });
  });

  describe('scope + edge cases', () => {
    it('returns false on empty string', () => {
      expect(_isConfigWeakeningAllowed('')).toBe(false);
    });

    it('returns false on non-string input', () => {
      expect(_isConfigWeakeningAllowed(null)).toBe(false);
    });

    it('ignores the bypass line when it sits OUTSIDE the Session Config section', () => {
      const content = ['allow-config-weakening: true', '## Session Config', '', 'foo: bar', ''].join('\n');
      expect(_isConfigWeakeningAllowed(content)).toBe(false);
    });

    it('stops scanning at the next ## section heading', () => {
      const content = [
        '## Session Config',
        '',
        'persistence: true',
        '',
        '## Other Section',
        '',
        'allow-config-weakening: true',
        '',
      ].join('\n');
      expect(_isConfigWeakeningAllowed(content)).toBe(false);
    });
  });
});
