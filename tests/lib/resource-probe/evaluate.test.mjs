/**
 * tests/lib/resource-probe/evaluate.test.mjs
 *
 * Unit tests for scripts/lib/resource-probe/evaluate.mjs.
 *
 * Rewritten for #1089. The previous suite pinned the OLD rule set — one soft
 * signal caps, free-RAM decides memory, the process count is compared against a
 * session threshold — so every case in it passed while the rule set produced a
 * warn-or-worse verdict on 99.0% of 1477 measured session starts. Pinning a
 * broken instrument precisely is not coverage.
 *
 * Each test below names the defect it catches (TV-001). The four that matter:
 *
 *  D1  free-RAM decides the memory verdict even when memory_pressure is present
 *      (the #667 half-fix only suppressed the HEALTHY band, leaving 15..30%
 *      still judged on Pages-free)
 *  D2  claude_processes_count compared against a SESSION-denominated threshold
 *      (measured 6x unit error)
 *  D3  a single soft signal caps agents-per-wave outright
 *  D4  the real hazard (2026-04-19 freeze class) must STILL escalate
 *
 * Pure function — no mocks. Expected values are hardcoded literals.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluate,
  DEFAULT_RESOURCE_THRESHOLDS,
  PROCESSES_PER_SESSION,
} from '@lib/resource-probe/evaluate.mjs';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = {
  ...DEFAULT_RESOURCE_THRESHOLDS,
  'ssh-no-docker': true,
};

/**
 * A snapshot where every signal is healthy.
 *
 * Deliberately shaped like a REAL Darwin snapshot rather than a convenient one
 * (testing.md § Unfaithful Double): `ram_free_gb` is LOW because that is what
 * `os.freemem()` actually reports on macOS — median 0.4 GB across 1477 measured
 * starts — while pressure and available report the truth. A fixture with a
 * comfortable `ram_free_gb: 8` cannot exercise the defect this module exists to
 * fix, which is precisely why the old suite could not see it.
 */
const HEALTHY_SNAPSHOT = {
  ram_free_gb: 0.3,
  ram_available_gb: 6.6,
  memory_pressure_pct_free: 53,
  ram_used_pct: 97,
  cpu_load_1m: 1.2,
  cpu_load_pct: 30,
  cpu_load_5m_pct: 28,
  claude_processes_count: 16,
  peer_sessions_count: 1,
  codex_processes_count: 0,
  other_node_processes: 3,
  swap_used_mb: null,
  zombie_processes_count: null,
};

// ---------------------------------------------------------------------------
// D1 — memory signal precedence
// ---------------------------------------------------------------------------

