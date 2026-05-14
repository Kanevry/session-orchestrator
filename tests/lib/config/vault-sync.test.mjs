/**
 * vault-sync.test.mjs — Unit tests for scripts/lib/config/vault-sync.mjs
 *
 * Tolerant parser: no throws. Covers defaults, full block, partial block,
 * invalid mode (silently defaults), CRLF, inline comments, exclude list,
 * quote stripping, block boundary.
 */

import { describe, it, expect } from 'vitest';
import { _parseVaultSync } from '@lib/config/vault-sync.mjs';

const DEFAULTS = {
  enabled: false,
  mode: 'warn',
  'vault-dir': null,
  exclude: [],
};

describe('_parseVaultSync', () => {
  describe('empty and missing block', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseVaultSync('')).toEqual(DEFAULTS);
    });

    it('returns all defaults when vault-sync block is absent', () => {
      expect(_parseVaultSync('persistence: true\n')).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty', () => {
      const content = 'vault-sync:\n\nnext-section:\n';
      expect(_parseVaultSync(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag', () => {
    it('parses enabled: true', () => {
      const content = 'vault-sync:\n  enabled: true\n';
      expect(_parseVaultSync(content).enabled).toBe(true);
    });

    it('defaults enabled to false when not specified in block', () => {
      const content = 'vault-sync:\n  mode: strict\n';
      expect(_parseVaultSync(content).enabled).toBe(false);
    });
  });

  describe('mode', () => {
    it('parses mode: strict', () => {
      const content = 'vault-sync:\n  mode: strict\n';
      expect(_parseVaultSync(content).mode).toBe('strict');
    });

    it('parses mode: off', () => {
      const content = 'vault-sync:\n  mode: off\n';
      expect(_parseVaultSync(content).mode).toBe('off');
    });

    it('silently defaults to "warn" on invalid mode', () => {
      const content = 'vault-sync:\n  mode: bad-mode\n';
      expect(_parseVaultSync(content).mode).toBe('warn');
    });
  });

  describe('vault-dir', () => {
    it('parses vault-dir value', () => {
      const content = 'vault-sync:\n  vault-dir: ~/Projects/vault\n';
      expect(_parseVaultSync(content)['vault-dir']).toBe('~/Projects/vault');
    });

    it('returns null for vault-dir: none', () => {
      const content = 'vault-sync:\n  vault-dir: none\n';
      expect(_parseVaultSync(content)['vault-dir']).toBeNull();
    });

    it('returns null for vault-dir: null', () => {
      const content = 'vault-sync:\n  vault-dir: null\n';
      expect(_parseVaultSync(content)['vault-dir']).toBeNull();
    });

    it('strips surrounding double quotes from vault-dir', () => {
      const content = 'vault-sync:\n  vault-dir: "~/Projects/vault"\n';
      expect(_parseVaultSync(content)['vault-dir']).toBe('~/Projects/vault');
    });
  });

  describe('exclude list', () => {
    it('returns empty array when exclude is absent', () => {
      const content = 'vault-sync:\n  enabled: true\n';
      expect(_parseVaultSync(content).exclude).toEqual([]);
    });

    it('parses exclude list items', () => {
      const content = 'vault-sync:\n  exclude:\n    - pattern-one\n    - pattern-two\n';
      expect(_parseVaultSync(content).exclude).toEqual(['pattern-one', 'pattern-two']);
    });

    it('strips surrounding quotes from exclude items', () => {
      const content = "vault-sync:\n  exclude:\n    - \"*.tmp\"\n    - '*.bak'\n";
      expect(_parseVaultSync(content).exclude).toEqual(['*.tmp', '*.bak']);
    });
  });

  describe('CRLF tolerance and inline comments', () => {
    it('handles CRLF line endings', () => {
      const content = 'vault-sync:\r\n  enabled: true\r\n  mode: strict\r\n';
      const result = _parseVaultSync(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('strict');
    });

    it('strips inline YAML comments', () => {
      const content = 'vault-sync:\n  enabled: true  # opt-in\n  mode: warn  # default\n';
      const result = _parseVaultSync(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('warn');
    });
  });

  describe('block boundary', () => {
    it('stops parsing at next top-level key', () => {
      const content =
        'vault-sync:\n  enabled: true\nother-section:\n  enabled: false\n';
      expect(_parseVaultSync(content).enabled).toBe(true);
    });
  });

  describe('full block', () => {
    it('parses all fields together', () => {
      const content = [
        'vault-sync:',
        '  enabled: true',
        '  mode: strict',
        '  vault-dir: ~/Projects/vault',
        '  exclude:',
        '    - 10-inbox',
        '    - 90-archive',
        '',
      ].join('\n');
      expect(_parseVaultSync(content)).toEqual({
        enabled: true,
        mode: 'strict',
        'vault-dir': '~/Projects/vault',
        exclude: ['10-inbox', '90-archive'],
      });
    });
  });
});
