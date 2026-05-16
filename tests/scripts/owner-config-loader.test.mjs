/**
 * tests/scripts/owner-config-loader.test.mjs
 *
 * Vitest suite for scripts/lib/owner-config-loader.mjs — file-system loader
 * for ~/.config/session-orchestrator/owner.yaml. Uses tmpdir fixtures so the
 * real user home is never touched.
 *
 * Issue #174 (D1 of Sub-Epic #161 — Owner Persona Layer).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadOwnerConfig,
  resolveOwnerConfigPath,
} from '@lib/owner-config-loader.mjs';

const HEX64 = 'a'.repeat(64);

const VALID_YAML = `schema-version: 1
owner:
  name: Bernhard
  language: de
tone:
  style: direct
efficiency:
  output-level: lite
`;

describe('owner-config-loader resolveOwnerConfigPath()', () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
  });

  it('honours XDG_CONFIG_HOME when set', () => {
    process.env.XDG_CONFIG_HOME = '/custom/xdg';
    const p = resolveOwnerConfigPath();
    expect(p).toBe('/custom/xdg/session-orchestrator/owner.yaml');
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    delete process.env.XDG_CONFIG_HOME;
    const p = resolveOwnerConfigPath();
    expect(p).toMatch(/[\\/]\.config[\\/]session-orchestrator[\\/]owner\.yaml$/);
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is empty string', () => {
    process.env.XDG_CONFIG_HOME = '';
    const p = resolveOwnerConfigPath();
    expect(p).toMatch(/[\\/]\.config[\\/]session-orchestrator[\\/]owner\.yaml$/);
  });
});

describe('owner-config-loader loadOwnerConfig()', () => {
  let tmp;
  let cfgPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owner-config-'));
    mkdirSync(join(tmp, 'session-orchestrator'), { recursive: true });
    cfgPath = join(tmp, 'session-orchestrator', 'owner.yaml');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns source=missing when the file does not exist (opt-in feature)', async () => {
    const r = await loadOwnerConfig({ path: cfgPath });
    expect(r).toEqual({
      ok: false,
      value: null,
      errors: [],
      source: 'missing',
      path: cfgPath,
    });
  });

  it('returns ok=true with normalized value for a valid file', async () => {
    writeFileSync(cfgPath, VALID_YAML, 'utf8');
    const r = await loadOwnerConfig({ path: cfgPath });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('file');
    expect(r.errors).toEqual([]);
    expect(r.value.owner.name).toBe('Bernhard');
    expect(r.value.owner.language).toBe('de');
    expect(r.value.tone.style).toBe('direct');
    expect(r.value.efficiency['output-level']).toBe('lite');
    // Defaults applied for unspecified fields:
    expect(r.value.efficiency.preamble).toBe('minimal');
    expect(r.value['hardware-sharing'].enabled).toBe(false);
  });

  it('returns source=parse-error on malformed YAML', async () => {
    writeFileSync(cfgPath, 'schema-version: 1\nowner: { name: [unclosed', 'utf8');
    const r = await loadOwnerConfig({ path: cfgPath });
    expect(r.ok).toBe(false);
    expect(r.source).toBe('parse-error');
    expect(r.errors[0]).toMatch(/YAML parse error/);
    expect(r.value).toBeNull();
  });

  it('returns source=parse-error on an empty file', async () => {
    writeFileSync(cfgPath, '', 'utf8');
    const r = await loadOwnerConfig({ path: cfgPath });
    expect(r.ok).toBe(false);
    expect(r.source).toBe('parse-error');
    expect(r.errors).toEqual(['owner config is empty']);
  });

  it('returns source=validation-error when YAML parses but schema rejects', async () => {
    const badYaml = `schema-version: 1
owner:
  name: ""
  language: english
`;
    writeFileSync(cfgPath, badYaml, 'utf8');
    const r = await loadOwnerConfig({ path: cfgPath });
    expect(r.ok).toBe(false);
    expect(r.source).toBe('validation-error');
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    expect(r.errors.some((e) => e.includes('owner.name'))).toBe(true);
    expect(r.errors.some((e) => e.includes('owner.language'))).toBe(true);
  });

  it('returns source=validation-error when privacy contract is violated', async () => {
    const yaml = `schema-version: 1
owner: { name: x, language: en }
hardware-sharing:
  enabled: true
`;
    writeFileSync(cfgPath, yaml, 'utf8');
    const r = await loadOwnerConfig({ path: cfgPath });
    expect(r.ok).toBe(false);
    expect(r.source).toBe('validation-error');
    expect(r.errors.some((e) => e.includes('hash-salt'))).toBe(true);
  });

  it('round-trips a fully-populated config', async () => {
    const yaml = `schema-version: 1
owner:
  name: Test User
  email-hash: ${HEX64}
  language: en-US
tone:
  style: friendly
  tonality: minimal-comments
efficiency:
  output-level: ultra
  preamble: verbose
  comments-in-code: full
hardware-sharing:
  enabled: true
  hash-salt: ${HEX64}
defaults:
  preferred-test-command: pnpm test
  preferred-editor: code
metadata:
  created_at: "2026-04-28T10:00:00Z"
  updated_at: "2026-04-28T10:00:00Z"
`;
    writeFileSync(cfgPath, yaml, 'utf8');
    const r = await loadOwnerConfig({ path: cfgPath });
    expect(r.ok).toBe(true);
    expect(r.value.owner['email-hash']).toBe(HEX64);
    expect(r.value['hardware-sharing'].enabled).toBe(true);
    expect(r.value['hardware-sharing']['hash-salt']).toBe(HEX64);
    expect(r.value.defaults['preferred-test-command']).toBe('pnpm test');
    expect(r.value.metadata.created_at).toBe('2026-04-28T10:00:00Z');
  });

  it('uses the default resolved path when no opts.path is given (missing file)', async () => {
    // We don't write to the resolved path — only check that the loader uses
    // resolveOwnerConfigPath() under the hood and reports the resolved path
    // back to the caller. Setting XDG_CONFIG_HOME to tmp guarantees the path
    // points somewhere that almost certainly does not contain a real config.
    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    try {
      const r = await loadOwnerConfig();
      // tmp/session-orchestrator/owner.yaml does not exist (we deliberately
      // didn't write it for this test).
      expect(r.source).toBe('missing');
      expect(r.path).toBe(join(tmp, 'session-orchestrator', 'owner.yaml'));
    } finally {
      if (originalXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdg;
      }
    }
  });
});
