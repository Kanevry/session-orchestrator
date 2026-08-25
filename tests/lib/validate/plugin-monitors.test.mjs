/**
 * tests/lib/validate/plugin-monitors.test.mjs
 *
 * Plugin monitor registration (#427).
 *
 * Division of labour (W4-T1 consolidation, 2026-08-25): the canary
 * `scripts/lib/validate/check-plugin-monitors.mjs` already performs checks 1-11
 * — plugin.json readable, `experimental.monitors` present + resolvable, the
 * monitors file valid JSON, array length >= 2, required fields per entry,
 * unique names, the three required entry names, and the three watcher scripts
 * on disk — and the suite RUNS that canary below. Seven vitest cases
 * re-implemented those same checks in JS; they are gone. What remains is
 * exactly what the canary does NOT cover:
 *
 *   - the `interval_seconds` ban (not a canary check at all)
 *   - the array CEILING (canary asserts only the >= 2 floor)
 *   - the required-name pins, which are independent of the canary's own
 *     self-referential REQUIRED_MONITOR_NAMES list: a deletion that drops an
 *     entry from BOTH files keeps the canary green
 *   - the canary's own PASS-line floor, which is what catches a check being
 *     silently removed FROM the canary while it still exits 0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../../..');
const MONITORS_JSON = path.join(PLUGIN_ROOT, 'monitors/monitors.json');
const CANARY = path.join(PLUGIN_ROOT, 'scripts/lib/validate/check-plugin-monitors.mjs');

describe('plugin monitors (#427)', () => {
  const monitors = JSON.parse(readFileSync(MONITORS_JSON, 'utf8'));

  it('is an array within the floor/ceiling corridor', () => {
    expect(Array.isArray(monitors)).toBe(true);
    expect(monitors.length).toBeGreaterThanOrEqual(2);
    expect(monitors.length).toBeLessThanOrEqual(20);
  });

  it('NO entry has interval_seconds (per CC schema — monitors are persistent processes, not polled)', () => {
    // Not a canary check: monitors are long-lived processes that control their
    // own cadence, so an `interval_seconds` key would be silently ignored by
    // Claude Code while reading as configured cadence in review.
    expect(monitors.filter((m) => m.interval_seconds !== undefined)).toEqual([]);
  });

  // The canary checks these names too — but against its OWN
  // REQUIRED_MONITOR_NAMES list, which is self-referential: a deletion that
  // drops an entry from monitors.json AND from that list keeps the canary
  // green. These independent pins are what catch a watcher silently vanishing.
  it.each(['ecosystem-health', 'convergence-monitor', 'wave-transcript-tail'])(
    'registers the %s watcher',
    (name) => {
      expect(monitors.some((m) => m.name === name)).toBe(true);
    },
  );

  it('canary check-plugin-monitors.mjs exits 0 and still reports at least 9 PASS lines', () => {
    // Exit 0 covers canary checks 1-11 (schema, required fields, unique names,
    // watcher scripts on disk). The PASS floor is the second half: a check
    // deleted FROM the canary leaves it exiting 0 while covering less.
    const result = spawnSync('node', [CANARY, PLUGIN_ROOT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect((result.stdout.match(/PASS:/g) || []).length).toBeGreaterThanOrEqual(9);
  });
});
