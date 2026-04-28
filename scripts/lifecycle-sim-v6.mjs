#!/usr/bin/env node
/**
 * scripts/lifecycle-sim-v6.mjs — Lifecycle simulation v6
 *
 * Issue #86 — measure the interaction between SO's enforcement layer and the
 * downstream Claude Code agent layer. Real telemetry (GL#84) is still blocked,
 * so v6 falls back to a discrete-event simulation parameterised from
 * directional intuition codified in the issue and the existing v3.2 docs.
 *
 * The sim does NOT claim statistical authority. It produces a directional
 * comparison between `enforcement: warn` and `enforcement: strict` over N
 * synthetic sessions with a fixed RNG seed. The output is meant to seed a
 * follow-up real-run experiment, not to drive a policy flip on its own.
 *
 * Usage:
 *   node scripts/lifecycle-sim-v6.mjs [--enforcement warn|strict|both]
 *                                     [--sessions N] [--seed K]
 *                                     [--json]
 *
 * Defaults: --enforcement both --sessions 100 --seed 42
 *
 * Exit codes (per cli-design.md):
 *   0  — sim ran successfully
 *   1  — bad CLI args
 *   2  — internal error
 */

import { parseArgs } from 'node:util';

// -----------------------------------------------------------------------------
// Deterministic RNG — mulberry32 (small, well-known, seedable)
// -----------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal sample, clamped to [min, max], rounded to int. */
function gaussianInt(rng, mean, stddev, min, max) {
  // two uniforms → standard normal
  let u1 = rng();
  if (u1 < 1e-9) u1 = 1e-9;
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const value = Math.round(mean + z * stddev);
  return Math.max(min, Math.min(max, value));
}

// -----------------------------------------------------------------------------
// Simulation parameters (kept as an explicit object so the report can echo them)
// -----------------------------------------------------------------------------
const PARAMS = Object.freeze({
  // Per-session planned issues sampled from a clipped Gaussian.
  plannedMean: 12,
  plannedStddev: 5,
  plannedMin: 5,
  plannedMax: 25,

  // Base completion rate (fraction of planned issues an idealised session
  // completes when nothing is blocked). Per-session jitter applied on top.
  baseCompletion: 0.78,
  completionJitter: 0.08, // ±8 percentage points

  // Probability that a planned issue triggers a scope-friction event during
  // its first edit attempt. Independent of enforcement level — the friction
  // exists regardless; what differs is what the harness *does* about it.
  scopeFrictionProb: 0.12,

  // Carryover into next session: fraction of unfinished issues that roll over.
  // 1.0 = everything carries over; lower values model dropped scope.
  carryoverFraction: 1.0,

  // Stagnation threshold: a session is "stagnant" when carryover_ratio > this.
  stagnationCarryoverRatio: 0.5,

  // Stagnation streak length triggering the "stagnant streak" bucket.
  stagnationStreakLength: 3,

  // Enforcement-mode-specific multipliers — see the report for the rationale
  // and limits of these values.
  modes: {
    warn: {
      // warn: friction is logged but the agent is allowed to retry, often
      // converging on a partial solution. Friction events drag completion
      // down moderately (each event costs ~1.5% completion) and a small
      // fraction of friction events become permanent blocks.
      frictionCompletionPenalty: 0.015,
      blockConversionRate: 0.18,
    },
    strict: {
      // strict: every scope-violation hard-aborts the agent's current step.
      // The agent has to re-plan. This hurts completion more per event but
      // converts fewer events into permanent blocks because the agent never
      // produces partial-but-wrong output.
      frictionCompletionPenalty: 0.025,
      blockConversionRate: 0.08,
    },
  },
});

