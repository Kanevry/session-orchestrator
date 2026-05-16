/**
 * vault-integration.test.mjs — Unit tests for scripts/lib/config/vault-integration.mjs
 *
 * Covers _parseVaultIntegration (enabled, vault-dir, mode — invalid mode silently
 * defaults to warn) and _parseResourceThresholds (all 5 sub-keys with defaults).
 *
 * These parsers accept a flat KV Map (like the Session Config parser produces),
 * NOT raw YAML content.
 */

import { describe, it, expect } from 'vitest';
import {
  _parseVaultIntegration,
  _parseResourceThresholds,
} from '@lib/config/vault-integration.mjs';

// ---------------------------------------------------------------------------
// _parseVaultIntegration
// ---------------------------------------------------------------------------

describe('_parseVaultIntegration', () => {
  describe('defaults', () => {
    it('returns enabled: false when key is absent', () => {
      const kv = new Map();
      expect(_parseVaultIntegration(kv).enabled).toBe(false);
    });

    it('returns vault-dir: null when key is absent', () => {
      const kv = new Map();
      expect(_parseVaultIntegration(kv)['vault-dir']).toBeNull();
    });

    it('returns mode: "warn" when key is absent', () => {
      const kv = new Map();
      expect(_parseVaultIntegration(kv).mode).toBe('warn');
    });
  });

  describe('enabled', () => {
    it('parses enabled: true', () => {
      const kv = new Map([['enabled', 'true']]);
      expect(_parseVaultIntegration(kv).enabled).toBe(true);
    });

    it('parses enabled: false', () => {
      const kv = new Map([['enabled', 'false']]);
      expect(_parseVaultIntegration(kv).enabled).toBe(false);
    });

    it('throws on non-boolean enabled value (delegates to _coerceBoolean)', () => {
      const kv = new Map([['enabled', 'yes']]);
      expect(() => _parseVaultIntegration(kv)).toThrow(/invalid boolean/);
    });
  });

  describe('vault-dir', () => {
    it('parses vault-dir path', () => {
      const kv = new Map([['vault-dir', '~/Projects/vault']]);
      expect(_parseVaultIntegration(kv)['vault-dir']).toBe('~/Projects/vault');
    });

    it('returns null for vault-dir: none', () => {
      const kv = new Map([['vault-dir', 'none']]);
      expect(_parseVaultIntegration(kv)['vault-dir']).toBeNull();
    });

    it('returns null for vault-dir: null', () => {
      const kv = new Map([['vault-dir', 'null']]);
      expect(_parseVaultIntegration(kv)['vault-dir']).toBeNull();
    });

    it('returns null for empty vault-dir value', () => {
      const kv = new Map([['vault-dir', '']]);
      expect(_parseVaultIntegration(kv)['vault-dir']).toBeNull();
    });
  });

  describe('mode', () => {
    it('parses mode: strict', () => {
      const kv = new Map([['mode', 'strict']]);
      expect(_parseVaultIntegration(kv).mode).toBe('strict');
    });

    it('parses mode: off', () => {
      const kv = new Map([['mode', 'off']]);
      expect(_parseVaultIntegration(kv).mode).toBe('off');
    });

    it('parses mode: warn', () => {
      const kv = new Map([['mode', 'warn']]);
      expect(_parseVaultIntegration(kv).mode).toBe('warn');
    });

    it('normalises uppercase mode "STRICT" to "strict"', () => {
      const kv = new Map([['mode', 'STRICT']]);
      expect(_parseVaultIntegration(kv).mode).toBe('strict');
    });

    it('silently defaults to "warn" for invalid mode', () => {
      const kv = new Map([['mode', 'hard']]);
      expect(_parseVaultIntegration(kv).mode).toBe('warn');
    });
  });

  describe('full set', () => {
    it('parses all three fields together', () => {
      const kv = new Map([
        ['enabled', 'true'],
        ['vault-dir', '~/Projects/vault'],
        ['mode', 'strict'],
      ]);
      expect(_parseVaultIntegration(kv)).toEqual({
        enabled: true,
        'vault-dir': '~/Projects/vault',
        mode: 'strict',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// _parseResourceThresholds
// ---------------------------------------------------------------------------

describe('_parseResourceThresholds', () => {
  describe('defaults', () => {
    it('returns default ram-free-min-gb of 4 when absent', () => {
      const kv = new Map();
      expect(_parseResourceThresholds(kv)['ram-free-min-gb']).toBe(4);
    });

    it('returns default ram-free-critical-gb of 2 when absent', () => {
      const kv = new Map();
      expect(_parseResourceThresholds(kv)['ram-free-critical-gb']).toBe(2);
    });

    it('returns default cpu-load-max-pct of 80 when absent', () => {
      const kv = new Map();
      expect(_parseResourceThresholds(kv)['cpu-load-max-pct']).toBe(80);
    });

    it('returns default concurrent-sessions-warn of 5 when absent', () => {
      const kv = new Map();
      expect(_parseResourceThresholds(kv)['concurrent-sessions-warn']).toBe(5);
    });

    it('returns default ssh-no-docker of true when absent', () => {
      const kv = new Map();
      expect(_parseResourceThresholds(kv)['ssh-no-docker']).toBe(true);
    });
  });

  describe('explicit values', () => {
    it('parses ram-free-min-gb: 8', () => {
      const kv = new Map([['ram-free-min-gb', '8']]);
      expect(_parseResourceThresholds(kv)['ram-free-min-gb']).toBe(8);
    });

    it('parses ram-free-critical-gb: 1', () => {
      const kv = new Map([['ram-free-critical-gb', '1']]);
      expect(_parseResourceThresholds(kv)['ram-free-critical-gb']).toBe(1);
    });

    it('parses cpu-load-max-pct: 90', () => {
      const kv = new Map([['cpu-load-max-pct', '90']]);
      expect(_parseResourceThresholds(kv)['cpu-load-max-pct']).toBe(90);
    });

    it('parses concurrent-sessions-warn: 3', () => {
      const kv = new Map([['concurrent-sessions-warn', '3']]);
      expect(_parseResourceThresholds(kv)['concurrent-sessions-warn']).toBe(3);
    });

    it('parses ssh-no-docker: false', () => {
      const kv = new Map([['ssh-no-docker', 'false']]);
      expect(_parseResourceThresholds(kv)['ssh-no-docker']).toBe(false);
    });
  });

  describe('error propagation from coercers', () => {
    it('throws on non-integer ram-free-min-gb (delegates to _coerceInteger)', () => {
      const kv = new Map([['ram-free-min-gb', 'lots']]);
      expect(() => _parseResourceThresholds(kv)).toThrow(/invalid integer/);
    });

    it('throws on non-boolean ssh-no-docker (delegates to _coerceBoolean)', () => {
      const kv = new Map([['ssh-no-docker', 'yes']]);
      expect(() => _parseResourceThresholds(kv)).toThrow(/invalid boolean/);
    });
  });
});
