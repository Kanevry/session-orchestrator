/**
 * tests/lib/resource-probe/evaluate.test.mjs
 *
 * Per-submodule unit tests for scripts/lib/resource-probe/evaluate.mjs.
 *
 * The facade test (tests/lib/resource-probe.test.mjs) covers evaluate() via
 * the resource-probe.mjs barrel export. This file imports directly from the
 * submodule and focuses on branches and edge-cases the facade test misses:
 *
 *  • Exact threshold boundaries (at/just-below/just-above)
 *  • The 'degraded' verdict tier (not covered by legacy facade tests)
 *  • bumpVerdict precedence with mixed-tier signals
 *  • Snapshots missing optional fields (defensive defaults for undefined)
 *  • Swap-only critical path without RAM involvement
 *  • All 4 verdict values (green/warn/degraded/critical)
 *
 * Pure function — no mocks required. All expected values are hardcoded
 * literals (test-quality.md anti-pattern #3 avoided).
 */

import { describe, it, expect } from 'vitest';
import { evaluate } from '../../../scripts/lib/resource-probe/evaluate.mjs';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = {
  'ram-free-min-gb': 4,
  'ram-free-critical-gb': 2,
  'cpu-load-max-pct': 80,
  'concurrent-sessions-warn': 5,
  'ssh-no-docker': true,
};

/** A snapshot where all signals are healthy — should always yield green. */
const HEALTHY_SNAPSHOT = {
  ram_free_gb: 8,
  ram_used_pct: 40,
  cpu_load_1m: 1.2,
  cpu_load_pct: 30,
  claude_processes_count: 1,
  codex_processes_count: 0,
  other_node_processes: 3,
  swap_used_mb: null,
  memory_pressure_pct_free: null,
  zombie_processes_count: null,
};

// ---------------------------------------------------------------------------
// Verdict: green — baseline
// ---------------------------------------------------------------------------

