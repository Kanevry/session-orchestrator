/**
 * wave-resource-gate.test.mjs — Vitest tests for scripts/lib/wave-resource-gate.mjs
 *
 * Covers:
 *  - resource-awareness disabled: skip probe, return proceed
 *  - RAM critical: coordinator-direct with agents 0
 *  - RAM warn (below min, above critical): reduce to floor(n/2) ≥ 1
 *  - CPU overloaded: reduce
 *  - Concurrent sessions above warn: proceed with warn reason
 *  - All within bounds: proceed with "all thresholds within bounds"
 *  - probeOverride: measurements match override, real probe never called
 *  - plannedAgents: 1 + reduce → agents stays at 1 (Math.max(1,...))
 *  - plannedAgents: 0 + coordinator-direct → agents: 0 (no underflow)
 *  - formatGateReport: non-empty multi-line string including decision + reason
 */

import { describe, test, expect } from 'vitest';
import {
  evaluateWaveResourceGate,
  formatGateReport,
} from '../../scripts/lib/wave-resource-gate.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical default resource-thresholds matching config.mjs defaults. */
const DEFAULT_THRESHOLDS = {
  'ram-free-min-gb': 4,
  'ram-free-critical-gb': 2,
  'cpu-load-max-pct': 80,
  'concurrent-sessions-warn': 5,
  'ssh-no-docker': true,
};

function makeConfig(overrides = {}) {
  return {
    'resource-awareness': true,
    'resource-thresholds': { ...DEFAULT_THRESHOLDS },
    ...overrides,
  };
}

function makeOverride(overrides = {}) {
  return {
    ramFreeGb: 8,
    cpuLoadPct: 30,
    concurrentSessions: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evaluateWaveResourceGate
// ---------------------------------------------------------------------------

describe('evaluateWaveResourceGate', () => {
  test('resource-awareness: false → returns proceed with reason containing "disabled"', async () => {
    const config = makeConfig({ 'resource-awareness': false });
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 4,
      waveRole: 'Impl-Core',
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.reasons.some((r) => r.toLowerCase().includes('disabled'))).toBe(true);
    expect(result.measurements).toEqual({});
  });

  test('ramFreeGb below critical threshold → coordinator-direct with agents: 0', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride({ ramFreeGb: 1.5 }), // below critical (2 GB)
    });
    expect(result.decision).toBe('coordinator-direct');
    expect(result.agents).toBe(0);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.measurements.ramFreeGb).toBe(1.5);
  });

  test('ramFreeGb below min but above critical → reduce with agents: floor(planned/2), minimum 1', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Polish',
      probeOverride: makeOverride({ ramFreeGb: 3.0 }), // below min (4) but above critical (2)
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(3); // floor(6/2)
    expect(result.agents).toBeGreaterThanOrEqual(1);
    expect(result.measurements.ramFreeGb).toBe(3.0);
  });

  test('cpuLoadPct above max → reduce', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Quality',
      probeOverride: makeOverride({ cpuLoadPct: 90 }), // above max (80)
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(2); // floor(4/2)
    expect(result.measurements.cpuLoadPct).toBe(90);
  });

  test('concurrentSessions above warn → proceed with warn reason, agents unchanged', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Discovery',
      probeOverride: makeOverride({ concurrentSessions: 7 }), // above warn (5)
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.reasons.some((r) => r.includes('warn') || r.includes('concurrent'))).toBe(true);
    expect(result.measurements.concurrentSessions).toBe(7);
  });

  test('all thresholds within bounds → proceed with reason "all thresholds within bounds"', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Finalization',
      probeOverride: makeOverride({ ramFreeGb: 8, cpuLoadPct: 30, concurrentSessions: 1 }),
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.reasons).toContain('all thresholds within bounds');
  });

  test('probeOverride supplied → measurements match override values', async () => {
    const override = { ramFreeGb: 6.2, cpuLoadPct: 45, concurrentSessions: 3 };
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 3,
      waveRole: 'Impl-Core',
      probeOverride: override,
    });
    expect(result.measurements.ramFreeGb).toBe(6.2);
    expect(result.measurements.cpuLoadPct).toBe(45);
    expect(result.measurements.concurrentSessions).toBe(3);
  });

  test('plannedAgents: 1 + reduce trigger → agents: 1 (never below 1)', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 1,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride({ ramFreeGb: 3.0 }), // triggers reduce
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(1); // Math.max(1, floor(1/2)) = Math.max(1, 0) = 1
  });

  test('plannedAgents: 0 + coordinator-direct → agents: 0 (no underflow)', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 0,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride({ ramFreeGb: 1.0 }), // below critical
    });
    expect(result.decision).toBe('coordinator-direct');
    expect(result.agents).toBe(0);
  });

  test('probe failure → proceed with "probe failed (ignored)" reason, agents unchanged', async () => {
    // Force a real-probe path by omitting probeOverride. Stub child_process.execFile
    // via env to make the probe throw. Simpler: pass a config that triggers an
    // unreachable probe code path. We use vi.doMock on the resource-probe module.
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('../../scripts/lib/resource-probe.mjs', () => ({
      probe: async () => {
        throw new Error('synthetic probe failure');
      },
    }));
    const { evaluateWaveResourceGate: evalGate } = await import(
      '../../scripts/lib/wave-resource-gate.mjs'
    );
    const result = await evalGate({
      config: makeConfig(),
      plannedAgents: 5,
      waveRole: 'Impl-Core',
    });
    vi.doUnmock('../../scripts/lib/resource-probe.mjs');
    vi.resetModules();
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(5);
    expect(result.reasons).toContain('probe failed (ignored)');
    expect(result.measurements).toEqual({});
  });

  test('config without resource-thresholds → proceed with "missing" reason (defensive)', async () => {
    const config = { 'resource-awareness': true }; // no resource-thresholds key
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 4,
      waveRole: 'Impl-Polish',
      probeOverride: makeOverride(),
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.reasons.some((r) => r.includes('missing'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatGateReport
// ---------------------------------------------------------------------------

describe('formatGateReport', () => {
  test('returns non-empty multi-line string including decision and at least one reason', () => {
    const result = {
      decision: 'reduce',
      agents: 2,
      reasons: ['RAM free 3GB < min 4GB — reducing agent count'],
      measurements: { ramFreeGb: 3, cpuLoadPct: 40, concurrentSessions: 2 },
    };
    const report = formatGateReport(result);
    expect(typeof report).toBe('string');
    expect(report.length).toBeGreaterThan(0);
    expect(report.includes('\n')).toBe(true);
    expect(report).toContain('reduce');
    expect(report).toContain('RAM free');
  });
});
