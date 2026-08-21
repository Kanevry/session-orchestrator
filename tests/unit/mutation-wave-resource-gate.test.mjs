/**
 * Mutation-derived boundary tests for wave-resource-gate.mjs (GL #910, W3).
 *
 * UPDATED for #1089. The two-signal rule silently DISARMED three of these four
 * cases: with only one axis elevated, a `<`→`<=` flip now moves the verdict
 * from "no signal" to "one soft signal", and both still decide `proceed` — so
 * the boundary test stayed green while the mutant it exists to catch survived.
 * Each case below therefore holds a SECOND soft signal steady (`peerSessions`
 * at the threshold), which makes the axis under test the deciding one again:
 * one signal → proceed, two → reduce. Without that companion signal these are
 * assert-nothing tests, which is worse than not having them.
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
    // effectiveRam == critical (2). The memory signal is strict `< critical` →
    // false, so it is SOFT (2 < min 4), not hard. With a companion soft signal
    // that means `reduce`, never `coordinator-direct`.
    // Mutant `<= critical` makes it HARD and wrongly forces coordinator-direct.
    const result = await evaluateWaveResourceGate({
      config: baseConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: { ramFreeGb: 2, cpuLoadPct: 10, peerSessions: 3 },
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(3);
  });

  it('CPU load EXACTLY at the max threshold does NOT reduce (survivor wr6: `> max`)', async () => {
    // cpuLoadPct == max (85), strict `> max` → false → CPU contributes NO
    // signal, so the lone peer signal cannot reach two → proceed.
    // Mutant `>= max` adds a second signal at exactly 85% and halves the wave.
    const result = await evaluateWaveResourceGate({
      config: baseConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: { ramFreeGb: 16, cpuLoadPct: 85, cpuLoad5mPct: 85, peerSessions: 3 },
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(6);
  });

  it('peer sessions one BELOW the warn threshold emit no concurrency reason (boundary is `>=`, #1089)', async () => {
    // #1089 changed this comparison from `> warn` to `>= warn` — the threshold
    // now means "at this many sessions", matching its documented wording. So the
    // boundary case moved by one: 2 is silent, 3 fires. Mutant `> warn` wrongly
    // stays silent at exactly 3, which the companion case below catches.
    const result = await evaluateWaveResourceGate({
      config: baseConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: { ramFreeGb: 16, cpuLoadPct: 10, peerSessions: 2 },
    });
    expect(result.decision).toBe('proceed');
    expect(result.reasons.some((r) => r.includes('peer session'))).toBe(false);
  });

  it('peer sessions EXACTLY at the warn threshold DO emit a concurrency reason (#1089)', async () => {
    const result = await evaluateWaveResourceGate({
      config: baseConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: { ramFreeGb: 16, cpuLoadPct: 10, peerSessions: 3 },
    });
    expect(result.decision).toBe('proceed'); // one soft signal never caps
    expect(result.reasons.some((r) => r.includes('3 peer session(s)'))).toBe(true);
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
      probeOverride: { ramFreeGb: 16, cpuLoadPct: 10, peerSessions: 0 },
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.reasons.some((r) => r.includes('heavy-repo'))).toBe(false);
  });
});
