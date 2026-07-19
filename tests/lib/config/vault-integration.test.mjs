/**
 * vault-integration.test.mjs — Unit tests for scripts/lib/config/vault-integration.mjs
 *
 * Covers _parseVaultIntegration (content-based — block form + inline #497 form,
 * invalid mode silently defaults to warn) and _parseResourceThresholds (kv-based —
 * all 5 sub-keys with defaults).
 *
 * Post-#593: _parseVaultIntegration takes raw markdown content (not a shared KV
 * map) so its `enabled:` sub-key cannot collide with the 15+ other config blocks
 * that also have an `enabled:` line. _parseResourceThresholds remains kv-based
 * because its sub-keys are uniquely named.
 */

import { describe, it, expect } from 'vitest';
import {
  _parseVaultIntegration,
  _parseResourceThresholds,
} from '@lib/config/vault-integration.mjs';

// ---------------------------------------------------------------------------
// _parseVaultIntegration — content-based
// ---------------------------------------------------------------------------

describe('_parseVaultIntegration', () => {
  describe('defaults', () => {
    it('returns all defaults when block is absent', () => {
      expect(_parseVaultIntegration('# nothing here\n')).toEqual({
        enabled: false,
        'vault-dir': null,
        mode: 'warn',
        'vault-name': null,
      });
    });

    it('returns defaults for empty string', () => {
      expect(_parseVaultIntegration('')).toEqual({
        enabled: false,
        'vault-dir': null,
        mode: 'warn',
        'vault-name': null,
      });
    });

    it('returns defaults for non-string input', () => {
      expect(_parseVaultIntegration(undefined)).toEqual({
        enabled: false,
        'vault-dir': null,
        mode: 'warn',
        'vault-name': null,
      });
    });

    it('returns defaults when block header exists but body is empty', () => {
      const content = `vault-integration:\nother-key: 1\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: false,
        'vault-dir': null,
        mode: 'warn',
        'vault-name': null,
      });
    });
  });

  describe('block form — enabled', () => {
    it('parses enabled: true', () => {
      const content = `vault-integration:\n  enabled: true\n`;
      expect(_parseVaultIntegration(content).enabled).toBe(true);
    });

    it('parses enabled: false', () => {
      const content = `vault-integration:\n  enabled: false\n`;
      expect(_parseVaultIntegration(content).enabled).toBe(false);
    });

    it('non-boolean enabled value silently falls back to default false', () => {
      // Tolerant parser — unlike the pre-#593 kv-based path which threw via _coerceBoolean.
      const content = `vault-integration:\n  enabled: yes\n`;
      expect(_parseVaultIntegration(content).enabled).toBe(false);
    });

    it('normalises uppercase TRUE to true', () => {
      const content = `vault-integration:\n  enabled: TRUE\n`;
      expect(_parseVaultIntegration(content).enabled).toBe(true);
    });
  });

  describe('block form — vault-dir', () => {
    it('parses vault-dir path', () => {
      const content = `vault-integration:\n  vault-dir: ~/Projects/vault\n`;
      expect(_parseVaultIntegration(content)['vault-dir']).toBe('~/Projects/vault');
    });

    it('returns null for vault-dir: none', () => {
      const content = `vault-integration:\n  vault-dir: none\n`;
      expect(_parseVaultIntegration(content)['vault-dir']).toBeNull();
    });

    it('returns null for vault-dir: null', () => {
      const content = `vault-integration:\n  vault-dir: null\n`;
      expect(_parseVaultIntegration(content)['vault-dir']).toBeNull();
    });
  });

  describe('block form — mode', () => {
    it('parses mode: strict', () => {
      const content = `vault-integration:\n  mode: strict\n`;
      expect(_parseVaultIntegration(content).mode).toBe('strict');
    });

    it('parses mode: off', () => {
      const content = `vault-integration:\n  mode: off\n`;
      expect(_parseVaultIntegration(content).mode).toBe('off');
    });

    it('parses mode: warn', () => {
      const content = `vault-integration:\n  mode: warn\n`;
      expect(_parseVaultIntegration(content).mode).toBe('warn');
    });

    it('normalises uppercase mode "STRICT" to "strict"', () => {
      const content = `vault-integration:\n  mode: STRICT\n`;
      expect(_parseVaultIntegration(content).mode).toBe('strict');
    });

    it('silently defaults to "warn" for invalid mode', () => {
      const content = `vault-integration:\n  mode: hard\n`;
      expect(_parseVaultIntegration(content).mode).toBe('warn');
    });
  });

  describe('block form — full set', () => {
    it('parses all three fields together', () => {
      const content =
        `vault-integration:\n  enabled: true\n  vault-dir: ~/Projects/vault\n  mode: strict\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/Projects/vault',
        mode: 'strict',
        'vault-name': null,
      });
    });

    it('handles inline comments on sub-keys', () => {
      const content =
        `vault-integration:\n  enabled: true   # primary toggle\n  vault-dir: ~/v   # comment\n  mode: warn      # warn|strict|off\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/v',
        mode: 'warn',
        'vault-name': null,
      });
    });

    it('ignores nested keys like `gitlab-groups:` list items', () => {
      const content =
        `vault-integration:\n  enabled: true\n  vault-dir: ~/v\n  mode: warn\n  gitlab-groups:\n    - infrastructure\n    - clients\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/v',
        mode: 'warn',
        'vault-name': null,
      });
    });

    it('block ends at first non-indented line', () => {
      const content =
        `vault-integration:\n  enabled: true\n  vault-dir: ~/v\n  mode: strict\ndocs-orchestrator:\n  enabled: false\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/v',
        mode: 'strict',
        'vault-name': null,
      });
    });
  });

  // Regression: pre-#593, _parseVaultIntegration(kv) read `enabled` from a
  // shared KV map. Every config block has an `enabled:` line and they all
  // collapsed into a single KV entry — the LAST `enabled:` in the file won.
  // Whoever ended with `enabled: false` silently overwrote
  // `vault-integration.enabled: true`, disabling vault-sync + vault-mirror.
  describe('issue #593 regression — block-form must not collide with peer blocks', () => {
    it('vault-integration.enabled wins over later peer-block enabled values', () => {
      const content = [
        'vault-integration:',
        '  enabled: true',
        '  vault-dir: ~/Projects/vault',
        '  mode: warn',
        'docs-orchestrator:',
        '  enabled: false', // peer block — must NOT shadow vault-integration
        'slopcheck:',
        '  enabled: false', // another peer
        'discovery-validator:',
        '  enabled: false', // final peer (was the silent overwriter pre-#593)
        '',
      ].join('\n');

      expect(_parseVaultIntegration(content).enabled).toBe(true);
    });

    it('vault-integration.enabled: false stays false even if a later peer has enabled: true', () => {
      const content = [
        'vault-integration:',
        '  enabled: false',
        'memory:',
        '  banner:',
        '    enabled: true', // deeper-nested peer key, must not leak in
        'cold-start:',
        '  enabled: true',
        '',
      ].join('\n');

      expect(_parseVaultIntegration(content).enabled).toBe(false);
    });

    it('matches a realistic CLAUDE.md Session Config layout (vault-integration block-form embedded among peers)', () => {
      const content = [
        '## Session Config',
        '',
        'persistence: true',
        'enforcement: warn',
        'vault-integration:',
        '  enabled: true',
        '  vault-dir: ~/Projects/Bernhard/vault',
        '  mode: warn',
        'docs-orchestrator:',
        '  enabled: false',
        'vault-staleness:',
        '  enabled: false',
        'memory:',
        '  banner:',
        '    enabled: true',
        '  proposals:',
        '    enabled: true',
        'cold-start:',
        '  enabled: true',
        'state-md-lock:',
        '  enabled: true',
        'slopcheck:',
        '  enabled: false',
        'discovery-validator:',
        '  enabled: false',
        '',
      ].join('\n');

      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/Projects/Bernhard/vault',
        mode: 'warn',
        'vault-name': null,
      });
    });
  });

  // vault-name sub-key (#660 namespace)
  describe('block form — vault-name', () => {
    it('parses vault-name when present', () => {
      const content = `vault-integration:\n  enabled: true\n  vault-name: my-project\n`;
      expect(_parseVaultIntegration(content)['vault-name']).toBe('my-project');
    });

    it('returns null for vault-name when key is absent', () => {
      const content = `vault-integration:\n  enabled: true\n  vault-dir: ~/v\n`;
      expect(_parseVaultIntegration(content)['vault-name']).toBeNull();
    });

    it('returns null for vault-name: null', () => {
      const content = `vault-integration:\n  vault-name: null\n`;
      expect(_parseVaultIntegration(content)['vault-name']).toBeNull();
    });

    it('returns null for vault-name: none', () => {
      const content = `vault-integration:\n  vault-name: none\n`;
      expect(_parseVaultIntegration(content)['vault-name']).toBeNull();
    });

    it('returns null for empty vault-name value', () => {
      const content = `vault-integration:\n  vault-name: \n`;
      expect(_parseVaultIntegration(content)['vault-name']).toBeNull();
    });

    it('parses vault-name alongside all three other fields', () => {
      const content =
        `vault-integration:\n  enabled: true\n  vault-dir: ~/v\n  mode: warn\n  vault-name: acme-corp\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/v',
        mode: 'warn',
        'vault-name': 'acme-corp',
      });
    });
  });

  // Issue #497: inline object literal form
  describe('issue #497 — inline object literal form', () => {
    it('parses inline object with all three fields', () => {
      const content = `vault-integration: { enabled: true, vault-dir: ~/Projects/vault, mode: warn }\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/Projects/vault',
        mode: 'warn',
        'vault-name': null,
      });
    });

    it('inline list-item form (`- vault-integration: { ... }`)', () => {
      const content = `- vault-integration: { enabled: true, vault-dir: ~/A, mode: strict }\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/A',
        mode: 'strict',
        'vault-name': null,
      });
    });

    it('inline form takes precedence over block form when both present', () => {
      const content = [
        'vault-integration: { enabled: true, vault-dir: ~/A, mode: strict }',
        'vault-integration:',
        '  enabled: false',
        '  vault-dir: ~/B',
        '  mode: off',
        '',
      ].join('\n');

      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/A',
        mode: 'strict',
        'vault-name': null,
      });
    });

    it('inline form: enabled: false', () => {
      const content = `vault-integration: { enabled: false, vault-dir: ~/v, mode: off }\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: false,
        'vault-dir': '~/v',
        mode: 'off',
        'vault-name': null,
      });
    });

    it('inline form: missing mode defaults to warn', () => {
      const content = `vault-integration: { enabled: true, vault-dir: ~/v }\n`;
      expect(_parseVaultIntegration(content).mode).toBe('warn');
    });

    it('inline form: invalid mode silently defaults to warn', () => {
      const content = `vault-integration: { enabled: true, vault-dir: ~/v, mode: bogus }\n`;
      expect(_parseVaultIntegration(content).mode).toBe('warn');
    });

    it('inline form: missing vault-dir yields null', () => {
      const content = `vault-integration: { enabled: true, mode: warn }\n`;
      expect(_parseVaultIntegration(content)['vault-dir']).toBeNull();
    });

    it('inline form: empty braces yields all-default object', () => {
      const content = `vault-integration: {}\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: false,
        'vault-dir': null,
        mode: 'warn',
        'vault-name': null,
      });
    });
  });

  // Issue #823: bold-bullet markdown rendering of vault-integration (both
  // inline and block forms). The optional `**` markdown-bold wrapper around
  // the `vault-integration:` key token at line-start is stripped; the value
  // portion is untouched.
  describe('#823 bold-bullet form', () => {
    it('parses bold inline-flow form (`- **vault-integration:** { ... }`)', () => {
      const content =
        `- **vault-integration:** { enabled: true, vault-dir: ~/Projects/vault, mode: warn }\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/Projects/vault',
        mode: 'warn',
        'vault-name': null,
      });
    });

    it('parses bold block-header form (`- **vault-integration:**` + indented body)', () => {
      const content =
        `- **vault-integration:**\n  enabled: true\n  vault-dir: ~/Projects/vault\n  mode: warn\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: true,
        'vault-dir': '~/Projects/vault',
        mode: 'warn',
        'vault-name': null,
      });
    });

    it('a bullet with a different bold key does not populate vault-integration', () => {
      const content = `- **vault-sync:** { enabled: true, vault-dir: ~/X, mode: strict }\n`;
      expect(_parseVaultIntegration(content)).toEqual({
        enabled: false,
        'vault-dir': null,
        mode: 'warn',
        'vault-name': null,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// _parseResourceThresholds — kv-based (unchanged from pre-#593)
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
