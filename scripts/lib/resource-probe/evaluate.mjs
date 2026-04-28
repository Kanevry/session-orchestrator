/**
 * evaluate.mjs — verdict + threshold logic for resource snapshots.
 *
 * Evaluates a snapshot (output of probe()) against `resource-thresholds`
 * from Session Config (#166) and returns a verdict used by session-start Phase 4.5.
 *
 * Part of v3.1.0 Epic #157 / Issue #163.
 * Extended in v3.2 Phase C-2 (#296): swap + memory_pressure verdict rules.
 * Zombie rule wired end-to-end in #178.
 * Split from resource-probe.mjs in #287 (hotspot 2/2).
 */

// ---------------------------------------------------------------------------
// Verdict precedence helper
// ---------------------------------------------------------------------------

const VERDICT_RANK = { green: 0, warn: 1, degraded: 2, critical: 3 };

/**
 * Return the more restrictive of two verdicts.
 * @param {string} current
 * @param {string} target
 * @returns {string}
 */
function bumpVerdict(current, target) {
  const currentRank = VERDICT_RANK[current] ?? 0;
  const targetRank = VERDICT_RANK[target] ?? 0;
  return targetRank > currentRank ? target : current;
}

/**
 * Evaluate a snapshot against `resource-thresholds` (from Session Config #166)
 * and return a verdict used by session-start Phase 4.5.
 * @param {object} snapshot — output of probe()
 * @param {object} thresholds — resource-thresholds block from parseSessionConfig
 * @returns {{verdict: 'green'|'warn'|'degraded'|'critical', reasons: string[], recommended_agents_per_wave_cap: number|null}}
 */
export function evaluate(snapshot, thresholds) {
  const reasons = [];
  let verdict = 'green';
  let cap = null;

  const { ram_free_gb, cpu_load_pct, claude_processes_count } = snapshot;
  const {
    'ram-free-min-gb': ramMin,
    'ram-free-critical-gb': ramCrit,
    'cpu-load-max-pct': cpuMax,
    'concurrent-sessions-warn': concWarn,
  } = thresholds;

  if (ram_free_gb < ramCrit) {
    verdict = 'critical';
    cap = 0;
    reasons.push(`RAM free ${ram_free_gb.toFixed(1)} GB below critical threshold ${ramCrit} GB — recommend coordinator-direct (0 agents).`);
  } else if (ram_free_gb < ramMin) {
    if (verdict === 'green') verdict = 'warn';
    cap = cap === null ? 2 : Math.min(cap, 2);
    reasons.push(`RAM free ${ram_free_gb.toFixed(1)} GB below threshold ${ramMin} GB — capping agents-per-wave at 2.`);
  }

  if (cpu_load_pct > cpuMax) {
    if (verdict === 'green') verdict = 'warn';
    cap = cap === null ? 2 : Math.min(cap, 2);
    reasons.push(`CPU load ${cpu_load_pct}% above threshold ${cpuMax}% — capping agents-per-wave at 2.`);
  }

  if (claude_processes_count !== null && claude_processes_count !== undefined && claude_processes_count >= concWarn) {
    if (verdict === 'green') verdict = 'warn';
    reasons.push(`${claude_processes_count} Claude processes already running (threshold: ${concWarn}) — consider sequencing this session after others finish.`);
  }

  // ---------------------------------------------------------------------------
  // Zombie signal (#178): null = feature disabled (zombieThresholdMin absent) → no rule fires
  // Escalates to warn only when BOTH zombie_processes_count >= 1 AND
  // claude_processes_count is elevated (>= concWarn or > 0 with zombies).
  // ---------------------------------------------------------------------------
  const { zombie_processes_count } = snapshot;
  if (zombie_processes_count !== null && zombie_processes_count !== undefined && zombie_processes_count >= 1) {
    const claudeElevated =
      claude_processes_count !== null &&
      claude_processes_count !== undefined &&
      claude_processes_count > 0;
    if (claudeElevated) {
      verdict = bumpVerdict(verdict, 'warn');
      reasons.push(`${zombie_processes_count} zombie Claude/Node process(es) detected (age > ${thresholds['zombie-threshold-min'] ?? 30} min, idle CPU) with ${claude_processes_count} Claude process(es) running — consider sweeping stale sessions.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Swap signal (macOS / Linux only; null = signal unavailable → no rule fires)
  // ---------------------------------------------------------------------------
  const { swap_used_mb } = snapshot;
  if (swap_used_mb !== null && swap_used_mb !== undefined) {
    if (swap_used_mb > 3072) {
      verdict = bumpVerdict(verdict, 'critical');
      cap = 0;
      reasons.push(`Swap usage ${swap_used_mb} MB above critical threshold 3072 MB — recommend coordinator-direct (0 agents).`);
    } else if (swap_used_mb > 2048) {
      const newVerdict = bumpVerdict(verdict, 'degraded');
      if (newVerdict !== verdict) {
        verdict = newVerdict;
        cap = cap === null ? 2 : Math.min(cap, 2);
      }
      reasons.push(`Swap usage ${swap_used_mb} MB in degraded range (2048..3072 MB) — capping agents-per-wave at 2.`);
    } else if (swap_used_mb > 1024) {
      const newVerdict = bumpVerdict(verdict, 'warn');
      if (newVerdict !== verdict) {
        verdict = newVerdict;
        cap = cap === null ? 2 : Math.min(cap, 2);
      }
      reasons.push(`Swap usage ${swap_used_mb} MB in warn range (1024..2048 MB) — capping agents-per-wave at 2.`);
    }
  }

  // ---------------------------------------------------------------------------
  // macOS memory_pressure signal (null = signal unavailable → no rule fires)
  // ---------------------------------------------------------------------------
  const { memory_pressure_pct_free } = snapshot;
  if (memory_pressure_pct_free !== null && memory_pressure_pct_free !== undefined) {
    if (memory_pressure_pct_free < 5) {
      verdict = bumpVerdict(verdict, 'critical');
      cap = 0;
      reasons.push(`macOS memory_pressure free ${memory_pressure_pct_free}% below critical threshold 5% — recommend coordinator-direct (0 agents).`);
    } else if (memory_pressure_pct_free < 15) {
      const newVerdict = bumpVerdict(verdict, 'degraded');
      if (newVerdict !== verdict) {
        verdict = newVerdict;
        cap = cap === null ? 2 : Math.min(cap, 2);
      }
      reasons.push(`macOS memory_pressure free ${memory_pressure_pct_free}% in degraded range (5..15%) — capping agents-per-wave at 2.`);
    } else if (memory_pressure_pct_free < 30) {
      const newVerdict = bumpVerdict(verdict, 'warn');
      if (newVerdict !== verdict) {
        verdict = newVerdict;
        cap = cap === null ? 2 : Math.min(cap, 2);
      }
      reasons.push(`macOS memory_pressure free ${memory_pressure_pct_free}% in warn range (15..30%) — capping agents-per-wave at 2.`);
    }
  }

  // Ensure cap aligns with final verdict when critical was triggered by swap/memory_pressure
  // (the bumpVerdict path sets cap=0 inline for critical, but re-affirm for safety)
  if (verdict === 'critical') {
    cap = 0;
  }

  return { verdict, reasons, recommended_agents_per_wave_cap: cap };
}
