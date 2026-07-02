/**
 * tests/lib/owner-yaml.test.mjs
 *
 * Unit tests for scripts/lib/owner-yaml.mjs (Issue #161, D1).
 * Covers: validateOwnerConfig, loadOwnerConfig, writeOwnerConfig, getDefaults.
 *
 * Uses a tmp dir for all I/O tests to avoid touching the real ~/.config/.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  OWNER_YAML_PATH,
  validateOwnerConfig,
  loadOwnerConfig,
  writeOwnerConfig,
  getDefaults,
} from '@lib/owner-yaml.mjs';

// ---------------------------------------------------------------------------
// Helpers used by the vaults: section tests below
// ---------------------------------------------------------------------------

/** Minimal valid config WITH a vaults: list (used in vaults tests). */
function validConfigWithVaults(vaultEntries, extraOverrides = {}) {
  return {
    owner: { name: 'Test User', language: 'en' },
    tone: { style: 'neutral', tonality: 'concise' },
    efficiency: { 'output-level': 'full', preamble: 'minimal' },
    'hardware-sharing': { enabled: false, 'hash-salt': '' },
    vaults: vaultEntries,
    ...extraOverrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid config for use in tests. */
function validConfig(overrides = {}) {
  return {
    owner: { name: 'Test User', language: 'en' },
    tone: { style: 'neutral', tonality: 'concise' },
    efficiency: { 'output-level': 'full', preamble: 'minimal' },
    'hardware-sharing': { enabled: false, 'hash-salt': '' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Teardown: remove tmp dirs after each test
// ---------------------------------------------------------------------------

let tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  tmpDirs = [];
});

function makeTmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'owner-yaml-test-'));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// OWNER_YAML_PATH
// ---------------------------------------------------------------------------

describe('OWNER_YAML_PATH', () => {
  it('is a non-empty absolute string pointing into .config/session-orchestrator', () => {
    expect(typeof OWNER_YAML_PATH).toBe('string');
    expect(OWNER_YAML_PATH.length).toBeGreaterThan(0);
    expect(OWNER_YAML_PATH).toContain('.config');
    expect(OWNER_YAML_PATH).toContain('session-orchestrator');
    expect(OWNER_YAML_PATH).toMatch(/owner\.yaml$/);
  });
});

// ---------------------------------------------------------------------------
// getDefaults
// ---------------------------------------------------------------------------

describe('getDefaults', () => {
  it('returns a plain object with the required top-level sections', () => {
    const d = getDefaults();
    expect(typeof d).toBe('object');
    expect(d.owner).toBeDefined();
    expect(d.tone).toBeDefined();
    expect(d.efficiency).toBeDefined();
    expect(d['hardware-sharing']).toBeDefined();
  });

  it('defaults language to "en"', () => {
    expect(getDefaults().owner.language).toBe('en');
  });

  it('defaults tone.style to "neutral"', () => {
    expect(getDefaults().tone.style).toBe('neutral');
  });

  it('defaults efficiency.output-level to "full"', () => {
    expect(getDefaults().efficiency['output-level']).toBe('full');
  });

  it('defaults efficiency.preamble to "minimal"', () => {
    expect(getDefaults().efficiency.preamble).toBe('minimal');
  });

  it('defaults hardware-sharing.enabled to false', () => {
    expect(getDefaults()['hardware-sharing'].enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateOwnerConfig — happy path
// ---------------------------------------------------------------------------

describe('validateOwnerConfig — valid config', () => {
  it('accepts a complete valid config', () => {
    const result = validateOwnerConfig(validConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts language "de"', () => {
    const result = validateOwnerConfig(validConfig({ owner: { name: 'Max', language: 'de' } }));
    expect(result.valid).toBe(true);
  });

  it('accepts hardware-sharing enabled with a hash-salt', () => {
    const result = validateOwnerConfig(
      validConfig({ 'hardware-sharing': { enabled: true, 'hash-salt': 'abc123salt' } }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts optional tonality being omitted', () => {
    const cfg = validConfig();
    delete cfg.tone.tonality;
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateOwnerConfig — missing required fields
// ---------------------------------------------------------------------------

describe('validateOwnerConfig — missing required fields', () => {
  it('rejects when owner section is missing', () => {
    const cfg = validConfig();
    delete cfg.owner;
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects when owner.name is missing', () => {
    const cfg = validConfig({ owner: { language: 'en' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.name'))).toBe(true);
  });

  it('rejects when owner.name is empty string', () => {
    const cfg = validConfig({ owner: { name: '', language: 'en' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.name'))).toBe(true);
  });

  it('rejects when owner.language is missing', () => {
    const cfg = validConfig({ owner: { name: 'Test' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.language'))).toBe(true);
  });

  it('rejects when tone section is missing', () => {
    const cfg = validConfig();
    delete cfg.tone;
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tone'))).toBe(true);
  });

  it('rejects when efficiency section is missing', () => {
    const cfg = validConfig();
    delete cfg.efficiency;
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('efficiency'))).toBe(true);
  });

  it('rejects when hardware-sharing section is missing', () => {
    const cfg = validConfig();
    delete cfg['hardware-sharing'];
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hardware-sharing'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateOwnerConfig — invalid enum values
// ---------------------------------------------------------------------------

describe('validateOwnerConfig — invalid enum values', () => {
  it('rejects language "fr" (not in allowed set)', () => {
    const cfg = validConfig({ owner: { name: 'Test', language: 'fr' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.language'))).toBe(true);
  });

  it('rejects tone.style "casual"', () => {
    const cfg = validConfig({ tone: { style: 'casual' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tone.style'))).toBe(true);
  });

  it('rejects efficiency.output-level "medium"', () => {
    const cfg = validConfig({ efficiency: { 'output-level': 'medium', preamble: 'minimal' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('efficiency.output-level'))).toBe(true);
  });

  it('rejects efficiency.preamble "normal"', () => {
    const cfg = validConfig({ efficiency: { 'output-level': 'full', preamble: 'normal' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('efficiency.preamble'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateOwnerConfig — hardware-sharing.hash-salt constraint
// ---------------------------------------------------------------------------

describe('validateOwnerConfig — hash-salt required when enabled=true', () => {
  it('rejects enabled=true with empty hash-salt', () => {
    const cfg = validConfig({ 'hardware-sharing': { enabled: true, 'hash-salt': '' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hash-salt'))).toBe(true);
  });

  it('rejects enabled=true with hash-salt absent', () => {
    const cfg = validConfig({ 'hardware-sharing': { enabled: true } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hash-salt'))).toBe(true);
  });

  it('accepts enabled=false with no hash-salt', () => {
    const cfg = validConfig({ 'hardware-sharing': { enabled: false, 'hash-salt': '' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(true);
  });

  it('rejects hardware-sharing.enabled as non-boolean', () => {
    const cfg = validConfig({ 'hardware-sharing': { enabled: 'yes', 'hash-salt': '' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hardware-sharing.enabled'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// paths: section (#653) — host-local path overrides
// ---------------------------------------------------------------------------

describe('paths: section (#653)', () => {
  it('getDefaults().paths equals empty-override defaults', () => {
    expect(getDefaults().paths).toEqual({
      'vault-dir': '',
      'baseline-path': '',
      'namespace-map-path': '',
    });
  });

  it('accepts a config with a valid paths object', () => {
    const cfg = validConfig({
      paths: { 'vault-dir': '/v', 'baseline-path': '/b', 'namespace-map-path': '/m.json' },
    });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a paths object WITHOUT namespace-map-path (additive back-compat)', () => {
    const cfg = validConfig({ paths: { 'vault-dir': '/v' } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a non-string paths.namespace-map-path member (#725)', () => {
    const cfg = validConfig({ paths: { 'namespace-map-path': 42 } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('paths.namespace-map-path must be a string');
  });

  it('accepts a legacy config WITHOUT a paths key (absent-tolerant back-compat)', () => {
    const cfg = validConfig();
    expect(cfg.paths).toBeUndefined();
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects paths as a string (not an object)', () => {
    const cfg = validConfig({ paths: 'oops' });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('paths must be an object when present');
  });

  it('rejects a non-string paths.vault-dir member', () => {
    const cfg = validConfig({ paths: { 'vault-dir': 42 } });
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('paths.vault-dir must be a string');
  });
});

// ---------------------------------------------------------------------------
// loadOwnerConfig
// ---------------------------------------------------------------------------

describe('loadOwnerConfig — file absent', () => {
  it('returns defaults with source "defaults" when file does not exist', () => {
    const dir = makeTmpDir();
    const result = loadOwnerConfig({ path: join(dir, 'nonexistent.yaml') });
    expect(result.source).toBe('defaults');
    expect(result.config).toBeDefined();
    expect(result.errors).toHaveLength(0);
    // config should have the known default language
    expect(result.config.owner.language).toBe('en');
  });
});

describe('loadOwnerConfig — valid file', () => {
  it('returns parsed config with source "file"', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'owner.yaml');
    const cfg = validConfig({ owner: { name: 'Bernhard', language: 'de' } });
    // Write via writeOwnerConfig so there is no external yaml dependency here
    writeOwnerConfig(cfg, { path: filePath });

    const result = loadOwnerConfig({ path: filePath });
    expect(result.source).toBe('file');
    expect(result.errors).toHaveLength(0);
    expect(result.config.owner.name).toBe('Bernhard');
    expect(result.config.owner.language).toBe('de');
  });
});

describe('loadOwnerConfig — invalid YAML file', () => {
  it('returns defaults and errors when file contains invalid YAML', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'bad.yaml');
    writeFileSync(filePath, '{ unclosed: [bracket\nstill going', 'utf8');

    const result = loadOwnerConfig({ path: filePath });
    expect(result.source).toBe('defaults');
    expect(result.errors.length).toBeGreaterThan(0);
    // Errors should mention the parse issue
    expect(result.errors.some((e) => /yaml|parse/i.test(e))).toBe(true);
  });

  it('returns defaults and errors when file has valid YAML but fails schema', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'invalid-schema.yaml');
    writeFileSync(filePath, 'owner:\n  name: ""\n  language: "xx"\ntone:\n  style: "bad"\nefficiency:\n  output-level: "??"\n  preamble: "??"\nhardware-sharing:\n  enabled: false\n  hash-salt: ""\n', 'utf8');

    const result = loadOwnerConfig({ path: filePath });
    expect(result.source).toBe('defaults');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// writeOwnerConfig
// ---------------------------------------------------------------------------

describe('writeOwnerConfig', () => {
  it('writes valid config to disk and returns written=true', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'owner.yaml');
    const cfg = validConfig({ owner: { name: 'Alice', language: 'en' } });

    const result = writeOwnerConfig(cfg, { path: filePath });
    expect(result.written).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(existsSync(filePath)).toBe(true);
  });

  it('written file contains the expected owner name', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'owner.yaml');
    const cfg = validConfig({ owner: { name: 'Bob', language: 'de' } });

    writeOwnerConfig(cfg, { path: filePath });
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('Bob');
  });

  it('creates parent directory if it does not exist', () => {
    const dir = makeTmpDir();
    const nestedPath = join(dir, 'deep', 'nested', 'dir', 'owner.yaml');
    const cfg = validConfig();

    const result = writeOwnerConfig(cfg, { path: nestedPath });
    expect(result.written).toBe(true);
    expect(existsSync(nestedPath)).toBe(true);
  });

  it('rejects invalid config without touching the filesystem', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'owner.yaml');
    const badCfg = validConfig({ owner: { name: '', language: 'fr' } });

    const result = writeOwnerConfig(badCfg, { path: filePath });
    expect(result.written).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it('written YAML round-trips through loadOwnerConfig correctly', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'owner.yaml');
    const cfg = validConfig({ owner: { name: 'Roundtrip', language: 'en' }, tone: { style: 'direct', tonality: 'terse' } });

    writeOwnerConfig(cfg, { path: filePath });
    const loaded = loadOwnerConfig({ path: filePath });
    expect(loaded.source).toBe('file');
    expect(loaded.config.owner.name).toBe('Roundtrip');
    expect(loaded.config.tone.style).toBe('direct');
    expect(loaded.config.tone.tonality).toBe('terse');
  });

  it('returns errors without writing when config is not a plain object', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'owner.yaml');

    const result = writeOwnerConfig('not an object', { path: filePath });
    expect(result.written).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// vaults: section (#700) — named-vault list validation
// ---------------------------------------------------------------------------

describe('vaults: section (#700) — absent/null is backward-compat no-op', () => {
  it('legacy owner.yaml WITHOUT a vaults: key still loads without error', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'owner.yaml');
    const cfg = validConfig();          // no vaults key
    expect(cfg.vaults).toBeUndefined();
    writeOwnerConfig(cfg, { path: filePath });

    const result = loadOwnerConfig({ path: filePath });
    expect(result.source).toBe('file');
    expect(result.errors).toHaveLength(0);
    expect(result.config.vaults).toBeUndefined();
  });

  it('vaults: null accepted by validateOwnerConfig without errors', () => {
    const cfg = { ...validConfig(), vaults: null };
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('vaults: section (#700) — valid list', () => {
  it('accepts a single well-formed vault entry', () => {
    const cfg = validConfigWithVaults([
      { name: 'bernhard', suffix: '/agents/vault', root: '~/v' },
    ]);
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('preserves name, suffix, root values through write→load round-trip', () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'owner.yaml');
    const cfg = validConfigWithVaults([
      { name: 'bernhard', suffix: '/agents/vault', root: '~/vault-dir' },
    ]);
    writeOwnerConfig(cfg, { path: filePath });

    const loaded = loadOwnerConfig({ path: filePath });
    expect(loaded.source).toBe('file');
    expect(loaded.errors).toHaveLength(0);
    expect(loaded.config.vaults).toHaveLength(1);
    expect(loaded.config.vaults[0].name).toBe('bernhard');
    expect(loaded.config.vaults[0].suffix).toBe('/agents/vault');
    expect(loaded.config.vaults[0].root).toBe('~/vault-dir');
  });

  it('accepts a vault entry with an optional match.org-prefix', () => {
    const cfg = validConfigWithVaults([
      {
        name: 'bernhard',
        suffix: '/agents/vault',
        root: '~/v',
        match: { 'org-prefix': 'bernhard-group' },
      },
    ]);
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts multiple vault entries', () => {
    const cfg = validConfigWithVaults([
      { name: 'vault-a', suffix: '/agents/vault', root: '~/a' },
      { name: 'vault-b', suffix: '/agents/vault-b', root: '~/b' },
    ]);
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('vaults: section (#700) — validation rejects malformed entries', () => {
  it('rejects vaults: as a string (not an array)', () => {
    const cfg = { ...validConfig(), vaults: 'oops' };
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('vaults must be an array when present');
  });

  it('rejects an entry missing name field', () => {
    const cfg = validConfigWithVaults([{ suffix: '/agents/vault', root: '~/v' }]);
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('vaults[0].name'))).toBe(true);
  });

  it('rejects an entry with empty string name', () => {
    const cfg = validConfigWithVaults([{ name: '', suffix: '/agents/vault', root: '~/v' }]);
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('vaults[0].name'))).toBe(true);
  });

  it('rejects an entry missing suffix field', () => {
    const cfg = validConfigWithVaults([{ name: 'v', root: '~/v' }]);
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('vaults[0].suffix'))).toBe(true);
  });

  it('rejects an entry missing root field', () => {
    const cfg = validConfigWithVaults([{ name: 'v', suffix: '/agents/vault' }]);
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('vaults[0].root'))).toBe(true);
  });

  it('rejects an entry where match is not an object', () => {
    const cfg = validConfigWithVaults([
      { name: 'v', suffix: '/agents/vault', root: '~/v', match: 'not-an-object' },
    ]);
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('vaults[0].match'))).toBe(true);
  });

  it('rejects vaults[0] as null', () => {
    const cfg = validConfigWithVaults([null]);
    const result = validateOwnerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('vaults[0]'))).toBe(true);
  });
});
