/**
 * vault-integration.test.mjs — Unit tests for scripts/lib/config/vault-integration.mjs
 *
 * Covers _parseVaultIntegration (content-based — block form + inline #497 form +
 * #823 bold-bullet form, invalid mode silently defaults to warn) and
 * _parseResourceThresholds (kv-based — all 5 sub-keys with defaults).
 *
 * Post-#593: _parseVaultIntegration takes raw markdown content (not a shared KV
 * map) so its `enabled:` sub-key cannot collide with the 15+ other config blocks
 * that also have an `enabled:` line. _parseResourceThresholds remains kv-based
 * because its sub-keys are uniquely named.
 *
 * Shape: one it.each table per function, every row asserting the FULL returned
 * object. The per-sub-key `it` blocks this replaced asserted a single field each,
 * so e.g. a `mode:` row could not catch that parsing mode clobbered `vault-dir`.
 */

import { describe, it, expect } from 'vitest';
import {
  _parseVaultIntegration,
  _parseResourceThresholds,
} from '@lib/config/vault-integration.mjs';

// ---------------------------------------------------------------------------
// _parseVaultIntegration — content-based
// ---------------------------------------------------------------------------

const VI_DEFAULTS = {
  enabled: false,
  'vault-dir': null,
  mode: 'warn',
  'vault-name': null,
};

const vi = (overrides) => ({ ...VI_DEFAULTS, ...overrides });

