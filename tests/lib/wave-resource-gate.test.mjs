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
} from '@lib/wave-resource-gate.mjs';

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
    // #1089: a KNOWN zero, not a missing value — keeps the concurrency channel
    // quiet so single-axis tests stay single-axis under the two-signal rule.
    peerSessions: 0,
    concurrentSessions: 1,
    ...overrides,
  };
}

// macOS-style override: low free RAM but a real (high) available figure. The
// gate must judge thresholds on `ramAvailableGb`, not the misleading free value.
function makeMacOverride(overrides = {}) {
  return {
    ramFreeGb: 0.3,        // os.freemem() on Apple Silicon — Pages-free only
    ramAvailableGb: 80,    // free + reclaimable (vm_stat) — the real headroom
    cpuLoadPct: 30,
    peerSessions: 0,
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

  test('ramFreeGb below min ALONE → proceed (one soft signal never caps, #1089)', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Polish',
      probeOverride: makeOverride({ ramFreeGb: 3.0 }), // below min (4) but above critical (2)
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(6);
    expect(result.measurements.ramFreeGb).toBe(3.0);
  });

  test('RAM below min PLUS a second signal → reduce with agents: floor(planned/2)', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Polish',
      probeOverride: makeOverride({ ramFreeGb: 3.0, peerSessions: 6 }),
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(3); // floor(6/2)
    expect(result.agents).toBeGreaterThanOrEqual(1);
  });

  test('cpuLoadPct above max ALONE → proceed (CPU alone no longer halves a wave, #1089)', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Quality',
      probeOverride: makeOverride({ cpuLoadPct: 90 }), // above max (80)
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.measurements.cpuLoadPct).toBe(90);
  });

  test('cpuLoadPct above max PLUS live peer sessions → reduce', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Quality',
      probeOverride: makeOverride({ cpuLoadPct: 90, peerSessions: 6 }),
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(2); // floor(4/2)
  });

  test('peerSessions above warn → proceed with a reason, agents unchanged', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Discovery',
      probeOverride: makeOverride({ peerSessions: 7 }), // above warn (5)
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.reasons.some((r) => r.includes('peer session'))).toBe(true);
  });

  test('7 Claude PROCESSES with a known-zero peer count → no concurrency signal (#1089 unit fix)', async () => {
    // Catches the 6x unit error: 7 processes is ~1 session, not 7 sessions.
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Discovery',
      probeOverride: makeOverride({ claudeProcesses: 7 }),
    });
    expect(result.decision).toBe('proceed');
    expect(result.reasons.some((r) => r.includes('peer session'))).toBe(false);
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
      probeOverride: makeOverride({ ramFreeGb: 3.0, peerSessions: 6 }), // two signals → reduce
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
    vi.doMock('@lib/resource-probe.mjs', () => ({
      probe: async () => {
        throw new Error('synthetic probe failure');
      },
    }));
    const { evaluateWaveResourceGate: evalGate } = await import(
      '@lib/wave-resource-gate.mjs'
    );
    const result = await evalGate({
      config: makeConfig(),
      plannedAgents: 5,
      waveRole: 'Impl-Core',
    });
    vi.doUnmock('@lib/resource-probe.mjs');
    vi.resetModules();
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(5);
    expect(result.reasons).toContain('probe failed (ignored)');
    expect(result.measurements).toEqual({});
  });

  // -------------------------------------------------------------------------
  // macOS available-RAM gating (#667)
  // -------------------------------------------------------------------------

  test('macOS: low free (0.3GB) but high available (80GB) → proceed, NOT coordinator-direct', async () => {
    // Reproduces the issue's false RAM-critical: free 0.3GB < critical 2GB, but
    // available 80GB is healthy. The gate must NOT escalate to coordinator-direct.
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeMacOverride({ ramFreeGb: 0.3, ramAvailableGb: 80 }),
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(6);
    expect(result.measurements.ramAvailableGb).toBe(80);
  });

  test('macOS: low free but available below critical → coordinator-direct (real pressure)', async () => {
    // Genuinely low available (1.5GB < critical 2GB) → escalate, label "RAM available".
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeMacOverride({ ramFreeGb: 0.3, ramAvailableGb: 1.5 }),
    });
    expect(result.decision).toBe('coordinator-direct');
    expect(result.agents).toBe(0);
    expect(result.reasons.some((r) => r.includes('RAM available 1.5 GB'))).toBe(true);
  });

  test('macOS: low free but available below min (above critical) → reduce', async () => {
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Polish',
      probeOverride: makeMacOverride({ ramFreeGb: 0.3, ramAvailableGb: 3.0, peerSessions: 6 }),
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(3); // floor(6/2)
    expect(result.reasons.some((r) => r.includes('RAM available 3.0 GB'))).toBe(true);
  });

  test('Linux: ramAvailableGb absent → gate falls back to free RAM (label "RAM free")', async () => {
    // No ramAvailableGb in override → free 1.5GB < critical → coordinator-direct.
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride({ ramFreeGb: 1.5 }), // no ramAvailableGb key
    });
    expect(result.decision).toBe('coordinator-direct');
    expect(result.agents).toBe(0);
    expect(result.reasons.some((r) => r.includes('RAM free 1.5 GB'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Transient-CPU suppression via min(1m, 5m) (#943)
  //
  // The gate runs right after the coordinator's own CPU-saturating quality-gate
  // run by construction — the 1m load average carries that decaying tail
  // (observed 2026-07-30: 96% → 91% → 78% → 75% within 36s after a Full Gate at
  // 813% CPU across cores). Fixture realism: live probe() on this host
  // (2026-07-31) read loadavg [13.27, 14.31] on 18 cores → 1m 74% / 5m 79%;
  // the incident's inverse shape (1m ≫ 5m) is the standard post-burst decay
  // state, since a short burst never lifts the 5m average as far as the 1m.
  // -------------------------------------------------------------------------

  test('#943 incident: 1m CPU 96% but 5m 45% → proceed (decaying transient), NOT reduce', async () => {
    // Bug this catches: judging CPU on the 1m average alone halves the wave on
    // the gate's own measurement tail (the exact 2026-07-30 pre-Wave-3 incident).
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride({ cpuLoadPct: 96, cpuLoad5mPct: 45 }),
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(6);
    expect(result.reasons.some((r) => r.includes('decaying transient') && r.includes('#943'))).toBe(true);
    expect(result.measurements.cpuLoad5mPct).toBe(45);
  });

  test('#943 sustained load: 1m 96% AND 5m 92% → still reduce (min is above max)', async () => {
    // Bug this catches: an over-suppression that bypasses the CPU rule whenever
    // a 5m signal merely EXISTS, instead of only when the 5m is genuinely calm.
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride({ cpuLoadPct: 96, cpuLoad5mPct: 92, peerSessions: 6 }),
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(3);
    expect(result.reasons.some((r) => r.includes('CPU load 92%') && r.includes('min of 1m 96% / 5m 92%'))).toBe(true);
  });

  test('#943 min semantics: 1m 40% but 5m 95% (burst ended >1min ago) → proceed', async () => {
    // Bug this catches: judging on the 5m average ALONE (or max(1m,5m)) — a
    // load that has already dropped must not reduce the wave.
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Quality',
      probeOverride: makeOverride({ cpuLoadPct: 40, cpuLoad5mPct: 95 }),
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.reasons).toContain('all thresholds within bounds');
  });

  test('#943 back-compat: cpuLoad5mPct absent → 1m-only judging still reduces at 90%', async () => {
    // Pins the legacy fallback: overrides/platforms without a 5m signal
    // (Windows, older callers) keep the pre-#943 behaviour unchanged.
    const result = await evaluateWaveResourceGate({
      config: makeConfig(),
      plannedAgents: 4,
      waveRole: 'Quality',
      probeOverride: makeOverride({ cpuLoadPct: 90, peerSessions: 6 }), // no cpuLoad5mPct key
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(2);
    expect(result.measurements.cpuLoad5mPct).toBe(null);
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

  test('macOS: shows available-RAM in the banner when ramAvailableGb is present (#667)', () => {
    const result = {
      decision: 'proceed',
      agents: 6,
      reasons: ['all thresholds within bounds'],
      measurements: { ramFreeGb: 0.3, ramAvailableGb: 80, cpuLoadPct: 30, concurrentSessions: 1 },
    };
    const report = formatGateReport(result);
    expect(report).toContain('RAM 80GB avail');
    expect(report).not.toContain('0.3GB free');
  });

  test('falls back to free-RAM banner when ramAvailableGb is null', () => {
    const result = {
      decision: 'proceed',
      agents: 4,
      reasons: ['all thresholds within bounds'],
      measurements: { ramFreeGb: 8, ramAvailableGb: null, cpuLoadPct: 30, concurrentSessions: 1 },
    };
    const report = formatGateReport(result);
    expect(report).toContain('RAM 8GB free');
  });
});

// ---------------------------------------------------------------------------
// heavy-repo preflight cap (HR-003/HR-004, baseline #60)
// ---------------------------------------------------------------------------
//
// `config['heavy-repo'] === true` forces a STATIC ceiling on dispatched agents
// regardless of the live resource-probe verdict. More-restrictive-wins: the
// cap only ever lowers `agents`, never raises it above what the resource
// rules already decided (e.g. a coordinator-direct 0 stays 0).

describe('evaluateWaveResourceGate — heavy-repo preflight cap (#60)', () => {
  test('clamps an otherwise-uncapped "proceed" decision down to agents-per-wave', async () => {
    const config = makeConfig({ 'heavy-repo': true, 'agents-per-wave': 3 });
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride(), // healthy — would otherwise proceed with 6
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(3);
    expect(result.reasons.some((r) => r.includes('heavy-repo: true caps agents-per-wave to 3 (HR-004)'))).toBe(true);
  });

  test('resolves the object override shape `{ default, deep }` (parenthetical config syntax) using the default — clamps agents down', async () => {
    // Real parsed shape of `agents-per-wave: 4 (deep: 8)` per _coerceInteger
    // (scripts/lib/config/coercers.mjs) is an OBJECT, not a plain number.
    // applyHeavyRepoCap must resolve it via `.default` rather than silently
    // no-op'ing the cap (the bug this test pins down).
    const config = makeConfig({
      'heavy-repo': true,
      'agents-per-wave': { default: 4, deep: 8 },
    });
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 12,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride(), // healthy — would otherwise proceed with 12
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(4);
    expect(result.reasons.some((r) => r.includes('heavy-repo: true caps agents-per-wave to 4 (HR-004)'))).toBe(true);
  });

  test('does not clamp when plannedAgents is already within the heavy-repo cap', async () => {
    const config = makeConfig({ 'heavy-repo': true, 'agents-per-wave': 8 });
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 4,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride(),
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(4);
    expect(result.reasons.some((r) => r.includes('HR-004'))).toBe(false);
  });

  test('heavy-repo: false never clamps, even when plannedAgents exceeds agents-per-wave', async () => {
    const config = makeConfig({ 'heavy-repo': false, 'agents-per-wave': 2 });
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride(),
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(6);
    expect(result.reasons.some((r) => r.includes('HR-004'))).toBe(false);
  });

  test('never RAISES agents: a coordinator-direct 0 stays 0 even with a looser heavy-repo cap', async () => {
    const config = makeConfig({ 'heavy-repo': true, 'agents-per-wave': 4 });
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride({ ramFreeGb: 1.5 }), // below critical (2 GB)
    });
    expect(result.decision).toBe('coordinator-direct');
    expect(result.agents).toBe(0);
  });

  test('tightens further when the resource-driven reduce already computed MORE than the heavy-repo cap', async () => {
    // CPU overload alone → reduce to floor(6/2)=3; heavy-repo cap=2 is stricter.
    const config = makeConfig({ 'heavy-repo': true, 'agents-per-wave': 2 });
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride({ cpuLoadPct: 90 }),
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(2);
    expect(result.reasons.some((r) => r.includes('HR-004'))).toBe(true);
  });

  test('leaves an already-stricter resource-driven reduce unchanged when the heavy-repo cap is looser', async () => {
    // CPU + peers → reduce to floor(6/2)=3; heavy-repo cap=8 is looser — no double-clamp.
    const config = makeConfig({ 'heavy-repo': true, 'agents-per-wave': 8 });
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride({ cpuLoadPct: 90, peerSessions: 6 }),
    });
    expect(result.decision).toBe('reduce');
    expect(result.agents).toBe(3);
    expect(result.reasons.some((r) => r.includes('HR-004'))).toBe(false);
  });

  // Pin test (baseline #60, reviewed 2026-07-23): `resource-awareness: false`
  // is a FULL opt-out, INCLUDING the HR-004 heavy-repo static cap — Rule 1's
  // early return in evaluateWaveResourceGate() short-circuits before
  // applyDecisionRules()/applyHeavyRepoCap() ever run. This is deliberate,
  // documented behavior — not a bug. If this test ever needs to change, that
  // change must be a conscious decision, not an accidental regression.
  test('resource-awareness: false bypasses the heavy-repo cap entirely — proceeds at plannedAgents above the cap', async () => {
    const config = makeConfig({
      'resource-awareness': false,
      'heavy-repo': true,
      'agents-per-wave': 2,
    });
    const result = await evaluateWaveResourceGate({
      config,
      plannedAgents: 6,
      waveRole: 'Impl-Core',
      probeOverride: makeOverride(),
    });
    expect(result.decision).toBe('proceed');
    expect(result.agents).toBe(6);
    expect(result.reasons.some((r) => r.includes('HR-004'))).toBe(false);
  });
});
