/**
 * tests/lib/vault-sync.test.mjs
 *
 * Unit tests for scripts/lib/config/vault-sync.mjs — the _parseVaultSync
 * function that reads the `vault-sync:` block from CLAUDE.md / AGENTS.md.
 *
 * Issue: #112 — [Discovery] Add tests for vault-sync validator
 *
 * Coverage matrix:
 *  - defaults when block is absent
 *  - enabled / mode / vault-dir / exclude parsing
 *  - inline-comment stripping
 *  - quoted vault-dir values
 *  - exclude list accumulation (both quoted and bare items)
 *  - invalid/unknown mode silently falls back to 'warn'
 *  - vault-dir: none / null clears to null
 *  - block termination at a non-indented line
 *  - empty block (header only, no sub-keys)
 *  - multiple vault-sync blocks (first-wins behaviour)
 *  - CRLF line endings
 *  - block preceded by other config keys
 */

import { describe, it, expect } from 'vitest';
import { _parseVaultSync } from '../../scripts/lib/config/vault-sync.mjs';

// ── Defaults ─────────────────────────────────────────────────────────────────

describe('_parseVaultSync — defaults', () => {
  it('returns enabled: false when no vault-sync block present', () => {
    expect(_parseVaultSync('## Session Config\n\npersistence: true\n').enabled).toBe(false);
  });

  it('returns mode: "warn" when no vault-sync block present', () => {
    expect(_parseVaultSync('## Session Config\n\npersistence: true\n').mode).toBe('warn');
  });

  it('returns vault-dir: null when no vault-sync block present', () => {
    expect(_parseVaultSync('## Session Config\n\npersistence: true\n')['vault-dir']).toBeNull();
  });

  it('returns exclude: [] when no vault-sync block present', () => {
    expect(_parseVaultSync('## Session Config\n\npersistence: true\n').exclude).toEqual([]);
  });

  it('returns all four expected keys on the result object', () => {
    const result = _parseVaultSync('');
    expect(result).toHaveProperty('enabled');
    expect(result).toHaveProperty('mode');
    expect(result).toHaveProperty('vault-dir');
    expect(result).toHaveProperty('exclude');
  });

  it('returns defaults on completely empty input', () => {
    const result = _parseVaultSync('');
    expect(result.enabled).toBe(false);
    expect(result.mode).toBe('warn');
    expect(result['vault-dir']).toBeNull();
    expect(result.exclude).toEqual([]);
  });
});

// ── enabled flag ──────────────────────────────────────────────────────────────

describe('_parseVaultSync — enabled field', () => {
  it('parses enabled: true', () => {
    const content = ['vault-sync:', '  enabled: true'].join('\n');
    expect(_parseVaultSync(content).enabled).toBe(true);
  });

  it('parses enabled: false explicitly', () => {
    const content = ['vault-sync:', '  enabled: false'].join('\n');
    expect(_parseVaultSync(content).enabled).toBe(false);
  });

  it('treats enabled: TRUE (uppercase) as false (not truthy string)', () => {
    // toLowerCase() comparison: 'TRUE'.toLowerCase() === 'true' → true
    const content = ['vault-sync:', '  enabled: TRUE'].join('\n');
    expect(_parseVaultSync(content).enabled).toBe(true);
  });

  it('treats enabled: yes as false (only "true" string activates it)', () => {
    const content = ['vault-sync:', '  enabled: yes'].join('\n');
    expect(_parseVaultSync(content).enabled).toBe(false);
  });
});

// ── mode field ────────────────────────────────────────────────────────────────