describe('evaluate() — memory signal precedence (#1089 D1)', () => {
  it('returns green on a real Darwin snapshot: 0.3 GB free, 53% pressure free', () => {
    // Catches: the 84%-firing false critical. This exact shape (free far below
    // ram-free-critical-gb, pressure healthy) was 53.8% of all measured starts.
    const result = evaluate(HEALTHY_SNAPSHOT, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.recommended_agents_per_wave_cap).toBe(null);
    expect(result.signals).toEqual({ hard: [], soft: [] });
  });

  it('judges on pressure, NOT free RAM, inside the unhealthy 15..30% band', () => {
    // THE D1 regression. The #667 fix only suppressed free-RAM when pressure was
    // HEALTHY (>=30%). At 20% the old code fell through to ram_free_gb 0.3 and
    // returned critical + cap 0. Correct behaviour: one soft signal, no cap.
    const snap = { ...HEALTHY_SNAPSHOT, memory_pressure_pct_free: 20 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.recommended_agents_per_wave_cap).toBe(null);
    expect(result.signals.soft).toEqual(['memory']);
    expect(result.signals.hard).toEqual([]);
  });

  it('falls back to ram_available_gb when pressure is absent', () => {
    const snap = { ...HEALTHY_SNAPSHOT, memory_pressure_pct_free: null, ram_available_gb: 6.6 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.signals.soft).toEqual([]);
  });

  it('falls back to ram_free_gb only when BOTH better signals are absent (Linux path)', () => {
    // On Linux os.freemem() is accurate, so free-RAM gating there is correct,
    // not a concession. 1.5 GB free < critical 2 → hard signal.
    const snap = {
      ...HEALTHY_SNAPSHOT,
      memory_pressure_pct_free: null,
      ram_available_gb: null,
      ram_free_gb: 1.5,
    };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
    expect(result.signals.hard).toEqual(['memory']);
  });

  it('a healthy pressure reading states WHY free RAM was not consulted', () => {
    // The operator-facing half of HR-106: an alarming banner number beside a
    // green verdict must explain itself, or it teaches distrust of the verdict.
    const result = evaluate(HEALTHY_SNAPSHOT, DEFAULT_THRESHOLDS);
    expect(result.reasons.some((r) => r.includes('memory_pressure healthy') && r.includes('Pages-free'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D4 — the real hazard must still escalate
// ---------------------------------------------------------------------------

describe('evaluate() — genuine pressure still escalates (#1089 D4)', () => {
  it('escalates to critical when pressure is in the red band (<15%)', () => {
    // Catches: over-loosening. This is the 2026-04-19 freeze class — the whole
    // reason the gate exists. Loosening must not reach it.
    const snap = { ...HEALTHY_SNAPSHOT, memory_pressure_pct_free: 8 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
    expect(result.signals.hard).toEqual(['memory']);
  });

  it('escalates to critical on heavy swap WHILE memory is unhealthy', () => {
    const snap = { ...HEALTHY_SNAPSHOT, memory_pressure_pct_free: 20, swap_used_mb: 4096 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.signals.hard).toEqual(['swap']);
  });

  it('ignores the SAME swap volume when memory is healthy', () => {
    // Catches: treating a cumulative counter as live pressure (HR-104). The
    // reference host carried 6884 MB swap at 35% pressure-free, fully responsive.
    const snap = { ...HEALTHY_SNAPSHOT, swap_used_mb: 6884 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.signals.soft).toEqual([]);
    expect(result.reasons.some((r) => r.includes('cumulative, not live pressure'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D2 — concurrency unit
// ---------------------------------------------------------------------------

describe('evaluate() — concurrency is denominated in sessions (#1089 D2)', () => {
  it('does NOT fire on 16 Claude processes when only 1 peer session is live', () => {
    // THE D2 regression. Old code compared 16 >= 5 and warned; measured ratio
    // processes:sessions is 6.0, so 16 processes is ~3 sessions.
    const result = evaluate(HEALTHY_SNAPSHOT, DEFAULT_THRESHOLDS);
    expect(result.signals.soft).toEqual([]);
    expect(result.reasons.some((r) => r.includes('peer session'))).toBe(false);
  });

  it('fires when peer SESSIONS reach the threshold', () => {
    const snap = { ...HEALTHY_SNAPSHOT, peer_sessions_count: 5 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.signals.soft).toEqual(['concurrency']);
    expect(result.reasons.some((r) => r.includes('5 peer session(s) live in the registry'))).toBe(true);
  });

  it('falls back to the RESCALED process count when the registry is unavailable', () => {
    // 5 sessions x 6 processes/session = 30. 29 processes stays silent...
    const below = { ...HEALTHY_SNAPSHOT, peer_sessions_count: null, claude_processes_count: 29 };
    expect(evaluate(below, DEFAULT_THRESHOLDS).signals.soft).toEqual([]);
    // ...30 fires.
    const at = { ...HEALTHY_SNAPSHOT, peer_sessions_count: null, claude_processes_count: 30 };
    expect(evaluate(at, DEFAULT_THRESHOLDS).signals.soft).toEqual(['concurrency']);
  });

  it('the rescale factor is the exported constant, not a magic number', () => {
    const threshold = DEFAULT_THRESHOLDS['concurrent-sessions-warn'] * PROCESSES_PER_SESSION;
    const snap = { ...HEALTHY_SNAPSHOT, peer_sessions_count: null, claude_processes_count: threshold };
    expect(evaluate(snap, DEFAULT_THRESHOLDS).reasons.some((r) => r.includes(`fallback threshold ${threshold}`))).toBe(true);
  });

  it('registry count of 0 wins over a high process count (no fallback when known)', () => {
    // A known-zero peer count is an ANSWER, not a missing value — the fallback
    // must not fire behind it. Catches a `?? `-vs-`!= null` confusion.
    const snap = { ...HEALTHY_SNAPSHOT, peer_sessions_count: 0, claude_processes_count: 40 };
    expect(evaluate(snap, DEFAULT_THRESHOLDS).signals.soft).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D3 — two-signal rule
// ---------------------------------------------------------------------------

describe('evaluate() — two-signal rule (#1089 D3)', () => {
  it('one soft signal reports but does NOT cap', () => {
    // THE D3 regression. Old code: cpu > max → cap 2, full stop.
    const snap = { ...HEALTHY_SNAPSHOT, cpu_load_pct: 95, cpu_load_5m_pct: 95 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.recommended_agents_per_wave_cap).toBe(null);
    expect(result.signals.soft).toEqual(['cpu']);
    expect(result.reasons.some((r) => r.includes('no second signal agrees'))).toBe(true);
  });

  it('two independent soft signals cap at 2', () => {
    const snap = {
      ...HEALTHY_SNAPSHOT,
      cpu_load_pct: 95,
      cpu_load_5m_pct: 95,
      peer_sessions_count: 6,
    };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
    expect(result.signals.soft).toEqual(['cpu', 'concurrency']);
  });

  it('a hard signal outranks any number of soft ones', () => {
    const snap = {
      ...HEALTHY_SNAPSHOT,
      memory_pressure_pct_free: 8,
      cpu_load_pct: 99,
      cpu_load_5m_pct: 99,
      peer_sessions_count: 9,
    };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
  });

  it('a 1m CPU spike with a calm 5m average is not a signal at all (#943)', () => {
    // The decaying tail of the coordinator's own gate run. Not counted, so it
    // cannot become the second signal that triggers a cap.
    const snap = {
      ...HEALTHY_SNAPSHOT,
      cpu_load_pct: 99,
      cpu_load_5m_pct: 40,
      peer_sessions_count: 6,
    };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.signals.soft).toEqual(['concurrency']);
    expect(result.reasons.some((r) => r.includes('decaying transient'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Zombies
// ---------------------------------------------------------------------------

describe('evaluate() — zombie signal is informational (#178 / #1089)', () => {
  it('reports zombies but never counts them as a capacity signal', () => {
    const snap = { ...HEALTHY_SNAPSHOT, zombie_processes_count: 13 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.signals.soft).toEqual([]);
    expect(result.reasons.some((r) => r.includes('not counted as a capacity signal'))).toBe(true);
  });

  it('zombies do NOT become the second signal that caps a wave', () => {
    // The #1089 live run produced exactly this: soft ["cpu","zombies"] → cap 2.
    // Zombies are idle by definition (they are not causing the CPU load) and are
    // a standing condition on a developer host — 6, 13 and 9 in three readings
    // minutes apart. Pairing them with any axis restores the one-signal cap
    // under a two-signal name.
    const snap = {
      ...HEALTHY_SNAPSHOT,
      cpu_load_pct: 100,
      cpu_load_5m_pct: 100,
      zombie_processes_count: 9,
    };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.recommended_agents_per_wave_cap).toBe(null);
    expect(result.signals.soft).toEqual(['cpu']);
  });

  it('stays entirely silent on an otherwise idle host (no live peers or processes)', () => {
    const snap = {
      ...HEALTHY_SNAPSHOT,
      zombie_processes_count: 2,
      peer_sessions_count: 0,
      claude_processes_count: 0,
    };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.signals.soft).toEqual([]);
    expect(result.reasons.some((r) => r.includes('zombie'))).toBe(false);
  });

  it('null zombie count means the feature is off, not zero', () => {
    const snap = { ...HEALTHY_SNAPSHOT, zombie_processes_count: null };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.signals.soft).toEqual([]);
    expect(result.reasons.some((r) => r.includes('zombie'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Heavy-repo preflight ceiling (#60) — unchanged behaviour
// ---------------------------------------------------------------------------

describe('evaluate() — heavy-repo preflight cap (#60)', () => {
  it('applies the static ceiling even on a green verdict', () => {
    const result = evaluate(HEALTHY_SNAPSHOT, DEFAULT_THRESHOLDS, { heavyRepo: true, agentsPerWave: 4 });
    expect(result.verdict).toBe('green');
    expect(result.recommended_agents_per_wave_cap).toBe(4);
  });

  it('more-restrictive-wins: keeps the tighter live cap when agentsPerWave is looser', () => {
    const snap = { ...HEALTHY_SNAPSHOT, cpu_load_pct: 95, cpu_load_5m_pct: 95, peer_sessions_count: 6 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS, { heavyRepo: true, agentsPerWave: 6 });
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
  });

  it('more-restrictive-wins: tightens to agentsPerWave when it is stricter', () => {
    const snap = { ...HEALTHY_SNAPSHOT, cpu_load_pct: 95, cpu_load_5m_pct: 95, peer_sessions_count: 6 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS, { heavyRepo: true, agentsPerWave: 1 });
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(1);
  });

  it('resolves the {default, mode} override object to its default', () => {
    const result = evaluate(HEALTHY_SNAPSHOT, DEFAULT_THRESHOLDS, {
      heavyRepo: true,
      agentsPerWave: { default: 4, deep: 18 },
    });
    expect(result.recommended_agents_per_wave_cap).toBe(4);
  });

  it('is inert when heavyRepo is not true', () => {
    const result = evaluate(HEALTHY_SNAPSHOT, DEFAULT_THRESHOLDS, { heavyRepo: false, agentsPerWave: 4 });
    expect(result.recommended_agents_per_wave_cap).toBe(null);
  });

  it('never raises a coordinator-direct 0', () => {
    const snap = { ...HEALTHY_SNAPSHOT, memory_pressure_pct_free: 8 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS, { heavyRepo: true, agentsPerWave: 6 });
    expect(result.recommended_agents_per_wave_cap).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Defensive shapes
// ---------------------------------------------------------------------------

describe('evaluate() — defensive shapes', () => {
  it('does not throw on a legacy snapshot missing every optional field', () => {
    const legacy = { ram_free_gb: 8, ram_used_pct: 40, cpu_load_1m: 1, cpu_load_pct: 25 };
    const result = evaluate(legacy, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.signals).toEqual({ hard: [], soft: [] });
  });

  it('null claude_processes_count AND null peer count produce no concurrency signal', () => {
    const snap = { ...HEALTHY_SNAPSHOT, peer_sessions_count: null, claude_processes_count: null };
    expect(evaluate(snap, DEFAULT_THRESHOLDS).signals.soft).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Canonical defaults
// ---------------------------------------------------------------------------

describe('DEFAULT_RESOURCE_THRESHOLDS — single source (#1089)', () => {
  it('carries the four documented keys', () => {
    expect(DEFAULT_RESOURCE_THRESHOLDS).toEqual({
      'ram-free-min-gb': 4,
      'ram-free-critical-gb': 2,
      'cpu-load-max-pct': 90,
      'concurrent-sessions-warn': 5,
    });
  });

  it('is frozen, so a consumer cannot mutate the shared default in place', () => {
    // Catches: one consumer spreading-then-mutating and silently changing the
    // thresholds every other consumer sees. Three divergent copies is exactly
    // the state this constant replaced.
    expect(Object.isFrozen(DEFAULT_RESOURCE_THRESHOLDS)).toBe(true);
  });
});
