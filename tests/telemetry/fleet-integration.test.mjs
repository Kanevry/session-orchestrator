/**
 * tests/telemetry/fleet-integration.test.mjs — FA5 fleet-mode REAL owner.yaml
 * chain (Epic #841 W4-Panel Q2).
 *
 * Every prior fleet-mode test injects an `ownerConfig` OBJECT directly — none
 * writes a genuine owner.yaml to disk and proves the parse -> resolveConsent
 * -> buildUsagePing passthrough end to end. This file does exactly that,
 * using the REAL modules (loadOwnerConfig, resolveConsent, buildUsagePing)
 * against an isolated mkdtempSync directory — no mocks.
 *
 * Core invariant under test (the D2-contract "unknown-section passthrough"):
 * `telemetry:` is not a section owner-yaml.mjs's schema knows about (it only
 * validates owner/tone/efficiency/hardware-sharing/paths/dispatcher/vaults/
 * baselines) — it must survive `loadOwnerConfig()` untouched so the fleet
 * flag at `telemetry.enabled` reaches `resolveConsent()` and `buildUsagePing()`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadOwnerConfig } from '../../scripts/lib/owner-yaml.mjs';
import { resolveConsent } from '../../scripts/lib/telemetry/consent.mjs';
import { buildUsagePing } from '../../scripts/lib/telemetry/schema.mjs';

const START = '2026-07-20T00:00:00.000Z';

/** Minimal owner.yaml — all four REQUIRED sections valid, plus a fleet-enabled
 * `telemetry:` section (an unknown/optional-passthrough top-level key). */
const MINIMAL_FLEET_OWNER_YAML = `
owner:
  name: Test Owner
  language: en
tone:
  style: neutral
efficiency:
  output-level: full
  preamble: minimal
hardware-sharing:
  enabled: false
telemetry:
  enabled: true
`;

let tmp;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('fleet-integration: real owner.yaml -> loadOwnerConfig -> resolveConsent -> buildUsagePing', () => {
  it('a real on-disk owner.yaml with telemetry.enabled:true survives loadOwnerConfig unchanged (unknown-section passthrough)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'so-telemetry-fleet-'));
    const ownerYamlPath = join(tmp, 'owner.yaml');
    writeFileSync(ownerYamlPath, MINIMAL_FLEET_OWNER_YAML, 'utf8');

    const result = loadOwnerConfig({ path: ownerYamlPath });

    expect(result.source).toBe('file');
    expect(result.errors).toEqual([]);
    expect(result.config.telemetry).toEqual({ enabled: true });
  });

  it('resolveConsent grants enabled-fleet from the real parsed owner.yaml with no stored consent and no env override', () => {
    tmp = mkdtempSync(join(tmpdir(), 'so-telemetry-fleet-'));
    const ownerYamlPath = join(tmp, 'owner.yaml');
    writeFileSync(ownerYamlPath, MINIMAL_FLEET_OWNER_YAML, 'utf8');
    const { config } = loadOwnerConfig({ path: ownerYamlPath });

    const consent = resolveConsent({ env: {}, ownerConfig: config, state: null, interactive: false });

    expect(consent).toEqual({
      state: 'enabled-fleet',
      send: true,
      prompt: false,
      reason: 'owner.yaml telemetry.enabled=true',
    });
  });

  it('a per-shell SO_TELEMETRY_DISABLED=1 still overrides the real fleet-enabled owner.yaml (FA5 escape hatch)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'so-telemetry-fleet-'));
    const ownerYamlPath = join(tmp, 'owner.yaml');
    writeFileSync(ownerYamlPath, MINIMAL_FLEET_OWNER_YAML, 'utf8');
    const { config } = loadOwnerConfig({ path: ownerYamlPath });

    const consent = resolveConsent({
      env: { SO_TELEMETRY_DISABLED: '1' },
      ownerConfig: config,
      state: null,
      interactive: false,
    });

    expect(consent).toEqual({
      state: 'disabled-env',
      send: false,
      prompt: false,
      reason: 'SO_TELEMETRY_DISABLED=1',
    });
  });

  it('buildUsagePing stamps fleet:true from the real parsed owner.yaml', () => {
    tmp = mkdtempSync(join(tmpdir(), 'so-telemetry-fleet-'));
    const ownerYamlPath = join(tmp, 'owner.yaml');
    writeFileSync(ownerYamlPath, MINIMAL_FLEET_OWNER_YAML, 'utf8');
    const { config } = loadOwnerConfig({ path: ownerYamlPath });

    const sessionRecord = { session_type: 'housekeeping', started_at: START, completed_at: START };
    const roster = { skills: new Set(), commands: new Set() };

    const ping = buildUsagePing({
      sessionRecord,
      skillInvocations: [],
      ownerConfig: config,
      env: {},
      now: START,
      roster,
    });

    expect(ping.fleet).toBe(true);
  });
});
