/**
 * config-vault.test.mjs — split from config.test.mjs (#912 TV-003 de-hotspot).
 *
 * vault-integration / vault-staleness / #217 gate-mode parsing.
 * Feature-domain slice of the former monolithic config.test.mjs. Split by
 * domain to reduce merge-conflict churn on a single hotspot file. Tests were
 * moved 1:1 from config.test.mjs — no behaviour change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionConfig } from '@lib/config.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

function readFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('vault-integration nested object', () => {
  // Hermetic ctx (issue #783): the default hostPaths tier reads the REAL
  // owner.yaml — a host-local `paths.vault-dir` override (set on this
  // machine) would otherwise WIN over the fixture/committed `vault-dir`
  // value and bleed into these committed-value assertions (the exact
  // LOCAL-RED/CI-GREEN class documented in #783). Inject an empty ctx to
  // pin the COMMITTED tier, mirroring the `hermetic` pattern below (#497).
  const hermetic = { hostPaths: { env: {}, ownerConfig: undefined } };

  it('returns vault-integration with enabled, vault-dir, mode keys when absent', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['vault-integration']).toHaveProperty('enabled');
    expect(config['vault-integration']).toHaveProperty('vault-dir');
    expect(config['vault-integration']).toHaveProperty('mode');
  });

  it('defaults vault-integration.enabled to false', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['vault-integration'].enabled).toBe(false);
  });

  it('defaults vault-integration.vault-dir to null', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'), hermetic);
    expect(config['vault-integration']['vault-dir']).toBeNull();
  });

  it('defaults vault-integration.mode to warn', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['vault-integration'].mode).toBe('warn');
  });

  it('parses explicit vault-integration sub-keys from Session Config block form', () => {
    // Post-#593: vault-integration is a content-scoped block parser. Top-level
    // `enabled:` / `vault-dir:` / `mode:` lines outside a `vault-integration:`
    // block no longer bind here (they did pre-#593 due to KV-map collision —
    // which silently let any peer block's `enabled: false` overwrite this).
    const content = [
      '## Session Config',
      '',
      'vault-integration:',
      '  enabled: true',
      '  vault-dir: /secrets/vault',
      '  mode: strict',
    ].join('\n');
    const config = parseSessionConfig(content, hermetic);
    expect(config['vault-integration'].enabled).toBe(true);
    expect(config['vault-integration']['vault-dir']).toBe('/secrets/vault');
    expect(config['vault-integration'].mode).toBe('strict');
  });

  it('issue #593 — peer block enabled:false does not shadow vault-integration.enabled:true', () => {
    // The pre-#593 regression: `enabled` was read from a flat KV map shared
    // with 15+ peer config blocks (docs-orchestrator, slopcheck, etc.).
    // Whichever block defined `enabled:` last in the file silently
    // overwrote vault-integration.enabled — disabling vault-sync + vault-mirror.
    const content = [
      '## Session Config',
      '',
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
    ].join('\n');
    // Hermetic: a host-local `vault-integration: { enabled: false }` (SO#1448) would
    // otherwise lower the committed `enabled: true` asserted here.
    const config = parseSessionConfig(content, hermetic);
    expect(config['vault-integration'].enabled).toBe(true);
  });

  it('defaults vault-sync to disabled with empty exclude list', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['vault-sync'].enabled).toBe(false);
    expect(config['vault-sync'].exclude).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Host-local vault-dir match tier (agents/vault#319)
// ---------------------------------------------------------------------------

describe('vault-dir: owner.yaml vault-dirs match tier (agents/vault#319)', () => {
  // Committed value names neither host vault, so any hit below is a host tier.
  const content = [
    '## Session Config',
    '',
    'vault-integration:',
    '  enabled: true',
    '  vault-dir: /committed/vault',
    '  mode: warn',
    '',
    'vault-sync:',
    '  enabled: true',
    '  vault-dir: /committed/vault',
  ].join('\n');
  const OWNER_WIDE = '/hosts/h1/Projects/vault'; // paths.vault-dir: the host-wide vault (A)
  const MATCHED = '/hosts/h1/Projects/private/vault'; // vault-dirs entry (B)
  const ownerConfig = {
    paths: { 'vault-dir': OWNER_WIDE },
    'vault-dirs': [{ path: MATCHED, match: { 'path-prefix': '/hosts/h1/Projects/private/' } }],
  };

  // Bug #319: paths.vault-dir silently overrode the repo's own vault, and the two
  // call sites (vault-integration, vault-sync) could drift apart.
  it('cwd under the prefix resolves both vault-integration and vault-sync to the match, source "match"', () => {
    const config = parseSessionConfig(content, {
      hostPaths: { env: {}, ownerConfig, cwd: '/hosts/h1/Projects/private/vault' },
    });
    expect(config['vault-integration']['vault-dir']).toBe(MATCHED);
    expect(config['vault-integration']['vault-dir-source']).toBe('match');
    expect(config['vault-sync']['vault-dir']).toBe(MATCHED);
  });

  // Bug: the match spills over onto repos outside the prefix.
  it('cwd outside the prefix keeps paths.vault-dir, source "owner"', () => {
    const config = parseSessionConfig(content, {
      hostPaths: { env: {}, ownerConfig, cwd: '/hosts/h1/Projects/other-repo' },
    });
    expect(config['vault-integration']['vault-dir']).toBe(OWNER_WIDE);
    expect(config['vault-integration']['vault-dir-source']).toBe('owner');
    expect(config['vault-sync']['vault-dir']).toBe(OWNER_WIDE);
  });

  // Bug (#319 review): owner.yaml `~/…` came back literal, and consumers that
  // `resolve()` it (vault-mirror.mjs existsSync) looked in `<cwd>/~/…`.
  it.each([
    { tier: 'match', cwd: '/hosts/h1/Projects/private/repo' },
    { tier: 'owner', cwd: '/hosts/h1/Projects/other-repo' },
  ])('tilde-expands the owner.yaml $tier tier', ({ tier, cwd }) => {
    const tildeOwner = {
      paths: { 'vault-dir': '~/wide-vault' },
      'vault-dirs': [{ path: '~/private-vault', match: { 'path-prefix': '/hosts/h1/Projects/private/' } }],
    };
    const config = parseSessionConfig(content, { hostPaths: { env: {}, ownerConfig: tildeOwner, cwd } });
    const want = join(homedir(), tier === 'match' ? 'private-vault' : 'wide-vault');
    expect(config['vault-integration']['vault-dir']).toBe(want);
    expect(config['vault-integration']['vault-dir-source']).toBe(tier);
    expect(config['vault-sync']['vault-dir']).toBe(want);
  });
});

// ---------------------------------------------------------------------------
// Host-local vault-integration switch (SO#1448) — lower-only
// ---------------------------------------------------------------------------

describe('vault-integration host switch (SO#1448)', () => {
  const committed = (enabled, mode) =>
    ['## Session Config', '', 'vault-integration:', `  enabled: ${enabled}`, `  mode: ${mode}`].join(
      '\n',
    );

  it.each([
    {
      // Bug SO#1448: no host-local way to turn a committed strict gate off.
      name: 'owner enabled:false lowers committed strict to off',
      md: committed(true, 'strict'),
      env: {},
      owner: { enabled: false },
      want: { enabled: false, mode: 'off', 'host-override': 'owner.yaml' },
    },
    {
      // Bug: wrong precedence — owner.yaml beating the env var.
      name: 'SO_VAULT_INTEGRATION=off beats owner mode:warn',
      md: committed(true, 'strict'),
      env: { SO_VAULT_INTEGRATION: 'off' },
      owner: { mode: 'warn' },
      want: { enabled: false, mode: 'off', 'host-override': 'env:SO_VAULT_INTEGRATION' },
    },
    {
      // Bug: lowering strict to warn also cleared enabled, turning the mirror off
      // where the host only asked for a softer gate.
      name: 'SO_VAULT_INTEGRATION=warn lowers committed strict to warn, stays enabled',
      md: committed(true, 'strict'),
      env: { SO_VAULT_INTEGRATION: 'warn' },
      owner: {},
      want: { enabled: true, mode: 'warn', 'host-override': 'env:SO_VAULT_INTEGRATION' },
    },
    {
      // Bug: the host raises the gate and mirrors a repo that never opted in.
      name: 'owner mode:strict does not enable a committed enabled:false',
      md: committed(false, 'warn'),
      env: {},
      owner: { mode: 'strict' },
      want: { enabled: false, mode: 'warn', 'host-override': null },
    },
    {
      name: 'owner enabled:true does not enable a committed enabled:false',
      md: committed(false, 'warn'),
      env: {},
      owner: { enabled: true },
      want: { enabled: false, mode: 'warn', 'host-override': null },
    },
    {
      name: 'owner mode:strict does not raise a committed warn',
      md: committed(true, 'warn'),
      env: {},
      owner: { mode: 'strict' },
      want: { enabled: true, mode: 'warn', 'host-override': null },
    },
  ])('$name', ({ md, env, owner, want }) => {
    const config = parseSessionConfig(md, {
      hostPaths: { env, ownerConfig: { 'vault-integration': owner } },
    });
    const vi = config['vault-integration'];
    expect({ enabled: vi.enabled, mode: vi.mode, 'host-override': vi['host-override'] }).toEqual(
      want,
    );
  });
});

// ---------------------------------------------------------------------------
// vault-staleness parsing
// ---------------------------------------------------------------------------

describe('vault-staleness parsing', () => {
  it('returns defaults when vault-staleness key is absent', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['vault-staleness']).toEqual({
      enabled: false,
      thresholds: { top: 30, active: 60, archived: 180 },
      mode: 'warn',
    });
  });

  it('parses custom threshold values', () => {
    const content = [
      '## Session Config',
      '',
      'vault-staleness:',
      '  enabled: true',
      '  thresholds:',
      '    top: 7',
      '    active: 14',
      '    archived: 60',
      '  mode: strict',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['vault-staleness'].enabled).toBe(true);
    expect(config['vault-staleness'].thresholds.top).toBe(7);
    expect(config['vault-staleness'].thresholds.active).toBe(14);
    expect(config['vault-staleness'].thresholds.archived).toBe(60);
    expect(config['vault-staleness'].mode).toBe('strict');
  });

  it('silently keeps default for negative threshold top: -5', () => {
    const content = [
      '## Session Config',
      '',
      'vault-staleness:',
      '  thresholds:',
      '    top: -5',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['vault-staleness'].thresholds.top).toBe(30);
  });

  it('silently keeps default for zero threshold', () => {
    const content = [
      '## Session Config',
      '',
      'vault-staleness:',
      '  thresholds:',
      '    active: 0',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['vault-staleness'].thresholds.active).toBe(60);
  });

  it('silently defaults vault-staleness mode to warn when mode: hard is given (#217 regression guard)', () => {
    const content = [
      '## Session Config',
      '',
      'vault-staleness:',
      '  enabled: true',
      '  mode: hard',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['vault-staleness'].mode).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// #217 regression — vault-sync and drift-check no longer accept "hard" mode
// ---------------------------------------------------------------------------

describe('#217 regression — hard-mode handling by gate', () => {
  it('vault-sync.mode: hard silently defaults to warn', () => {
    const content = [
      '## Session Config',
      '',
      'vault-sync:',
      '  enabled: true',
      '  mode: hard',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['vault-sync'].mode).toBe('warn');
  });

  it('drift-check.mode: strict is accepted (was silently downgraded to warn pre-fix)', () => {
    const content = [
      '## Session Config',
      '',
      'drift-check:',
      '  enabled: true',
      '  mode: strict',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['drift-check'].mode).toBe('strict');
  });

  it('drift-check.mode: hard normalizes to strict (legacy alias — #217 drift-check half)', () => {
    const content = [
      '## Session Config',
      '',
      'drift-check:',
      '  enabled: true',
      '  mode: hard',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['drift-check'].mode).toBe('strict');
  });
});