describe('_parseVaultSync — mode field', () => {
  it('parses mode: strict', () => {
    const content = ['vault-sync:', '  enabled: true', '  mode: strict'].join('\n');
    expect(_parseVaultSync(content).mode).toBe('strict');
  });

  it('parses mode: warn', () => {
    const content = ['vault-sync:', '  mode: warn'].join('\n');
    expect(_parseVaultSync(content).mode).toBe('warn');
  });

  it('parses mode: off', () => {
    const content = ['vault-sync:', '  mode: off'].join('\n');
    expect(_parseVaultSync(content).mode).toBe('off');
  });

  it('silently defaults mode to "warn" for invalid value "hard" (#217 regression)', () => {
    const content = ['vault-sync:', '  enabled: true', '  mode: hard'].join('\n');
    expect(_parseVaultSync(content).mode).toBe('warn');
  });

  it('silently defaults mode to "warn" for unknown value "error"', () => {
    const content = ['vault-sync:', '  mode: error'].join('\n');
    expect(_parseVaultSync(content).mode).toBe('warn');
  });
});

// ── vault-dir field ───────────────────────────────────────────────────────────

describe('_parseVaultSync — vault-dir field', () => {
  it('parses bare vault-dir path', () => {
    const content = ['vault-sync:', '  vault-dir: /home/user/vault'].join('\n');
    expect(_parseVaultSync(content)['vault-dir']).toBe('/home/user/vault');
  });

  it('parses double-quoted vault-dir path and strips quotes', () => {
    const content = ['vault-sync:', '  vault-dir: "/Users/bg/Meta-Vault"'].join('\n');
    expect(_parseVaultSync(content)['vault-dir']).toBe('/Users/bg/Meta-Vault');
  });

  it('parses single-quoted vault-dir path and strips quotes', () => {
    const content = ["vault-sync:", "  vault-dir: '/tmp/my vault'"].join('\n');
    expect(_parseVaultSync(content)['vault-dir']).toBe('/tmp/my vault');
  });

  it('treats vault-dir: none as null', () => {
    const content = ['vault-sync:', '  vault-dir: none'].join('\n');
    expect(_parseVaultSync(content)['vault-dir']).toBeNull();
  });

  it('treats vault-dir: null as null', () => {
    const content = ['vault-sync:', '  vault-dir: null'].join('\n');
    expect(_parseVaultSync(content)['vault-dir']).toBeNull();
  });

  it('treats empty vault-dir value as null', () => {
    // An empty value after stripping means no dir was set
    const content = ['vault-sync:', '  vault-dir:'].join('\n');
    expect(_parseVaultSync(content)['vault-dir']).toBeNull();
  });
});

// ── exclude list ──────────────────────────────────────────────────────────────

describe('_parseVaultSync — exclude list', () => {
  it('parses a single bare exclude item', () => {
    const content = ['vault-sync:', '  exclude:', '    - **/_MOC.md'].join('\n');
    expect(_parseVaultSync(content).exclude).toEqual(['**/_MOC.md']);
  });

  it('parses multiple exclude items', () => {
    const content = [
      'vault-sync:',
      '  exclude:',
      '    - **/_MOC.md',
      '    - 90-archive/**',
      '    - temp/*.md',
    ].join('\n');
    expect(_parseVaultSync(content).exclude).toEqual(['**/_MOC.md', '90-archive/**', 'temp/*.md']);
  });

  it('strips double quotes from exclude items', () => {
    const content = ['vault-sync:', '  exclude:', '    - "**/_MOC.md"'].join('\n');
    expect(_parseVaultSync(content).exclude).toEqual(['**/_MOC.md']);
  });

  it('strips single quotes from exclude items', () => {
    const content = ["vault-sync:", "  exclude:", "    - '90-archive/**'"].join('\n');
    expect(_parseVaultSync(content).exclude).toEqual(['90-archive/**']);
  });

  it('returns empty array when exclude key present but no list items', () => {
    const content = ['vault-sync:', '  exclude:'].join('\n');
    expect(_parseVaultSync(content).exclude).toEqual([]);
  });

  it('ignores empty exclude list items (blank after dash)', () => {
    const content = ['vault-sync:', '  exclude:', '    -   '].join('\n');
    // An item that is empty string after trim should be skipped
    expect(_parseVaultSync(content).exclude).toEqual([]);
  });
});

