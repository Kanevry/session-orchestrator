/**
 * tests/monitors/monitors-triggers.test.mjs
 *
 * NAMED BUG (2026-09-06 Wave 1, d1-skills-a): the `ecosystem-health` monitor was
 * registered with `"when": "on-skill-invoke:ecosystem-health"` — a SELF-REFERENTIAL
 * trigger. The watcher could only start when the `ecosystem-health` skill ran, and
 * that skill has 0 recorded invocations fleet-wide, so the watcher never started
 * once. Its sibling `convergence-monitor` hangs on `on-skill-invoke:wave-executor`
 * and is hot on every wave, which is the shape a trigger has to have.
 *
 * The general invariant these tests pin: no monitor may be triggered by the skill
 * it is named after, because that is the one skill whose invocation the monitor
 * exists to observe from the outside.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const monitors = JSON.parse(readFileSync(join(REPO_ROOT, 'monitors', 'monitors.json'), 'utf8'));

const PREFIX = 'on-skill-invoke:';

describe('monitors/monitors.json triggers', () => {
  it('no monitor is hung on the skill it is named after (self-referential trigger)', () => {
    const selfHung = monitors
      .filter((m) => typeof m.when === 'string' && m.when.startsWith(PREFIX))
      .filter((m) => m.when.slice(PREFIX.length) === m.name)
      .map((m) => `${m.name} → ${m.when}`);
    expect(selfHung).toEqual([]);
  });

  it('ecosystem-health is triggered by a skill that actually runs', () => {
    const m = monitors.find((e) => e.name === 'ecosystem-health');
    expect(m).toBeTruthy();
    expect(m.when).toBe('on-skill-invoke:session-start');
  });

  it('convergence-monitor is untouched', () => {
    const m = monitors.find((e) => e.name === 'convergence-monitor');
    expect(m.when).toBe('on-skill-invoke:wave-executor');
  });

  it('every monitor names a trigger', () => {
    for (const m of monitors) {
      expect(typeof m.when, `monitor ${m.name} has no when`).toBe('string');
      expect(m.when.length).toBeGreaterThan(0);
    }
  });
});