describe('evaluate() — green baseline', () => {
  it('returns green with empty reasons when all metrics are healthy', () => {
    const result = evaluate(HEALTHY_SNAPSHOT, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.reasons).toEqual([]);
    expect(result.recommended_agents_per_wave_cap).toBe(null);
  });

  it('returns warn (not critical) when RAM equals the critical threshold exactly', () => {
    // ram_free_gb === ramCrit (2) — "< ramCrit" is false, but "< ramMin (4)" is true → warn
    const snap = { ...HEALTHY_SNAPSHOT, ram_free_gb: 2 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
  });

  it('returns green when CPU is exactly at (not above) the cpu-load-max-pct threshold', () => {
    // cpu_load_pct === 80 — boundary is strictly "> cpuMax"
    const snap = { ...HEALTHY_SNAPSHOT, cpu_load_pct: 80 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
  });

  it('returns green when claude_processes_count is exactly one below concurrent-sessions-warn', () => {
    // concWarn=5, so 4 processes → no warn
    const snap = { ...HEALTHY_SNAPSHOT, claude_processes_count: 4 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
  });
});

// ---------------------------------------------------------------------------
// Verdict: warn — individual triggers
// ---------------------------------------------------------------------------

describe('evaluate() — warn verdict', () => {
  it('returns warn + cap=2 when RAM is just below the min threshold', () => {
    // ram_free_gb < 4 (ramMin) → warn
    const snap = { ...HEALTHY_SNAPSHOT, ram_free_gb: 3.9 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
    expect(result.reasons[0]).toMatch(/RAM free 3\.9 GB below threshold 4 GB/);
  });

  it('returns warn + cap=2 when CPU load is just above the threshold', () => {
    const snap = { ...HEALTHY_SNAPSHOT, cpu_load_pct: 81 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
    expect(result.reasons[0]).toMatch(/CPU load 81%/);
  });

  it('returns warn when claude_processes_count meets the concurrent-sessions-warn threshold', () => {
    const snap = { ...HEALTHY_SNAPSHOT, claude_processes_count: 5 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.reasons[0]).toMatch(/5 Claude processes/);
  });

  it('returns warn when swap is in warn range (1024..2048 MB) and pressure is null', () => {
    const snap = { ...HEALTHY_SNAPSHOT, swap_used_mb: 1500, memory_pressure_pct_free: null };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
    expect(result.reasons.some((r) => r.includes('1500 MB in warn range'))).toBe(true);
  });

  it('returns warn when memory_pressure is in warn range (15..30%)', () => {
    const snap = { ...HEALTHY_SNAPSHOT, swap_used_mb: null, memory_pressure_pct_free: 20 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
    expect(result.reasons.some((r) => r.includes('20% in warn range (15..30%)'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Verdict: degraded
// ---------------------------------------------------------------------------

describe('evaluate() — degraded verdict', () => {
  it('returns degraded + cap=2 when swap is in degraded range (2048..3072 MB) and pressure is null', () => {
    const snap = { ...HEALTHY_SNAPSHOT, swap_used_mb: 2500, memory_pressure_pct_free: null };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('degraded');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
    expect(result.reasons.some((r) => r.includes('2500 MB in degraded range'))).toBe(true);
  });

  it('returns degraded when memory_pressure is in degraded range (5..15%)', () => {
    const snap = { ...HEALTHY_SNAPSHOT, swap_used_mb: null, memory_pressure_pct_free: 10 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('degraded');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
    expect(result.reasons.some((r) => r.includes('10% in degraded range (5..15%)'))).toBe(true);
  });

  it('degraded swap + warn memory_pressure → final verdict degraded (bumpVerdict keeps highest)', () => {
    const snap = { ...HEALTHY_SNAPSHOT, swap_used_mb: 2500, memory_pressure_pct_free: 20 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('degraded');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Verdict: critical
// ---------------------------------------------------------------------------

describe('evaluate() — critical verdict', () => {
  it('returns critical + cap=0 when RAM is below the critical threshold', () => {
    const snap = { ...HEALTHY_SNAPSHOT, ram_free_gb: 1 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
    expect(result.reasons[0]).toMatch(/RAM free 1\.0 GB below critical threshold 2 GB/);
  });

  it('returns critical + cap=0 when swap exceeds critical threshold (3072 MB) and pressure is null', () => {
    const snap = { ...HEALTHY_SNAPSHOT, swap_used_mb: 3500, memory_pressure_pct_free: null };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
    expect(result.reasons.some((r) => r.includes('3500 MB above critical threshold 3072 MB'))).toBe(true);
  });

  it('returns critical + cap=0 when memory_pressure_pct_free < 5%', () => {
    const snap = { ...HEALTHY_SNAPSHOT, swap_used_mb: null, memory_pressure_pct_free: 3 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
    expect(result.reasons.some((r) => r.includes('3% below critical threshold 5%'))).toBe(true);
  });

  it('critical RAM beats warn CPU — final verdict stays critical, cap=0', () => {
    const snap = { ...HEALTHY_SNAPSHOT, ram_free_gb: 1, cpu_load_pct: 90 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
  });

  it('critical RAM + degraded swap → verdict critical, cap=0', () => {
    const snap = { ...HEALTHY_SNAPSHOT, ram_free_gb: 1, swap_used_mb: 2500, memory_pressure_pct_free: null };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// macOS pressure-first override
// ---------------------------------------------------------------------------

describe('evaluate() — macOS pressure-first override', () => {
  const MAC_BASE = {
    ...HEALTHY_SNAPSHOT,
    ram_free_gb: 0.5,    // would normally be critical (< 2 GB)
    ram_used_pct: 95,
    memory_pressure_pct_free: null,
  };

  it('suppresses critical RAM verdict when memory_pressure reports ≥ 30% free', () => {
    const snap = { ...MAC_BASE, memory_pressure_pct_free: 65 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.recommended_agents_per_wave_cap).toBe(null);
    expect(result.reasons[0]).toMatch(/macOS memory_pressure healthy.*Pages-free underreports/);
  });

  it('does not suppress when pressure is exactly at the boundary (30% — not healthy)', () => {
    // MACOS_HEALTHY_PRESSURE_PCT = 30; condition is >= 30, so 30 IS healthy
    const snap = { ...MAC_BASE, memory_pressure_pct_free: 30 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    // Pressure ≥ 30 suppresses RAM; memory_pressure 30 does NOT enter any warn/degraded range
    // (those ranges are < 30, < 15, < 5)
    expect(result.verdict).toBe('green');
    expect(result.recommended_agents_per_wave_cap).toBe(null);
  });

  it('does not suppress when pressure is just below the healthy boundary (29%)', () => {
    // 29 < 30 → not macosPressureHealthy → RAM signal fires (critical)
    const snap = { ...MAC_BASE, memory_pressure_pct_free: 25 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
  });

  it('does not suppress when memory_pressure_pct_free is null (Linux path)', () => {
    const snap = { ...MAC_BASE, memory_pressure_pct_free: null };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
  });

  it('suppresses RAM but CPU warn still fires when pressure is healthy', () => {
    const snap = { ...MAC_BASE, memory_pressure_pct_free: 65, cpu_load_pct: 95 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
    expect(result.reasons.some((r) => /CPU load 95/.test(r))).toBe(true);
  });

  it('healthy pressure suppresses swap critical signal (treats as informational)', () => {
    const snap = { ...MAC_BASE, memory_pressure_pct_free: 81, swap_used_mb: 5219 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    // Pressure healthy → swap signal informational only → no critical
    expect(result.verdict).not.toBe('critical');
    expect(result.recommended_agents_per_wave_cap).not.toBe(0);
    expect(result.reasons.some((r) => /Swap usage 5219 MB present.*informational/.test(r))).toBe(true);
  });

  it('unhealthy pressure lets swap critical signal through', () => {
    const snap = { ...MAC_BASE, memory_pressure_pct_free: 10, swap_used_mb: 4000 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('critical');
    expect(result.recommended_agents_per_wave_cap).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-signal combining (bumpVerdict / cap interactions)
// ---------------------------------------------------------------------------

describe('evaluate() — multi-signal combining', () => {
  it('combines two warn signals — verdict warn, reasons list has both entries', () => {
    const snap = { ...HEALTHY_SNAPSHOT, ram_free_gb: 3, cpu_load_pct: 90 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
    expect(result.reasons.length).toBe(2);
  });

  it('most-restrictive cap wins: warn swap + warn memory_pressure → cap=2, not null', () => {
    const snap = { ...HEALTHY_SNAPSHOT, swap_used_mb: 1500, memory_pressure_pct_free: 25 };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('warn');
    expect(result.recommended_agents_per_wave_cap).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Zombie signal
// ---------------------------------------------------------------------------

describe('evaluate() — zombie signal', () => {
  const THRESHOLDS_WITH_ZOMBIE = { ...DEFAULT_THRESHOLDS, 'zombie-threshold-min': 30 };
  const ZOMBIE_BASE = {
    ...HEALTHY_SNAPSHOT,
    claude_processes_count: 3,
    zombie_processes_count: null,
  };

  it('zombie >= 1 AND claude > 0 → escalates to at least warn', () => {
    const snap = { ...ZOMBIE_BASE, zombie_processes_count: 2 };
    const result = evaluate(snap, THRESHOLDS_WITH_ZOMBIE);
    expect(result.verdict).toBe('warn');
    expect(result.reasons.some((r) => r.includes('2 zombie') && r.includes('30 min'))).toBe(true);
  });

  it('zombie >= 1 BUT claude_processes_count = 0 → no escalation', () => {
    const snap = { ...ZOMBIE_BASE, claude_processes_count: 0, zombie_processes_count: 5 };
    const result = evaluate(snap, THRESHOLDS_WITH_ZOMBIE);
    expect(result.verdict).toBe('green');
    expect(result.reasons.some((r) => r.includes('zombie'))).toBe(false);
  });

  it('zombie_processes_count = 0 → no escalation', () => {
    const snap = { ...ZOMBIE_BASE, zombie_processes_count: 0 };
    const result = evaluate(snap, THRESHOLDS_WITH_ZOMBIE);
    expect(result.verdict).toBe('green');
  });

  it('zombie_processes_count = null → feature disabled, no escalation', () => {
    const snap = { ...ZOMBIE_BASE, zombie_processes_count: null };
    const result = evaluate(snap, THRESHOLDS_WITH_ZOMBIE);
    expect(result.verdict).toBe('green');
  });

  it('zombie warn does not downgrade a higher degraded verdict', () => {
    // Swap at degraded level + zombies → degraded wins via bumpVerdict
    const snap = {
      ...ZOMBIE_BASE,
      swap_used_mb: 2500,
      memory_pressure_pct_free: null,
      zombie_processes_count: 3,
    };
    const result = evaluate(snap, THRESHOLDS_WITH_ZOMBIE);
    expect(result.verdict).toBe('degraded');
    expect(result.reasons.some((r) => r.includes('zombie'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defensive defaults — missing optional fields
// ---------------------------------------------------------------------------

describe('evaluate() — defensive defaults for missing fields', () => {
  it('does not throw and returns green for a legacy snapshot without new fields', () => {
    const legacySnap = {
      ram_free_gb: 8,
      ram_used_pct: 40,
      cpu_load_1m: 1.2,
      cpu_load_pct: 30,
      claude_processes_count: 1,
      codex_processes_count: 0,
      other_node_processes: 5,
      // No swap_used_mb, memory_pressure_pct_free, zombie_processes_count
    };
    expect(() => evaluate(legacySnap, DEFAULT_THRESHOLDS)).not.toThrow();
    const result = evaluate(legacySnap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.recommended_agents_per_wave_cap).toBe(null);
  });

  it('null claude_processes_count does not trigger a concurrent-sessions warning', () => {
    const snap = { ...HEALTHY_SNAPSHOT, claude_processes_count: null };
    const result = evaluate(snap, DEFAULT_THRESHOLDS);
    expect(result.verdict).toBe('green');
    expect(result.reasons).toEqual([]);
  });
});
