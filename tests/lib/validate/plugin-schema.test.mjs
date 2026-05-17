/**
 * tests/lib/validate/plugin-schema.test.mjs
 *
 * Verifies $schema declarations in .claude-plugin/plugin.json and
 * .claude-plugin/marketplace.json, required field presence, the
 * experimental.monitors regression guard, and the canary script
 * check-plugin-schema.mjs (issue #433).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../../..');
const PLUGIN_JSON = path.join(PLUGIN_ROOT, '.claude-plugin/plugin.json');
const MARKETPLACE_JSON = path.join(PLUGIN_ROOT, '.claude-plugin/marketplace.json');
const CANARY = path.join(PLUGIN_ROOT, 'scripts/lib/validate/check-plugin-schema.mjs');

describe('plugin $schema validation (#433)', () => {
  it('plugin.json has correct $schema URL', () => {
    const plugin = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
    expect(plugin.$schema).toBe('https://json.schemastore.org/claude-code-plugin-manifest.json');
  });

  it('marketplace.json has correct $schema URL', () => {
    const marketplace = JSON.parse(readFileSync(MARKETPLACE_JSON, 'utf8'));
    expect(marketplace.$schema).toBe('https://json.schemastore.org/claude-code-marketplace.json');
  });

  it('plugin.json preserves required field "name"', () => {
    const plugin = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
    expect(plugin.name).toBe('session-orchestrator');
  });

  it('marketplace.json preserves required fields name/owner/plugins', () => {
    const m = JSON.parse(readFileSync(MARKETPLACE_JSON, 'utf8'));
    expect(m.name).toBeTruthy();
    expect(m.owner).toBeTruthy();
    expect(Array.isArray(m.plugins)).toBe(true);
  });

  it('plugin.json STILL has experimental.monitors from W2-I4 (no regression)', () => {
    const plugin = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
    expect(plugin.experimental?.monitors).toBe('./monitors/monitors.json');
  });

  describe('canary check-plugin-schema.mjs', () => {
    it('exists', () => {
      expect(existsSync(CANARY)).toBe(true);
    });

    it('exits 0', () => {
      const result = spawnSync('node', [CANARY, PLUGIN_ROOT], { encoding: 'utf8' });
      expect(result.status).toBe(0);
    });
  });
});