describe('_parseVaultIntegration', () => {
  it.each([
    // ── defaults ─────────────────────────────────────────────────────────────
    { why: 'returns all defaults when the block is absent', content: '# nothing here\n', expected: VI_DEFAULTS },
    { why: 'returns defaults for empty string', content: '', expected: VI_DEFAULTS },
    { why: 'returns defaults for non-string input', content: undefined, expected: VI_DEFAULTS },
    { why: 'returns defaults when the block header exists but the body is empty', content: 'vault-integration:\nother-key: 1\n', expected: VI_DEFAULTS },

    // ── block form — enabled ─────────────────────────────────────────────────
    { why: 'block form parses enabled: true', content: 'vault-integration:\n  enabled: true\n', expected: vi({ enabled: true }) },
    { why: 'block form parses enabled: false', content: 'vault-integration:\n  enabled: false\n', expected: VI_DEFAULTS },
    // Tolerant parser — unlike the pre-#593 kv path, which threw via _coerceBoolean.
    { why: 'block form: non-boolean enabled silently falls back to false', content: 'vault-integration:\n  enabled: yes\n', expected: VI_DEFAULTS },
    { why: 'block form normalises uppercase TRUE to true', content: 'vault-integration:\n  enabled: TRUE\n', expected: vi({ enabled: true }) },

    // ── block form — vault-dir ───────────────────────────────────────────────
    { why: 'block form parses a vault-dir path', content: 'vault-integration:\n  vault-dir: ~/Projects/vault\n', expected: vi({ 'vault-dir': '~/Projects/vault' }) },
    { why: 'block form maps vault-dir: none to null', content: 'vault-integration:\n  vault-dir: none\n', expected: VI_DEFAULTS },
    { why: 'block form maps vault-dir: null to null', content: 'vault-integration:\n  vault-dir: null\n', expected: VI_DEFAULTS },

    // ── block form — mode ────────────────────────────────────────────────────
    { why: 'block form parses mode: strict', content: 'vault-integration:\n  mode: strict\n', expected: vi({ mode: 'strict' }) },
    { why: 'block form parses mode: off', content: 'vault-integration:\n  mode: off\n', expected: vi({ mode: 'off' }) },
    { why: 'block form parses mode: warn', content: 'vault-integration:\n  mode: warn\n', expected: VI_DEFAULTS },
    { why: 'block form normalises uppercase STRICT to strict', content: 'vault-integration:\n  mode: STRICT\n', expected: vi({ mode: 'strict' }) },
    { why: 'block form silently defaults to warn for an invalid mode', content: 'vault-integration:\n  mode: hard\n', expected: VI_DEFAULTS },

    // ── block form — full set / boundaries ───────────────────────────────────
    {
      why: 'block form parses all three fields together',
      content: 'vault-integration:\n  enabled: true\n  vault-dir: ~/Projects/vault\n  mode: strict\n',
      expected: vi({ enabled: true, 'vault-dir': '~/Projects/vault', mode: 'strict' }),
    },
    {
      why: 'block form handles inline comments on sub-keys',
      content: 'vault-integration:\n  enabled: true   # primary toggle\n  vault-dir: ~/v   # comment\n  mode: warn      # warn|strict|off\n',
      expected: vi({ enabled: true, 'vault-dir': '~/v' }),
    },
    {
      why: 'block form ignores nested keys like a `gitlab-groups:` list',
      content: 'vault-integration:\n  enabled: true\n  vault-dir: ~/v\n  mode: warn\n  gitlab-groups:\n    - infrastructure\n    - clients\n',
      expected: vi({ enabled: true, 'vault-dir': '~/v' }),
    },
    {
      why: 'block ends at the first non-indented line',
      content: 'vault-integration:\n  enabled: true\n  vault-dir: ~/v\n  mode: strict\ndocs-orchestrator:\n  enabled: false\n',
      expected: vi({ enabled: true, 'vault-dir': '~/v', mode: 'strict' }),
    },

    // ── issue #593 regression — block form must not collide with peer blocks ──
    // Pre-#593, _parseVaultIntegration(kv) read `enabled` from a shared KV map.
    // Every config block has an `enabled:` line and they all collapsed into one
    // KV entry — the LAST `enabled:` in the file won, so a peer ending in
    // `enabled: false` silently disabled vault-sync + vault-mirror.
    {
      why: '#593: vault-integration.enabled wins over later peer-block enabled values',
      content: [
        'vault-integration:',
        '  enabled: true',
        '  vault-dir: ~/Projects/vault',
        '  mode: warn',
        'docs-orchestrator:',
        '  enabled: false',
        'slopcheck:',
        '  enabled: false',
        'discovery-validator:',
        '  enabled: false',
        '',
      ].join('\n'),
      expected: vi({ enabled: true, 'vault-dir': '~/Projects/vault' }),
    },
    {
      why: '#593: enabled: false stays false even when a later peer has enabled: true',
      content: [
        'vault-integration:',
        '  enabled: false',
        'memory:',
        '  banner:',
        '    enabled: true',
        'cold-start:',
        '  enabled: true',
        '',
      ].join('\n'),
      expected: VI_DEFAULTS,
    },
    // ── issue #1162 regression — preprocessing defects ──────────────────────
    // (a) A block commented OUT with `<!-- … -->` was parsed as LIVE config, so
    // commenting a key out ARMED it (the exact inversion #1097 fixed for the
    // flat KV path; the block parsers never got it).
    {
      why: '#1162a: an HTML-commented block is documentation, not live config',
      content: [
        '<!--',
        'vault-integration:',
        '  enabled: true',
        '  mode: strict',
        '-->',
        '',
      ].join('\n'),
      expected: VI_DEFAULTS,
    },
    {
      why: '#1162a: a commented block does not clobber the live block above it',
      content: [
        'vault-integration:',
        '  enabled: true',
        '  mode: warn',
        '<!--',
        '  mode: strict',
        '-->',
        '',
      ].join('\n'),
      expected: vi({ enabled: true }),
    },
    // (b) The bold-bullet markdown rendering was accepted on the block HEADER
    // (#823) but not on the SUB-KEYS — so `- **enabled:** true` fell back to the
    // `false` default with no error anywhere.
    {
      why: '#1162b: bold-bullet sub-key `- **enabled:** true` is read as enabled: true',
      content: 'vault-integration:\n  - **enabled:** true\n',
      expected: vi({ enabled: true }),
    },
    {
      why: '#1162b: bold sub-keys without a dash and with the colon outside the markers',
      content: 'vault-integration:\n  **enabled:** true\n  - **mode**: strict\n',
      expected: vi({ enabled: true, mode: 'strict' }),
    },
    {
      why: '#593: realistic CLAUDE.md Session Config layout with vault-integration among peers',
      content: [
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
      ].join('\n'),
      expected: vi({ enabled: true, 'vault-dir': '~/Projects/Bernhard/vault' }),
    },

    // ── block form — vault-name (#660 namespace) ─────────────────────────────
    { why: 'parses vault-name when present', content: 'vault-integration:\n  enabled: true\n  vault-name: my-project\n', expected: vi({ enabled: true, 'vault-name': 'my-project' }) },
    { why: 'vault-name is null when the key is absent', content: 'vault-integration:\n  enabled: true\n  vault-dir: ~/v\n', expected: vi({ enabled: true, 'vault-dir': '~/v' }) },
    { why: 'vault-name: null yields null', content: 'vault-integration:\n  vault-name: null\n', expected: VI_DEFAULTS },
    { why: 'vault-name: none yields null', content: 'vault-integration:\n  vault-name: none\n', expected: VI_DEFAULTS },
    { why: 'an empty vault-name value yields null', content: 'vault-integration:\n  vault-name: \n', expected: VI_DEFAULTS },
    {
      why: 'parses vault-name alongside all three other fields',
      content: 'vault-integration:\n  enabled: true\n  vault-dir: ~/v\n  mode: warn\n  vault-name: acme-corp\n',
      expected: vi({ enabled: true, 'vault-dir': '~/v', 'vault-name': 'acme-corp' }),
    },

    // ── issue #497 — inline object literal form ──────────────────────────────
    {
      why: '#497: parses an inline object with all three fields',
      content: 'vault-integration: { enabled: true, vault-dir: ~/Projects/vault, mode: warn }\n',
      expected: vi({ enabled: true, 'vault-dir': '~/Projects/vault' }),
    },
    {
      why: '#497: parses the inline list-item form (`- vault-integration: { ... }`)',
      content: '- vault-integration: { enabled: true, vault-dir: ~/A, mode: strict }\n',
      expected: vi({ enabled: true, 'vault-dir': '~/A', mode: 'strict' }),
    },
    {
      why: '#497: inline form takes precedence over block form when both are present',
      content: [
        'vault-integration: { enabled: true, vault-dir: ~/A, mode: strict }',
        'vault-integration:',
        '  enabled: false',
        '  vault-dir: ~/B',
        '  mode: off',
        '',
      ].join('\n'),
      expected: vi({ enabled: true, 'vault-dir': '~/A', mode: 'strict' }),
    },
    {
      why: '#497: inline form with enabled: false',
      content: 'vault-integration: { enabled: false, vault-dir: ~/v, mode: off }\n',
      expected: vi({ 'vault-dir': '~/v', mode: 'off' }),
    },
    {
      why: '#497: inline form with a missing mode defaults to warn',
      content: 'vault-integration: { enabled: true, vault-dir: ~/v }\n',
      expected: vi({ enabled: true, 'vault-dir': '~/v' }),
    },
    {
      why: '#497: inline form with an invalid mode silently defaults to warn',
      content: 'vault-integration: { enabled: true, vault-dir: ~/v, mode: bogus }\n',
      expected: vi({ enabled: true, 'vault-dir': '~/v' }),
    },
    {
      why: '#497: inline form with a missing vault-dir yields null',
      content: 'vault-integration: { enabled: true, mode: warn }\n',
      expected: vi({ enabled: true }),
    },
    { why: '#497: inline empty braces yield the all-default object', content: 'vault-integration: {}\n', expected: VI_DEFAULTS },

    // ── issue #823 — bold-bullet markdown form ───────────────────────────────
    // The optional `**` markdown-bold wrapper around the key token at line-start
    // is stripped; the value portion is untouched.
    {
      why: '#823: parses the bold inline-flow form (`- **vault-integration:** { ... }`)',
      content: '- **vault-integration:** { enabled: true, vault-dir: ~/Projects/vault, mode: warn }\n',
      expected: vi({ enabled: true, 'vault-dir': '~/Projects/vault' }),
    },
    {
      why: '#823: parses the bold block-header form (`- **vault-integration:**` + indented body)',
      content: '- **vault-integration:**\n  enabled: true\n  vault-dir: ~/Projects/vault\n  mode: warn\n',
      expected: vi({ enabled: true, 'vault-dir': '~/Projects/vault' }),
    },
    {
      why: '#823: a bullet with a DIFFERENT bold key does not populate vault-integration',
      content: '- **vault-sync:** { enabled: true, vault-dir: ~/X, mode: strict }\n',
      expected: VI_DEFAULTS,
    },
  ])('$why', ({ content, expected }) => {
    expect(_parseVaultIntegration(content)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// _parseResourceThresholds — kv-based (unchanged from pre-#593)
// ---------------------------------------------------------------------------

const RT_DEFAULTS = {
  'ram-free-min-gb': 4,
  'ram-free-critical-gb': 2,
  'cpu-load-max-pct': 90,
  'concurrent-sessions-warn': 5,
  'ssh-no-docker': true,
};

describe('_parseResourceThresholds', () => {
  it.each([
    { why: 'returns every default when the kv map is empty', entries: [], expected: RT_DEFAULTS },
    { why: 'parses ram-free-min-gb: 8', entries: [['ram-free-min-gb', '8']], expected: { ...RT_DEFAULTS, 'ram-free-min-gb': 8 } },
    { why: 'parses ram-free-critical-gb: 1', entries: [['ram-free-critical-gb', '1']], expected: { ...RT_DEFAULTS, 'ram-free-critical-gb': 1 } },
    { why: 'parses cpu-load-max-pct: 90', entries: [['cpu-load-max-pct', '90']], expected: { ...RT_DEFAULTS, 'cpu-load-max-pct': 90 } },
    { why: 'parses concurrent-sessions-warn: 3', entries: [['concurrent-sessions-warn', '3']], expected: { ...RT_DEFAULTS, 'concurrent-sessions-warn': 3 } },
    { why: 'parses ssh-no-docker: false', entries: [['ssh-no-docker', 'false']], expected: { ...RT_DEFAULTS, 'ssh-no-docker': false } },
  ])('$why', ({ entries, expected }) => {
    expect(_parseResourceThresholds(new Map(entries))).toEqual(expected);
  });

  it.each([
    { why: 'throws on a non-integer ram-free-min-gb (delegates to _coerceInteger)', entries: [['ram-free-min-gb', 'lots']], errorRe: /invalid integer/ },
    { why: 'throws on a non-boolean ssh-no-docker (delegates to _coerceBoolean)', entries: [['ssh-no-docker', 'yes']], errorRe: /invalid boolean/ },
  ])('$why', ({ entries, errorRe }) => {
    expect(() => _parseResourceThresholds(new Map(entries))).toThrow(errorRe);
  });
});