// -----------------------------------------------------------------------------
// Single-mode simulation
// -----------------------------------------------------------------------------
function simulateMode({ mode, sessions, seed }) {
  if (!PARAMS.modes[mode]) {
    throw new Error(`Unknown enforcement mode: ${mode}`);
  }
  const { frictionCompletionPenalty, blockConversionRate } = PARAMS.modes[mode];

  // Seed each mode independently of the other so order doesn't matter, but
  // derive the seed from the user seed so re-runs with the same --seed are
  // identical.
  const modeSeed = seed ^ (mode === 'warn' ? 0xa5a5a5a5 : 0x5a5a5a5a);
  const rng = mulberry32(modeSeed);

  let carryoverIssues = 0;
  let stagnationStreak = 0;
  let longestStagnationStreak = 0;
  let stagnantSessionCount = 0;
  let totalPlanned = 0;
  let totalCompleted = 0;
  let totalBlocked = 0;
  const carryoverRatios = [];

  for (let i = 0; i < sessions; i++) {
    const fresh = gaussianInt(
      rng,
      PARAMS.plannedMean,
      PARAMS.plannedStddev,
      PARAMS.plannedMin,
      PARAMS.plannedMax,
    );
    const planned = fresh + carryoverIssues;
    totalPlanned += planned;

    // Friction events: one Bernoulli draw per planned issue.
    let frictionEvents = 0;
    let permanentBlocks = 0;
    for (let j = 0; j < planned; j++) {
      if (rng() < PARAMS.scopeFrictionProb) {
        frictionEvents += 1;
        if (rng() < blockConversionRate) {
          permanentBlocks += 1;
        }
      }
    }

    // Effective completion rate — base, jitter, friction penalty.
    const jitter = (rng() * 2 - 1) * PARAMS.completionJitter;
    let completionRate = PARAMS.baseCompletion + jitter;
    completionRate -= frictionEvents * frictionCompletionPenalty;
    completionRate = Math.max(0, Math.min(1, completionRate));

    const completable = planned - permanentBlocks;
    const completed = Math.min(completable, Math.round(completable * completionRate));
    totalCompleted += completed;
    totalBlocked += permanentBlocks;

    const unfinished = planned - completed;
    const carryoverRatio = planned === 0 ? 0 : unfinished / planned;
    carryoverRatios.push(carryoverRatio);

    if (carryoverRatio > PARAMS.stagnationCarryoverRatio) {
      stagnationStreak += 1;
      if (stagnationStreak >= PARAMS.stagnationStreakLength) {
        stagnantSessionCount += 1;
      }
      if (stagnationStreak > longestStagnationStreak) {
        longestStagnationStreak = stagnationStreak;
      }
    } else {
      stagnationStreak = 0;
    }

    carryoverIssues = Math.round(unfinished * PARAMS.carryoverFraction);
  }

  carryoverRatios.sort((a, b) => a - b);
  const meanCarryover =
    carryoverRatios.reduce((s, v) => s + v, 0) / carryoverRatios.length;
  const p95Index = Math.min(
    carryoverRatios.length - 1,
    Math.floor(0.95 * carryoverRatios.length),
  );
  const p95Carryover = carryoverRatios[p95Index];

  return {
    mode,
    sessions,
    totals: {
      planned: totalPlanned,
      completed: totalCompleted,
      blocked: totalBlocked,
    },
    completionRatio: totalPlanned === 0 ? 0 : totalCompleted / totalPlanned,
    carryover: {
      meanRatio: meanCarryover,
      p95Ratio: p95Carryover,
    },
    stagnation: {
      streakThreshold: PARAMS.stagnationStreakLength,
      carryoverThreshold: PARAMS.stagnationCarryoverRatio,
      stagnantSessions: stagnantSessionCount,
      stagnationRate: stagnantSessionCount / sessions,
      longestStreak: longestStagnationStreak,
    },
  };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      enforcement: { type: 'string', default: 'both' },
      sessions: { type: 'string', default: '100' },
      seed: { type: 'string', default: '42' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  return values;
}

const HELP = `lifecycle-sim-v6 — issue #86 directional simulation

Usage:
  node scripts/lifecycle-sim-v6.mjs [--enforcement warn|strict|both]
                                    [--sessions N] [--seed K]
                                    [--json]

Options:
  --enforcement   warn | strict | both  (default: both)
  --sessions N    number of simulated sessions per mode  (default: 100)
  --seed K        RNG seed for reproducibility           (default: 42)
  --json          emit JSON to stdout (default: human text)
  -h, --help      show this help

Exit codes:
  0  success
  1  bad arguments
  2  internal error
`;

function humanReport(results, opts) {
  const lines = [];
  lines.push('lifecycle-sim-v6 — directional results (NOT statistical)');
  lines.push(`seed=${opts.seed} sessions=${opts.sessions} per mode`);
  lines.push('');
  for (const r of results) {
    lines.push(`mode: ${r.mode}`);
    lines.push(`  planned issues:        ${r.totals.planned}`);
    lines.push(`  completed:             ${r.totals.completed}`);
    lines.push(`  permanently blocked:   ${r.totals.blocked}`);
    lines.push(`  completion ratio:      ${r.completionRatio.toFixed(3)}`);
    lines.push(`  mean carryover ratio:  ${r.carryover.meanRatio.toFixed(3)}`);
    lines.push(`  p95 carryover ratio:   ${r.carryover.p95Ratio.toFixed(3)}`);
    lines.push(
      `  stagnant sessions:     ${r.stagnation.stagnantSessions} ` +
        `(rate ${r.stagnation.stagnationRate.toFixed(3)})`,
    );
    lines.push(`  longest streak:        ${r.stagnation.longestStreak}`);
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`bad args: ${err.message}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const sessions = Number.parseInt(opts.sessions, 10);
  const seed = Number.parseInt(opts.seed, 10);
  if (!Number.isFinite(sessions) || sessions <= 0) {
    process.stderr.write('--sessions must be a positive integer\n');
    return 1;
  }
  if (!Number.isFinite(seed)) {
    process.stderr.write('--seed must be an integer\n');
    return 1;
  }

  let modes;
  if (opts.enforcement === 'both') {
    modes = ['warn', 'strict'];
  } else if (opts.enforcement === 'warn' || opts.enforcement === 'strict') {
    modes = [opts.enforcement];
  } else {
    process.stderr.write(`--enforcement must be warn|strict|both\n`);
    return 1;
  }

  let results;
  try {
    results = modes.map((mode) => simulateMode({ mode, sessions, seed }));
  } catch (err) {
    process.stderr.write(`sim error: ${err.message}\n`);
    return 2;
  }

  if (opts.json) {
    const out = {
      seed,
      sessions,
      params: PARAMS,
      results,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(humanReport(results, { sessions, seed }));
  }
  return 0;
}

// Entry point — only run when invoked as a script (not when imported by tests).
const isDirectRun = (() => {
  try {
    const argv1 = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
    return import.meta.url === argv1;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  process.exit(main());
}

// Named exports for tests.
export { mulberry32, gaussianInt, simulateMode, PARAMS, parseCli, main };
