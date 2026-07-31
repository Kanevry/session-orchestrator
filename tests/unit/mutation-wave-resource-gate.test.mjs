/**
 * Mutation-derived boundary tests for wave-resource-gate.mjs (GL #910, W3).
 *
 * A hand-mutation sweep found 4 SURVIVORS in this module — every threshold and
 * cap comparison was exercised strictly ABOVE or BELOW its limit, never AT the
 * exact boundary. Flipping `<`→`<=`, `>`→`>=`, or `<=`→`<` therefore left the
 * existing suite green. These four cases pin the intended boundary semantics
 * (the gate that decides whether parallel agents dispatch), so a later refactor
 * that flips an operator goes RED here.
 *
 * Each `it` names the concrete bug a boundary flip would ship.
 */
import { describe, it, expect } from 'vitest';
import { evaluateWaveResourceGate } from '../../scripts/lib/wave-resource-gate.mjs';

const THRESHOLDS = {
  'ram-free-critical-gb': 2,
  'ram-free-min-gb': 4,
  'cpu-load-max-pct': 85,
  'concurrent-sessions-warn': 3,
};

const baseConfig = () => ({ 'resource-thresholds': { ...THRESHOLDS } });

describe('wave-resource-gate — threshold/cap boundary semantics (mutation #910)', () => {
  it('RAM free EXACTLY at the critical threshold does NOT escalate to coordinator-direct (survivor wr5: `< critical`)', async () => {
    // effectiveRam == critical (2). Rule 4 is strict `< critical` → false, so it
    // must NOT go coordinator-direct; it falls to Rule 5 (`< min`, 2 < 4) → reduce.
    // Mutant `<= critical` wrongly triggers coordinator-direct at exactly 2.
    const result = await evaluateWaveResourceGate({
      config: baseConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: { ramFreeGb: 2, cpuLoadPct: 10, concurrentSessions: 0 },
    });
    expect(result.decision).toBe('reduce');
  });

  it('CPU load EXACTLY at the max threshold does NOT reduce (survivor wr6: `> max`)', async () => {
    // cpuLoadPct == max (85). Rule 6 is strict `> max` → false → proceed.
    // Mutant `>= max` wrongly halves the wave at exactly 85%.
    const result = await evaluateWaveResourceGate({
      config: baseConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: { ramFreeGb: 16, cpuLoadPct: 85, concurrentSessions: 0 },
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(6);
  });

  it('concurrent sessions EXACTLY at the warn threshold does NOT emit a warn reason (survivor wr7: `> warn`)', async () => {
    // concurrentSessions == warn (3). Rule 7 is strict `> warn` → false → Rule 8
    // "all thresholds within bounds". Mutant `>= warn` wrongly attaches a
    // "warn: 3 concurrent sessions" reason at exactly 3.
    const result = await evaluateWaveResourceGate({
      config: baseConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: { ramFreeGb: 16, cpuLoadPct: 10, concurrentSessions: 3 },
    });
    expect(result.decision).toBe('proceed');
    expect(result.reasons).toEqual(['all thresholds within bounds']);
  });

  it('heavy-repo wave whose planned agents EXACTLY equal the cap is not spuriously downgraded to reduce (survivor wr4: `agents <= cap`)', async () => {
    // plannedAgents == cap (4). The resource path proceeds with agents=4, then
    // the HR-004 heavy-repo cap sees `agents <= cap` (4 <= 4) → already within
    // ceiling → returns unchanged. Mutant `agents < cap` (4 < 4 false) wrongly
    // re-caps: flips the decision to 'reduce' and adds a bogus cap reason even
    // though the wave was already within the ceiling.
    const result = await evaluateWaveResourceGate({
      config: { ...baseConfig(), 'heavy-repo': true, 'agents-per-wave': 4 },
      plannedAgents: 4,
      waveRole: 'Impl-Core',
      probeOverride: { ramFreeGb: 16, cpuLoadPct: 10, concurrentSessions: 0 },
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.reasons.some((r) => r.includes('heavy-repo'))).toBe(false);
  });
});
