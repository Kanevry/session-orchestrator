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
    const config = parseSessionConfig(content);
    expect(config['vault-integration'].enabled).toBe(true);
  });

  it('defaults vault-sync to disabled with empty exclude list', () => {
    const config = parseSessionConfig(readFixture('config-minimal.md'));
    expect(config['vault-sync'].enabled).toBe(false);
    expect(config['vault-sync'].exclude).toEqual([]);
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
