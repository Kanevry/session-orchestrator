#!/usr/bin/env node
/**
 * autopilot.mjs — Phase C-5 headless CLI driver for the /autopilot loop.
 *
 * Issue #302 (Phase C-5). Wires real implementations of the four injectable
 * seams defined by `runLoop` in `scripts/lib/autopilot.mjs` and lets the user
 * run the autopilot loop unattended from the CLI.
 *
 * Usage:
 *   node scripts/autopilot.mjs --headless [options]
 *
 * Flags:
 *   --headless                  Required. Activates headless mode.
 *   --max-sessions=N            Max iterations (1..50, default 5).
 *   --max-hours=H               Max wall-clock hours (0.5..24.0, default 4.0).
 *   --confidence-threshold=0.X  Mode confidence gate (0.0..1.0, default 0.85).
 *   --dry-run                   Emit a single record without spawning sessions.
 *   --verbose                   Pipe child process stdio (instead of inherit).
 *
 * Exit codes:
 *   0 — clean termination (max-sessions-reached, max-hours-exceeded, or fallback-to-manual).
 *   1 — uncaught error.
 *   2 — kill_switch=failed-wave, or missing --headless flag.
 *
 * References:
 *   scripts/lib/autopilot.mjs   — runLoop, parseFlags, writeAutopilotJsonl
 *   scripts/lib/build-live-signals.mjs — buildLiveSignals
 *   scripts/lib/mode-selector.mjs      — selectMode
 *   scripts/lib/resource-probe.mjs     — probe, evaluate
 *   scripts/lib/session-registry.mjs   — detectPeers
 *   scripts/lib/session-schema.mjs     — normalizeSession
 *   "/autopilot Loop Command (Phase C)" (#277/#271; archived in the private Meta-Vault)
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';

import {
  runLoop,
  parseFlags,
  KILL_SWITCHES,
} from './lib/autopilot.mjs';
import { buildLiveSignals } from './lib/build-live-signals.mjs';
import { surfaceTopN, decayOptsFromConfig } from './lib/learnings/surface.mjs';
import { selectMode } from './lib/mode-selector.mjs';
import { probe, evaluate } from './lib/resource-probe.mjs';
import { detectPeers } from './lib/session-registry.mjs';
import { normalizeSession } from './lib/session-schema.mjs';

// ---------------------------------------------------------------------------
// CLI-level flag extraction
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

const hasHeadless = argv.includes('--headless');
const hasVerbose = argv.includes('--verbose');

if (!hasHeadless) {
  process.stderr.write('autopilot: headless mode requires --headless flag\n');
  process.exit(2);
}

// Strip CLI-only flags before forwarding to parseFlags (which ignores unknown
// flags, but being explicit avoids confusion with future parseFlags additions).
const flagsForParse = argv.filter(
  (a) => a !== '--headless' && a !== '--verbose'
);

const { maxSessions, maxHours, confidenceThreshold, dryRun } = parseFlags(flagsForParse);

// ---------------------------------------------------------------------------
// Session Config (parsed once, shared by thresholds + decay readers)
// ---------------------------------------------------------------------------

/**
 * Parse Session Config once by spawning `node scripts/parse-config.mjs`.
 * Returns the parsed config object, or `null` if the spawn fails / yields
 * no usable stdout. Callers fall back to their own defaults on `null`.
 *
 * @returns {object|null}
 */
