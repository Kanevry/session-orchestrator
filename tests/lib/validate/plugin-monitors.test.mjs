/**
 * tests/lib/validate/plugin-monitors.test.mjs
 *
 * Tests for the plugin monitors registration (#427):
 *   - .claude-plugin/plugin.json declares experimental.monitors
 *   - monitors/monitors.json schema compliance (array, required fields,
 *     unique names, no interval_seconds, required entries present)
 *   - watcher scripts exist on disk
 *   - canary script exists and exits 0 with >= 9 PASS lines
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../../..');
const PLUGIN_JSON = path.join(PLUGIN_ROOT, '.claude-plugin/plugin.json');
const MONITORS_JSON = path.join(PLUGIN_ROOT, 'monitors/monitors.json');
const CANARY = path.join(PLUGIN_ROOT, 'scripts/lib/validate/check-plugin-monitors.mjs');
const ECOSYSTEM_SCRIPT = path.join(PLUGIN_ROOT, 'scripts/lib/ecosystem-health.mjs');
const CONVERGENCE_SCRIPT = path.join(PLUGIN_ROOT, 'scripts/lib/convergence-monitor.mjs');

describe('plugin monitors (#427)', () => {
  describe('.claude-plugin/plugin.json', () => {
    const plugin = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));

    it('declares experimental.monitors path', () => {
      expect(plugin.experimental?.monitors).toBe('./monitors/monitors.json');
    });
  });

  describe('monitors/monitors.json', () => {
    const monitors = JSON.parse(readFileSync(MONITORS_JSON, 'utf8'));

    it('is an array with 2 entries', () => {
      expect(Array.isArray(monitors)).toBe(true);
      expect(monitors.length).toBeGreaterThanOrEqual(2);
      expect(monitors.length).toBeLessThanOrEqual(20);
    });

    it('every entry has name, command, description', () => {
      for (const m of monitors) {
        expect(typeof m.name).toBe('string');
        expect(m.name.length).toBeGreaterThan(0);
        expect(typeof m.command).toBe('string');
        expect(m.command.length).toBeGreaterThan(0);
        expect(typeof m.description).toBe('string');
        expect(m.description.length).toBeGreaterThan(0);
      }
    });

    it('NO entry has interval_seconds (per CC schema — monitors are persistent processes, not polled)', () => {
      for (const m of monitors) {
        expect(m.interval_seconds).toBeUndefined();
      }
    });

    it('all entry names are unique', () => {
      const names = monitors.map((m) => m.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('includes ecosystem-health watcher', () => {
      expect(monitors.some((m) => m.name === 'ecosystem-health')).toBe(true);
    });

    it('includes convergence-monitor watcher', () => {
      expect(monitors.some((m) => m.name === 'convergence-monitor')).toBe(true);
    });
  });

  describe('watcher scripts exist', () => {
    it('scripts/lib/ecosystem-health.mjs exists', () => {
      expect(existsSync(ECOSYSTEM_SCRIPT)).toBe(true);
    });

    it('scripts/lib/convergence-monitor.mjs exists', () => {
      expect(existsSync(CONVERGENCE_SCRIPT)).toBe(true);
    });
  });

  describe('canary check-plugin-monitors.mjs', () => {
    it('exists', () => {
      expect(existsSync(CANARY)).toBe(true);
    });

    it('exits 0 (all checks pass)', () => {
      const result = spawnSync('node', [CANARY, PLUGIN_ROOT], { encoding: 'utf8' });
      expect(result.status).toBe(0);
    });

    it('reports at least 9 PASS lines', () => {
      const result = spawnSync('node', [CANARY, PLUGIN_ROOT], { encoding: 'utf8' });
      const passCount = (result.stdout.match(/PASS:/g) || []).length;
      expect(passCount).toBeGreaterThanOrEqual(9);
    });
  });
});
