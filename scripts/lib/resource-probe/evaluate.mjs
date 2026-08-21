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
 * Rebuilt in #1089 — signal precedence + right units + the two-signal rule.
 *
 * ---------------------------------------------------------------------------
 * #1089 — why this file was rebuilt
 * ---------------------------------------------------------------------------
 * Measured 2026-08-21 over 1477 `orchestrator.session.started` events across 18
 * repos (2026-04-19 → 2026-08-21): the previous rule set produced a warn-or-worse
 * verdict on 1462 of them — 99.0%. The three drivers were each a MEASUREMENT
 * defect, not a threshold set too tight:
 *
 *   1. `ram_free_gb` is `os.freemem()`, which on Darwin reports only `Pages free`.
 *      Median across the corpus: 0.4 GB; 53.8% of samples below 0.5 GB. So
 *      `ram-free-critical-gb: 2` fired on 84.0% of ALL session starts. Six repos
 *      independently recorded this as a false alarm in their learnings store —
 *      one at confidence 1.0 ("decide concurrency on ramAvailableGb, not the free
 *      number"), one noting "five consecutive sessions wrongly capped at 2".
 *   2. `concurrent-sessions-warn` is named for SESSIONS but was compared against
 *      `claude_processes_count`. Measured ratio processes:sessions = 6.0. That
 *      threshold fired on 93.6% of starts; against the real peer count it fires
 *      on 4.2%.
 *   3. Any ONE soft signal capped agents-per-wave at 2 outright, so the union of
 *      three noisy axes decided wave size on its noisiest member.
 *
 * Counter-evidence that makes this a re-aim rather than a removal: the
 * 2026-04-19 incident (8-session host freeze + 2 worktree OOMs) was real, and a
 * separate repo recorded (conf 0.9) that Chromium mis-paints under genuine
 * memory pressure. The hazard exists — the old detector could not see it through
 * its own noise floor.
 *
 * The rebuilt rules keep every protection and change what is measured:
 *
 *   - SIGNAL PRECEDENCE (memory): judge on the best available signal, never on a
 *     worse one that merely happens to also be present. `memory_pressure_pct_free`
 *     (the OS's own health verdict) outranks `ram_available_gb`, which outranks
 *     `ram_free_gb`. On Linux/Windows `os.freemem()` IS accurate and stays the
 *     signal — the demotion is Darwin-specific by construction, since only Darwin
 *     publishes the two better signals. The old code merely SUPPRESSED a free-RAM
 *     verdict when pressure was healthy, which left the whole band
 *     "pressure present but <30%" still being judged on Pages-free.
 *   - RIGHT UNIT (concurrency): `peer_sessions_count` (live session registry)
 *     when present. `claude_processes_count` survives only as a fallback, scaled
 *     by the measured PROCESSES_PER_SESSION factor so the configured threshold
 *     keeps meaning "sessions" on hosts where the registry is unavailable.
 *   - TWO-SIGNAL RULE: a single soft signal is informational — reported in
 *     `reasons`, capping nothing. A cap needs two INDEPENDENT soft signals
 *     agreeing, or one hard signal. Simulated on the same 1477-sample corpus:
 *     `cpu>90 AND peers>=3` fires on 2.2%, `peers>=4` alone on 7.4%.
 *
 * Governing principle, stated here and in `.claude/rules/host-resources.md`:
 * a signal may only warn if it is rare. A warning class firing on more than ~10%
 * of starts is a broken instrument to be re-aimed, not a policy to obey.
 */

// ---------------------------------------------------------------------------
// Verdict precedence helper
// ---------------------------------------------------------------------------

/**
 * `degraded` is retained in the rank table for back-compat: `evaluate()` no
 * longer PRODUCES it (the rebuilt rules emit green | warn | critical only), but
 * external callers may still pass a stored legacy verdict through
 * {@link bumpVerdict}, and ranking it between warn and critical keeps that
 * comparison meaningful.
 */
const VERDICT_RANK = { green: 0, warn: 1, degraded: 2, critical: 3 };

/**
 * Return the more restrictive of two verdicts.
 * @param {string} current
 * @param {string} target
 * @returns {string}
 */
export function bumpVerdict(current, target) {
  const currentRank = VERDICT_RANK[current] ?? 0;
  const targetRank = VERDICT_RANK[target] ?? 0;
  return targetRank > currentRank ? target : current;
}

/**
 * macOS memory_pressure bands, as percentages of memory the OS reports free.
 *
 * Apple's Activity Monitor has used memory_pressure — not "free RAM" — as the
 * canonical health indicator since 10.9 Mavericks; these bands match the colours
 * it renders (green ≥30, yellow 15..30, red <15).
 *
 *   HEALTHY (≥30): compressor + caches are keeping up. No memory signal at all.
 *   SOFT    (<30): worth reporting; not worth capping on its own.
 *   HARD    (<15): genuine pressure — the band the 2026-04-19 freeze sat in.
 */
export const PRESSURE_HEALTHY_PCT = 30;
export const PRESSURE_SOFT_PCT = 30;
export const PRESSURE_HARD_PCT = 15;

/**
 * Measured processes-per-session factor (median `claude_processes_count` /
 * `peer_count` = 6.0 over 1461 paired samples, 2026-08-21). Used ONLY to rescale
 * the session-denominated `concurrent-sessions-warn` threshold when the live
 * registry count is unavailable and a raw process count is all we have.
 *
 * Named ceiling (BV-004): this is one host family's ratio, not a law. Revisit if
 * `peer_sessions_count` is unavailable on a host where Claude Code's per-session
 * process fan-out differs materially — the fallback then mis-scales in whichever
 * direction the real ratio moved.
 */
export const PROCESSES_PER_SESSION = 6;

/** Swap bands (MB). Only consulted when the memory signal is NOT healthy. */
const SWAP_HARD_MB = 3072;
const SWAP_SOFT_MB = 1024;

/**
 * Canonical `resource-thresholds` defaults — the ONE definition (#1089).
 *
 * Before this constant existed there were three, and they had drifted:
 * `config/vault-integration.mjs` had 4 / 2 / 80 / 5, `dispatcher/rank.mjs` had
 * the same four, and `autopilot.mjs` had 2.0 / 0.5 / 85 / 3 under a comment
 * claiming it "mirrors resource-probe hard-coded values" — so autopilot was
 * judging every host against a threshold set nothing else used, and the comment
 * asserting otherwise is what kept anyone from noticing. Config-supplied values
 * still override these; this is only the floor when a repo declares none.
 */
export const DEFAULT_RESOURCE_THRESHOLDS = Object.freeze({
  'ram-free-min-gb': 4,
  'ram-free-critical-gb': 2,
  'cpu-load-max-pct': 90,
  'concurrent-sessions-warn': 5,
});

/**
 * Resolve which memory signal to judge on, in strict precedence order.
 *
 * This is the heart of the #1089 fix. The old code fell back to `ram_free_gb`
 * whenever `ram_available_gb` was absent, EVEN IF `memory_pressure_pct_free` was
 * present but merely below its healthy band — so a Darwin host reporting
 * "0.3 GB free / 20% pressure-free" was judged on the 0.3 and went critical.
 * Precedence removes that: a better signal, when present, does not suppress the
 * worse one, it REPLACES it.
 *
 * @param {object} snapshot
 * @param {number} ramMin — `ram-free-min-gb`
 * @param {number} ramCrit — `ram-free-critical-gb`
 * @returns {{kind: 'pressure'|'available'|'free', hard: boolean, soft: boolean, reason: string|null}}
 */
function memorySignal(snapshot, ramMin, ramCrit) {
  const { ram_free_gb, ram_available_gb, memory_pressure_pct_free } = snapshot;

  const hasPressure =
    memory_pressure_pct_free !== null && memory_pressure_pct_free !== undefined;
  if (hasPressure) {
    if (memory_pressure_pct_free < PRESSURE_HARD_PCT) {
      return {
        kind: 'pressure',
        hard: true,
        soft: false,
        reason: `macOS memory_pressure ${memory_pressure_pct_free}% free — below the hard band (<${PRESSURE_HARD_PCT}%); the OS reports genuine memory pressure.`,
      };
    }
    if (memory_pressure_pct_free < PRESSURE_SOFT_PCT) {
      return {
        kind: 'pressure',
        hard: false,
        soft: true,
        reason: `macOS memory_pressure ${memory_pressure_pct_free}% free — in the soft band (${PRESSURE_HARD_PCT}..${PRESSURE_SOFT_PCT}%).`,
      };
    }
    return {
      kind: 'pressure',
      hard: false,
      soft: false,
      reason: `macOS memory_pressure healthy (${memory_pressure_pct_free}% free ≥ ${PRESSURE_HEALTHY_PCT}%) — free-RAM not consulted (Pages-free underreports on Darwin).`,
    };
  }

  const hasAvailable =
    ram_available_gb !== null && ram_available_gb !== undefined;
  const effective = hasAvailable ? ram_available_gb : ram_free_gb;
  const label = hasAvailable ? 'RAM available' : 'RAM free';

  if (effective < ramCrit) {
    return {
      kind: hasAvailable ? 'available' : 'free',
      hard: true,
      soft: false,
      reason: `${label} ${effective.toFixed(1)} GB below critical threshold ${ramCrit} GB.`,
    };
  }
  if (effective < ramMin) {
    return {
      kind: hasAvailable ? 'available' : 'free',
      hard: false,
      soft: true,
      reason: `${label} ${effective.toFixed(1)} GB below threshold ${ramMin} GB.`,
    };
  }
  return {
    kind: hasAvailable ? 'available' : 'free',
    hard: false,
    soft: false,
    reason: null,
  };
}

/**
 * Resolve the concurrency signal, preferring the live session registry count
 * over the raw process count. Returns `null` when neither is available.
 *
 * @param {object} snapshot
 * @param {number} concWarn — configured threshold, denominated in SESSIONS
 * @returns {{soft: boolean, reason: string|null}|null}
 */
function concurrencySignal(snapshot, concWarn) {
  const { peer_sessions_count, claude_processes_count } = snapshot;

  const hasPeers =
    peer_sessions_count !== null && peer_sessions_count !== undefined;
  if (hasPeers) {
    if (peer_sessions_count >= concWarn) {
      return {
        soft: true,
        reason: `${peer_sessions_count} peer session(s) live in the registry (threshold: ${concWarn}) — consider sequencing this session after others finish.`,
      };
    }
    return { soft: false, reason: null };
  }

  const hasProcs =
    claude_processes_count !== null && claude_processes_count !== undefined;
  if (!hasProcs) return null;

  // Registry unavailable — fall back to the process count, rescaled so the
  // session-denominated threshold keeps its meaning. Without this factor the
  // comparison carries a measured 6x unit error, which is what fired on 93.6%
  // of session starts before #1089.
  const procThreshold = concWarn * PROCESSES_PER_SESSION;
  if (claude_processes_count >= procThreshold) {
    return {
      soft: true,
      reason: `${claude_processes_count} Claude processes running (fallback threshold ${procThreshold} = ${concWarn} sessions × ${PROCESSES_PER_SESSION} processes/session; the live session registry was unavailable).`,
    };
  }
  return { soft: false, reason: null };
}

/**
 * Resolve an `agentsPerWave` option value into a plain numeric cap, or `null`
 * when no cap should apply. Mirrors `resolveApwCap()` in
 * `../wave-resource-gate.mjs` — kept as a local pure helper here rather than
 * a cross-module import since both sites are ≤10 lines and evolve
 * independently per their own gate's options shape.
 *
 * `evaluate()` has no session-mode input in scope, so the object shape
 * resolves to `cap.default` — the documented HR-003 convention writes the
 * override as `<default> (mode: <higher-ceiling>)`, i.e. `default` is the
 * MORE restrictive of the pair, so this can only under-apply a looser
 * mode-specific ceiling, never let a heavy repo exceed its base cap.
 *
 * @param {number|{default: number, [mode: string]: number}|*} cap
 * @returns {number|null}
 */
function resolveAgentsPerWaveCap(cap) {
  if (typeof cap === 'number') return Number.isFinite(cap) ? cap : null;
  if (cap !== null && typeof cap === 'object' && !Array.isArray(cap)) {
    const def = cap.default;
    return typeof def === 'number' && Number.isFinite(def) ? def : null;
  }
  return null;
}

/**
 * Evaluate a snapshot against `resource-thresholds` (from Session Config #166)
 * and return a verdict used by session-start Phase 4.5.
 *
 * @param {object} snapshot — output of probe()
 * @param {object} thresholds — resource-thresholds block from parseSessionConfig
 * @param {{heavyRepo?: boolean, agentsPerWave?: number|{default: number, [mode: string]: number}}} [options] — HR-003/HR-004
 *   preflight ceiling (baseline #60). When `heavyRepo` is true and `agentsPerWave`
 *   resolves to a number, `recommended_agents_per_wave_cap` is forced to at most
 *   that number REGARDLESS of the live-probe verdict — a static preflight ceiling,
 *   not a runtime signal. More-restrictive-wins. Omitted entirely = back-compat.
 * @returns {{verdict: 'green'|'warn'|'critical', reasons: string[], recommended_agents_per_wave_cap: number|null, signals: {hard: string[], soft: string[]}}}
 */
export function evaluate(snapshot, thresholds, options = {}) {
  const reasons = [];
  const hardSignals = [];
  const softSignals = [];

  const {
    cpu_load_pct,
    cpu_load_5m_pct,
    claude_processes_count,
    peer_sessions_count,
    swap_used_mb,
    zombie_processes_count,
  } = snapshot;
  const {
    'ram-free-min-gb': ramMin,
    'ram-free-critical-gb': ramCrit,
    'cpu-load-max-pct': cpuMax,
    'concurrent-sessions-warn': concWarn,
  } = thresholds;

  // --- Memory axis: strict signal precedence (see memorySignal docstring) ----
  const mem = memorySignal(snapshot, ramMin, ramCrit);
  if (mem.hard) {
    hardSignals.push('memory');
    reasons.push(mem.reason);
  } else if (mem.soft) {
    softSignals.push('memory');
    reasons.push(mem.reason);
  } else if (mem.reason) {
    // Healthy-pressure note — kept because it explains why an alarming
    // "0.x GB free" banner number did NOT drive the verdict.
    reasons.push(mem.reason);
  }
  const memoryHealthy = !mem.hard && !mem.soft;

  // --- CPU axis (#943) ------------------------------------------------------
  // The 1m load average systematically carries the decaying tail of the
  // coordinator's own just-finished gate run (the caller sits right after the
  // inter-wave Quality Gate by construction). Judge on min(1m, 5m) when the
  // probe supplied a numeric 5m value: only-1m-high is a decaying transient,
  // both-high is genuine sustained load. Null 5m (Windows, zero-load) → 1m only.
  const has5mCpu = typeof cpu_load_5m_pct === 'number' && Number.isFinite(cpu_load_5m_pct);
  const effectiveCpuPct = has5mCpu ? Math.min(cpu_load_pct, cpu_load_5m_pct) : cpu_load_pct;
  if (effectiveCpuPct > cpuMax) {
    softSignals.push('cpu');
    const detail = has5mCpu ? ` (min of 1m ${cpu_load_pct}% / 5m ${cpu_load_5m_pct}%)` : '';
    reasons.push(`CPU load ${effectiveCpuPct}%${detail} above threshold ${cpuMax}%.`);
  } else if (has5mCpu && cpu_load_pct > cpuMax) {
    reasons.push(`info: CPU 1m load ${cpu_load_pct}% above threshold ${cpuMax}% but 5m load ${cpu_load_5m_pct}% is below — decaying transient (likely the coordinator's own gate run); not counted as a signal (#943).`);
  }

  // --- Concurrency axis: registry sessions, not raw process count -----------
  const conc = concurrencySignal(snapshot, concWarn);
  if (conc && conc.soft) {
    softSignals.push('concurrency');
    reasons.push(conc.reason);
  }

  // --- Swap: only meaningful when the memory signal is NOT healthy ----------
  // On macOS swap accumulates over a machine's uptime and is not a real-time
  // pressure indicator, so a large cumulative figure under healthy pressure is
  // history, not load. Observed on the reference host 2026-08-21: 6884 MB swap
  // used with memory_pressure reporting 35% free and the machine responsive.
  if (swap_used_mb !== null && swap_used_mb !== undefined) {
    if (memoryHealthy) {
      if (swap_used_mb > SWAP_SOFT_MB) {
        reasons.push(`info: swap usage ${swap_used_mb} MB present but the memory signal is healthy — cumulative, not live pressure; not counted as a signal.`);
      }
    } else if (swap_used_mb > SWAP_HARD_MB) {
      hardSignals.push('swap');
      reasons.push(`Swap usage ${swap_used_mb} MB above hard threshold ${SWAP_HARD_MB} MB while memory is under pressure.`);
    } else if (swap_used_mb > SWAP_SOFT_MB) {
      softSignals.push('swap');
      reasons.push(`Swap usage ${swap_used_mb} MB above ${SWAP_SOFT_MB} MB while memory is under pressure.`);
    }
  }

  // --- Zombies (#178) — INFORMATIONAL ONLY ----------------------------------
  //
  // A stale-but-idle process holds RAM without doing work, so it is worth
  // reporting. It is NOT a capacity signal, and #1089's first live run proved
  // why counting it as one re-opens the bug this module just closed:
  //
  //   VERDICT: warn | cap 2 | soft: ["cpu", "zombies"]
  //
  // Zombies are, by their own definition, idle (CPU <= 1%) — they are not
  // causing the CPU load they were pairing with. And they are a STANDING
  // condition on a developer host: three measurements minutes apart on the
  // reference machine read 6, 13 and 9. A signal that is essentially always
  // present is not a second opinion; pairing it with any other axis silently
  // restores the one-signal cap under a two-signal name.
  //
  // So it reports and never counts. This also aligns the code with the rule
  // text it always claimed to implement — `.claude/rules/host-resources.md`
  // HR-104: "sweeping stale sessions is housekeeping advice, not a reason to
  // shrink a wave."
  //
  // Still gated on a live peer/process context so a lone leftover on an
  // otherwise idle host stays quiet.
  if (zombie_processes_count !== null && zombie_processes_count !== undefined && zombie_processes_count >= 1) {
    const liveContext =
      (peer_sessions_count !== null && peer_sessions_count !== undefined && peer_sessions_count > 0) ||
      (claude_processes_count !== null && claude_processes_count !== undefined && claude_processes_count > 0);
    if (liveContext) {
      reasons.push(`info: ${zombie_processes_count} zombie Claude/Node process(es) detected (age > ${thresholds['zombie-threshold-min'] ?? 30} min, idle CPU) — consider sweeping stale sessions; not counted as a capacity signal.`);
    }
  }

  // --- Two-signal rule ------------------------------------------------------
  // One hard signal → critical. Two independent soft signals → warn. A single
  // soft signal is reported and caps nothing: that is the whole point of #1089,
  // because each axis alone is noisy enough that their union fired on 99.0% of
  // measured session starts.
  let verdict = 'green';
  let cap = null;
  if (hardSignals.length > 0) {
    verdict = 'critical';
    cap = 0;
    reasons.push(`Hard signal (${hardSignals.join(' + ')}) — recommend coordinator-direct (0 agents).`);
  } else if (softSignals.length >= 2) {
    verdict = 'warn';
    cap = 2;
    reasons.push(`Two independent signals agree (${softSignals.join(' + ')}) — capping agents-per-wave at 2.`);
  } else if (softSignals.length === 1) {
    reasons.push(`info: one signal (${softSignals[0]}) is elevated but no second signal agrees — reporting only, no cap (two-signal rule, #1089).`);
  }

  // ---------------------------------------------------------------------------
  // HR-003/HR-004 heavy-repo preflight ceiling (#60): a STATIC cap independent
  // of the live-probe verdict. Applies only when heavyRepo is true and
  // agentsPerWave is a finite number — more-restrictive-wins against whatever
  // the live-probe signals already computed.
  // ---------------------------------------------------------------------------
  const { heavyRepo, agentsPerWave } = options;
  const resolvedApwCap = resolveAgentsPerWaveCap(agentsPerWave);
  if (heavyRepo === true && resolvedApwCap !== null) {
    cap = cap === null ? resolvedApwCap : Math.min(cap, resolvedApwCap);
  }

  return {
    verdict,
    reasons,
    recommended_agents_per_wave_cap: cap,
    signals: { hard: hardSignals, soft: softSignals },
  };
}