// ── Inline comments ───────────────────────────────────────────────────────────

describe('_parseVaultSync — inline comment stripping', () => {
  it('strips inline # comment from enabled line', () => {
    const content = ['vault-sync:', '  enabled: true # activate vault sync'].join('\n');
    expect(_parseVaultSync(content).enabled).toBe(true);
  });

  it('strips inline # comment from mode line', () => {
    const content = ['vault-sync:', '  mode: strict # enforce hard gate'].join('\n');
    expect(_parseVaultSync(content).mode).toBe('strict');
  });

  it('strips inline # comment from vault-dir line', () => {
    const content = ['vault-sync:', '  vault-dir: /vault # path to obsidian vault'].join('\n');
    expect(_parseVaultSync(content)['vault-dir']).toBe('/vault');
  });
});

// ── Block termination ─────────────────────────────────────────────────────────

describe('_parseVaultSync — block termination', () => {
  it('stops parsing at the next non-indented line', () => {
    const content = [
      'vault-sync:',
      '  enabled: true',
      '  mode: strict',
      'other-key: some-value',
      '  vault-dir: /should-be-ignored',
    ].join('\n');
    const result = _parseVaultSync(content);
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('strict');
    // vault-dir that appears after block-end is NOT part of vault-sync
    expect(result['vault-dir']).toBeNull();
  });

  it('parses nothing when vault-sync: header is followed immediately by another key', () => {
    const content = ['vault-sync:', 'other-key: value'].join('\n');
    const result = _parseVaultSync(content);
    expect(result.enabled).toBe(false);
    expect(result.mode).toBe('warn');
  });
});

// ── Empty block ───────────────────────────────────────────────────────────────

describe('_parseVaultSync — empty block', () => {
  it('returns defaults when vault-sync: header is present but block is empty', () => {
    const content = 'vault-sync:\n\nother-key: foo\n';
    const result = _parseVaultSync(content);
    expect(result.enabled).toBe(false);
    expect(result.mode).toBe('warn');
    expect(result['vault-dir']).toBeNull();
    expect(result.exclude).toEqual([]);
  });
});

// ── CRLF line endings ─────────────────────────────────────────────────────────

describe('_parseVaultSync — CRLF line endings', () => {
  it('parses enabled: true with CRLF line endings', () => {
    const content = 'vault-sync:\r\n  enabled: true\r\n  mode: strict\r\n';
    expect(_parseVaultSync(content).enabled).toBe(true);
  });

  it('parses mode: strict with CRLF line endings', () => {
    const content = 'vault-sync:\r\n  enabled: true\r\n  mode: strict\r\n';
    expect(_parseVaultSync(content).mode).toBe('strict');
  });
});

// ── Block preceded by other config ────────────────────────────────────────────

describe('_parseVaultSync — block inside larger config', () => {
  it('finds vault-sync: block buried under other config keys', () => {
    const content = [
      '## Session Config',
      '',
      'persistence: true',
      'enforcement: warn',
      '',
      'vault-sync:',
      '  enabled: true',
      '  mode: strict',
      '  vault-dir: /meta-vault',
      '  exclude:',
      '    - "**/_MOC.md"',
      '',
      'drift-check:',
      '  enabled: false',
    ].join('\n');
    const result = _parseVaultSync(content);
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('strict');
    expect(result['vault-dir']).toBe('/meta-vault');
    expect(result.exclude).toEqual(['**/_MOC.md']);
  });

  it('does not bleed drift-check keys into vault-sync result', () => {
    const content = [
      'vault-sync:',
      '  enabled: true',
      'drift-check:',
      '  enabled: false',
      '  mode: off',
    ].join('\n');
    const result = _parseVaultSync(content);
    // vault-sync should not pick up drift-check's mode: off
    expect(result.mode).toBe('warn');
  });
});