function loadConfig() {
  try {
    const scriptPath = resolve(
      new URL('.', import.meta.url).pathname,
      'parse-config.mjs'
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath],
      { encoding: 'utf8', timeout: 10_000 }
    );
    if (result.status !== 0 || !result.stdout) return null;
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// Resource-thresholds from Session Config
// ---------------------------------------------------------------------------

/**
 * Read the `resource-thresholds` block from the parsed Session Config. Falls
 * back to the resource-probe defaults if the field is absent or config is null.
 *
 * @returns {object} thresholds object consumable by evaluate()
 */
function loadResourceThresholds() {
  // Probe defaults (mirrors resource-probe hard-coded values)
  const DEFAULTS = {
    'ram-free-min-gb': 2.0,
    'ram-free-critical-gb': 0.5,
    'cpu-load-max-pct': 85,
    'concurrent-sessions-warn': 3,
  };

  const rt = config && config['resource-thresholds'];
  if (rt && typeof rt === 'object') {
    return { ...DEFAULTS, ...rt };
  }
  return DEFAULTS;
}

const thresholds = loadResourceThresholds();

// ---------------------------------------------------------------------------
// Learnings loader — top-15 active learnings from learnings.jsonl
// ---------------------------------------------------------------------------
//
// Delegates to scripts/lib/learnings/surface.mjs (`surfaceTopN`). Same filter
// semantics as the original inline implementation: confidence > 0.3 AND
// (no expires_at OR expires_at > now), sorted by effectiveScore DESC (#670
// time-decay), then created_at DESC, then sliced to n=15. The `evolve.decay`
// Session Config block is threaded through `decayOptsFromConfig` so the
// documented decay knobs (decay-enabled / decay-half-life-days /
// decay-floor-factor) actually take effect here (#670). Errors swallowed → [].

const surfacedLearnings = await surfaceTopN(
  resolve('.orchestrator/metrics/learnings.jsonl'),
  15,
  { decay: decayOptsFromConfig(config && config['evolve.decay']) }
);

// ---------------------------------------------------------------------------
// Branch detection for autopilot_run_id construction
// ---------------------------------------------------------------------------

function detectBranch() {
  try {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

const branch = detectBranch();

// ---------------------------------------------------------------------------
// sessions.jsonl helpers for sessionRunner
// ---------------------------------------------------------------------------

const SESSIONS_JSONL_PATH = resolve('.orchestrator/metrics/sessions.jsonl');

/**
 * Count the number of non-empty lines in sessions.jsonl. Returns 0 if missing.
 * @returns {number}
 */
function countSessionLines() {
  if (!existsSync(SESSIONS_JSONL_PATH)) return 0;
  try {
    const raw = readFileSync(SESSIONS_JSONL_PATH, 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Read the last non-empty line from sessions.jsonl, parse it, run it through
 * normalizeSession, and project to the sessionRunner return shape.
 *
 * @returns {{session_id: string, agent_summary?: object, effectiveness?: object}}
 */
function readTailSession() {
  const raw = readFileSync(SESSIONS_JSONL_PATH, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('sessions.jsonl is empty after session completed');
  }
  const parsed = JSON.parse(lines[lines.length - 1]);
  const normalized = normalizeSession(parsed);
  return {
    session_id: normalized.session_id,
    agent_summary: normalized.agent_summary,
    effectiveness: normalized.effectiveness,
  };
}

// ---------------------------------------------------------------------------
// Shared resource snapshot (updated by peerCounter on every iteration)
// ---------------------------------------------------------------------------

/** @type {object|null} */
let cachedProbeSnapshot = null;

// ---------------------------------------------------------------------------
// DI seam implementations
// ---------------------------------------------------------------------------

/**
 * modeSelector — invoked before each iteration.
 * Signals are assembled once (surfacedLearnings surfaced before the loop),
 * but buildLiveSignals is called per-iteration to get fresh STATE.md / sessions.
 *
 * @returns {Promise<{mode: string, confidence: number, rationale?: string, alternatives?: object[]}>}
 */
async function modeSelector() {
  const signals = await buildLiveSignals({
    learnings: surfacedLearnings,
    backlogLimit: 50,
  });
  return selectMode(signals);
}

/**
 * sessionRunner — spawns `claude` with the recommended mode and awaits exit.
 * Verifies that a new sessions.jsonl record was appended before returning.
 *
 * @param {{mode: string, autopilotRunId: string}} args
 * @returns {Promise<{session_id: string, agent_summary?: object, effectiveness?: object}>}
 */
async function sessionRunner({ mode, autopilotRunId }) {
  const preCount = countSessionLines();

  await new Promise((res, rej) => {
    const childStdio = hasVerbose
      ? ['ignore', 'pipe', 'pipe']
      : ['ignore', 'inherit', 'inherit'];

    const child = spawn(
      'claude',
      ['-p', `/session ${mode}`],
      {
        env: { ...process.env, AUTOPILOT_RUN_ID: autopilotRunId },
        stdio: childStdio,
        cwd: process.cwd(),
      }
    );

    if (hasVerbose) {
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }

    child.on('error', (err) => rej(err));
    child.on('close', (code) => {
      if (code !== 0) {
        rej(new Error(`claude exit ${code}`));
      } else {
        res(undefined);
      }
    });
  });

  const postCount = countSessionLines();
  if (postCount === preCount) {
    throw new Error('no session record appended');
  }

  return readTailSession();
}

/**
 * resourceEvaluator — returns the latest cached probe verdict.
 * The cached snapshot is refreshed by peerCounter before each iteration.
 * Falls back to probing inline if the cache is null (first iteration safety).
 *
 * @returns {{verdict: string, reasons: string[], recommended_agents_per_wave_cap: number|null}}
 */
function resourceEvaluator() {
  if (cachedProbeSnapshot === null) {
    // Synchronous fallback is not possible since probe() is async.
    // Return a conservative 'warn' so the loop does not mis-gate on missing data.
    // The real snapshot will be available after peerCounter runs on the next call.
    return { verdict: 'warn', reasons: ['probe not yet available'], recommended_agents_per_wave_cap: null };
  }
  return evaluate(cachedProbeSnapshot, thresholds);
}

/**
 * peerCounter — refreshes the resource snapshot AND returns the peer count.
 * Using this combined approach lets resourceEvaluator remain synchronous as
 * required by the runLoop contract.
 *
 * @param {string} autopilotRunId — self-id to exclude from peer list.
 * @returns {Promise<number>}
 */
async function makePeerCounter(autopilotRunId) {
  return async () => {
    const [peers, snapshot] = await Promise.all([
      detectPeers({ sessionId: autopilotRunId, freshnessMin: 15 }),
      probe(),
    ]);
    cachedProbeSnapshot = snapshot;
    return peers.length;
  };
}

// ---------------------------------------------------------------------------
// AbortController for SIGINT
// ---------------------------------------------------------------------------

const controller = new AbortController();
process.on('SIGINT', () => {
  controller.abort();
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Build the autopilotRunId via runLoop's defaultRunId (driven by branch opt).
  // We don't construct it ourselves — runLoop builds it from branch + timestamp.
  // We need it for peerCounter BEFORE runLoop starts. So we replicate the
  // defaultRunId logic here to derive the same id. However, runLoop accepts
  // an explicit `runId` override, so we just pre-compute one and pass it in.
  const now = Date.now();
  function pad2(n) { return n < 10 ? `0${n}` : String(n); }
  const d = new Date(now);
  const ymd = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const hhmm = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  const safeBranch = (branch ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');
  const autopilotRunId = `${safeBranch}-${ymd}-${hhmm}-autopilot`;

  const peerCounter = await makePeerCounter(autopilotRunId);

  const state = await runLoop({
    maxSessions,
    maxHours,
    confidenceThreshold,
    dryRun,
    modeSelector,
    sessionRunner,
    resourceEvaluator,
    peerCounter,
    abortSignal: controller.signal,
    runId: autopilotRunId,
    branch: branch ?? undefined,
  });

  const sessionIds = state.sessions.join(', ') || '(none)';
  const summary =
    `${state.autopilot_run_id} ` +
    `kill_switch=${state.kill_switch ?? 'none'} ` +
    `iterations=${state.iterations_completed} ` +
    `sessions=[${sessionIds}] ` +
    `duration=${state.duration_seconds}s`;
  process.stdout.write(summary + '\n');

  if (state.kill_switch === KILL_SWITCHES.FAILED_WAVE) {
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`autopilot: fatal error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
