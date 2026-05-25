/**
 * tests/skills/tmux-layout-telemetry.test.mjs
 *
 * Unit tests for:
 *   scripts/lib/tmux-layout/telemetry.mjs     (emit, withTelemetry)
 *   scripts/lib/tmux-layout/telemetry-stats.mjs (readTmuxEvents, computeStats)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir;
let origCwd;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tmux-layout-telemetry-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

// Dynamic imports inside the test functions so each test gets a fresh module
// evaluation relative to the new cwd. We import at the top level here — the
// module caches process.cwd() at call time, NOT at import time (EVENTS_PATH is
// relative, resolved during appendFileSync). Module-level imports are fine.
import { emit, withTelemetry } from '../../scripts/lib/tmux-layout/telemetry.mjs';
import { readTmuxEvents, computeStats } from '../../scripts/lib/tmux-layout/telemetry-stats.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readEventsFile() {
  const eventsPath = join(tmpDir, '.orchestrator', 'metrics', 'events.jsonl');
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// emit() — tests 1-2
// ---------------------------------------------------------------------------

describe('emit()', () => {
  it('writes a JSON line to .orchestrator/metrics/events.jsonl with correct fields', () => {
    emit('tmux-layout.invoked', { layout: 'default' });

    const records = readEventsFile();
    expect(records).toHaveLength(1);
    expect(records[0].event).toBe('tmux-layout.invoked');
    expect(records[0].layout).toBe('default');
    // timestamp must be a valid ISO-8601 string
    expect(typeof records[0].timestamp).toBe('string');
    expect(new Date(records[0].timestamp).toISOString()).toBe(records[0].timestamp);
  });

  it('never throws when the events.jsonl directory is read-only (EACCES)', () => {
    // We test the "best-effort / never throws" contract by temporarily making
    // the .orchestrator/metrics directory read-only so appendFileSync throws EACCES.
    const metricsDir = join(tmpDir, '.orchestrator', 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    // Write a seed file so the dir exists before we lock it.
    writeFileSync(join(metricsDir, 'events.jsonl'), '');
    // r-xr-xr-x — directory not writable → appendFileSync throws EACCES
    chmodSync(metricsDir, 0o555);

    let threw = false;
    try {
      emit('tmux-layout.invoked', { layout: 'default' });
    } catch {
      threw = true;
    } finally {
      // Restore write permission so afterEach rmSync can clean up.
      chmodSync(metricsDir, 0o755);
    }

    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withTelemetry() — tests 3-6
// ---------------------------------------------------------------------------

describe('withTelemetry()', () => {
  it('emits tmux-layout.invoked then tmux-layout.completed for a successful fn', async () => {
    const fn = async () => ({ ok: true, panes: 4, error: undefined });
    const wrapped = withTelemetry('default', fn);

    await wrapped();

    const records = readEventsFile();
    expect(records).toHaveLength(2);

    const invoked = records.find((r) => r.event === 'tmux-layout.invoked');
    const completed = records.find((r) => r.event === 'tmux-layout.completed');

    expect(invoked).toBeDefined();
    expect(invoked.layout).toBe('default');

    expect(completed).toBeDefined();
    expect(completed.layout).toBe('default');
    expect(typeof completed.duration_ms).toBe('number');
    expect(completed.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('emits tmux-layout.degraded when fn returns ok:false', async () => {
    const fn = async () => ({ ok: false, error: 'tmux missing' });
    const wrapped = withTelemetry('default', fn);

    await wrapped();

    const records = readEventsFile();
    const degraded = records.find((r) => r.event === 'tmux-layout.degraded');

    expect(degraded).toBeDefined();
    expect(degraded.layout).toBe('default');
    expect(degraded.reason).toBe('tmux missing');
  });

  it('emits tmux-layout.degraded and re-throws when fn throws', async () => {
    const fn = async () => { throw new Error('boom'); };
    const wrapped = withTelemetry('default', fn);

    await expect(wrapped()).rejects.toThrow('boom');

    const records = readEventsFile();
    const degraded = records.find((r) => r.event === 'tmux-layout.degraded');

    expect(degraded).toBeDefined();
    expect(degraded.reason).toBe('exception: boom');
  });

  it('throws TypeError synchronously when fn is not a function', () => {
    expect(() => withTelemetry('default', 'not-a-fn')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// readTmuxEvents() — test 7
// ---------------------------------------------------------------------------

describe('readTmuxEvents()', () => {
  it('filters out non-tmux-layout events and returns only tmux-layout.* records', () => {
    const metricsDir = join(tmpDir, '.orchestrator', 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    const eventsPath = join(metricsDir, 'events.jsonl');

    const tmuxInvoked = JSON.stringify({ event: 'tmux-layout.invoked', layout: 'default', timestamp: '2026-05-25T10:00:00.000Z' });
    const waveDone = JSON.stringify({ event: 'wave_complete', wave: 1, timestamp: '2026-05-25T10:00:01.000Z' });
    const tmuxCompleted = JSON.stringify({ event: 'tmux-layout.completed', layout: 'default', duration_ms: 42, timestamp: '2026-05-25T10:00:02.000Z' });
    const memoryEvent = JSON.stringify({ event: 'memory.proposed', key: 'foo', timestamp: '2026-05-25T10:00:03.000Z' });

    writeFileSync(eventsPath, [tmuxInvoked, waveDone, tmuxCompleted, memoryEvent].join('\n') + '\n');

    const events = readTmuxEvents(eventsPath);

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('tmux-layout.invoked');
    expect(events[1].event).toBe('tmux-layout.completed');
  });
});

// ---------------------------------------------------------------------------
// computeStats() — tests 8-10
// ---------------------------------------------------------------------------

describe('computeStats()', () => {
  it('counts invocations/completions/degradations and computes completionRate + meetsPromotionGate:true', () => {
    const events = [
      ...Array.from({ length: 5 }, () => ({ event: 'tmux-layout.invoked', layout: 'default' })),
      ...Array.from({ length: 4 }, () => ({ event: 'tmux-layout.completed', layout: 'default', duration_ms: 10 })),
      { event: 'tmux-layout.degraded', layout: 'default', reason: 'tmux missing' },
    ];

    const stats = computeStats(events);

    expect(stats.invocations).toBe(5);
    expect(stats.completions).toBe(4);
    expect(stats.degradations).toBe(1);
    expect(stats.completionRate).toBe(0.8);
    expect(stats.meetsPromotionGate).toBe(true);
  });

  it('returns meetsPromotionGate:false when invocations < 5 even at 100% completion', () => {
    const events = [
      ...Array.from({ length: 3 }, () => ({ event: 'tmux-layout.invoked', layout: 'default' })),
      ...Array.from({ length: 3 }, () => ({ event: 'tmux-layout.completed', layout: 'default', duration_ms: 5 })),
    ];

    const stats = computeStats(events);

    expect(stats.invocations).toBe(3);
    expect(stats.completions).toBe(3);
    expect(stats.completionRate).toBe(1);
    expect(stats.meetsPromotionGate).toBe(false);
  });

  it('returns completionRate:null and meetsPromotionGate:false when event array is empty', () => {
    const stats = computeStats([]);

    expect(stats.invocations).toBe(0);
    expect(stats.completionRate).toBeNull();
    expect(stats.meetsPromotionGate).toBe(false);
  });
});
