#!/usr/bin/env node
/**
 * convergence-monitor.mjs — Plugin-monitor watcher for convergence-monitoring skill.
 *
 * Tails .orchestrator/metrics/events.jsonl (append-only NDJSON) and surfaces
 * convergence-relevant signals as task notifications. Registered via
 * .claude-plugin/plugin.json -> experimental.monitors (when=on-skill-invoke:wave-executor).
 *
 * Signals emitted (one per qualifying event class):
 *   - shrinking_diff      — files-changed per wave decreasing across 2+ waves.
 *   - pass_rate_plateau   — test pass count unchanged across 2+ waves.
 *   - velocity_drop       — agent dispatch count decreasing across 2+ waves.
 *
 * Behaviour:
 *   - Polls the file at a cheap cadence (default 2s) — events.jsonl is
 *     append-only so we only need to read newly-appended bytes via offset.
 *     fs.watch is unreliable cross-platform for append-only files; polling
 *     is the documented, robust pattern.
 *   - If events.jsonl does not exist yet, emits one `no-events-yet` event
 *     at startup and idles (still polling) until it appears.
 *   - Coverage rule LM-002: stdout emits cover progress AND failure cases.
 *     Errors during the tail loop are surfaced as `error` events.
 *
 * Line-buffering contract:
 *   Every emit uses `process.stdout.write(line + '\n')` — one line per
 *   notification. Never console.log multi-line strings.
 *
 * Flags:
 *   --tail         Run the tail loop (required; no other mode supported).
 *   --interval=N   Poll cadence in seconds (default 2).
 *   --help, -h     Print usage to stderr and exit 0.
 *
 * Exit codes:
 *   0 — clean shutdown (SIGTERM/SIGINT).
 *   1 — user/input error (unknown flag, --tail missing).
 *   2 — system error.
 *
 * @typedef {Object} WaveSummary
 * @property {number} waveNumber
 * @property {number | null} filesChanged
 * @property {number | null} testPassed
 * @property {number | null} agentDispatchCount
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_INTERVAL_S = 2;
const EVENTS_FILE_REL = '.orchestrator/metrics/events.jsonl';

/**
 * @param {string[]} argv
 * @returns {{ tail: boolean, intervalS: number, help: boolean }}
 */
function parseArgs(argv) {
  let tail = false;
  let intervalS = DEFAULT_INTERVAL_S;
  let help = false;
  for (const arg of argv) {
    if (arg === '--tail') {
      tail = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--interval=')) {
      const v = Number(arg.slice('--interval='.length));
      if (!Number.isFinite(v) || v <= 0) {
        process.stderr.write(`convergence-monitor: invalid --interval value: ${arg}\n`);
        process.exit(1);
      }
      intervalS = v;
    } else {
      process.stderr.write(`convergence-monitor: unknown flag: ${arg}\n`);
      process.exit(1);
    }
  }
  return { tail, intervalS, help };
}

/**
 * Emit one NDJSON line to stdout.
 * @param {{event: string, ts: string, details?: Record<string, unknown>}} payload
 */
function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Read newly-appended bytes from a file given a previous offset. Returns
 * the new offset and a list of complete lines (drops partial trailing line
 * if any — it will be picked up on the next tick).
 *
 * @param {string} absPath
 * @param {number} prevOffset
 * @returns {{ offset: number, lines: string[], existed: boolean }}
 */
function tailRead(absPath, prevOffset) {
  if (!existsSync(absPath)) {
    return { offset: 0, lines: [], existed: false };
  }
  let fd = -1;
  try {
    const st = statSync(absPath);
    // File truncated or rotated — reset to start.
    const start = st.size < prevOffset ? 0 : prevOffset;
    const toRead = st.size - start;
    if (toRead <= 0) return { offset: st.size, lines: [], existed: true };

    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(toRead);
    readSync(fd, buf, 0, toRead, start);
    const text = buf.toString('utf8');
    // If the last byte is not a newline, the final line is incomplete —
    // drop it and rewind the offset so we re-read it next tick.
    let newOffset = st.size;
    let workingText = text;
    if (!text.endsWith('\n')) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) {
        // No complete lines at all — wait for more data.
        return { offset: start, lines: [], existed: true };
      }
      workingText = text.slice(0, lastNl + 1);
      newOffset = start + Buffer.byteLength(workingText, 'utf8');
    }
    const lines = workingText.split('\n').filter((l) => l.length > 0);
    return { offset: newOffset, lines, existed: true };
  } catch (err) {
    emit({
      event: 'error',
      ts: new Date().toISOString(),
      details: { phase: 'tailRead', file: absPath, message: String(err?.message ?? err) },
    });
    return { offset: prevOffset, lines: [], existed: existsSync(absPath) };
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* ignore close failures */ }
    }
  }
}

/**
 * Classify a raw events.jsonl record and update the in-memory wave summary
 * map. Returns the wave number affected, or null if the record is not a
 * wave-event we care about.
 *
 * Heuristics — the events.jsonl schema in this repo is loose; we read what
 * we can find and ignore the rest. Recognised fields per record:
 *   - { event_type, wave, wave_number, files_changed, test.passed,
 *       agent.dispatched, agents_dispatched }
 *
 * @param {Record<string, unknown>} rec
 * @param {Map<number, WaveSummary>} state
 * @returns {number | null}
 */
function classify(rec, state) {
  const waveNumber = pickInt(rec.wave_number ?? rec.wave ?? rec.waveId);
  if (waveNumber === null) return null;
  let summary = state.get(waveNumber);
  if (!summary) {
    summary = {
      waveNumber,
      filesChanged: null,
      testPassed: null,
      agentDispatchCount: null,
    };
    state.set(waveNumber, summary);
  }
  const filesChanged = pickInt(rec.files_changed ?? rec.filesChanged);
  if (filesChanged !== null) summary.filesChanged = filesChanged;
  const testPassed = pickInt(rec['test.passed'] ?? rec.test_passed ?? rec.testsPassed);
  if (testPassed !== null) summary.testPassed = testPassed;
  // Count one agent.dispatched event toward this wave's dispatch count.
  const evType = String(rec.event_type ?? rec.event ?? '');
  if (evType === 'agent.dispatched') {
    summary.agentDispatchCount = (summary.agentDispatchCount ?? 0) + 1;
  } else {
    const dispatched = pickInt(rec.agents_dispatched ?? rec.agentsDispatched);
    if (dispatched !== null) summary.agentDispatchCount = dispatched;
  }
  return waveNumber;
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function pickInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Math.trunc(Number(v));
  }
  return null;
}

/**
 * Inspect the rolling wave-summary state and emit convergence signals for
 * the latest wave when the relevant trend is detected. We emit each signal
 * at most once per wave-pair to avoid duplicate notifications on every tick.
 *
 * @param {Map<number, WaveSummary>} state
 * @param {Set<string>} alreadyEmitted
 * @param {number} latestWave
 */
function evaluateSignals(state, alreadyEmitted, latestWave) {
  const prev = state.get(latestWave - 1);
  const curr = state.get(latestWave);
  if (!prev || !curr) return;

  // shrinking_diff — fewer files changed than prior wave.
  if (
    prev.filesChanged !== null &&
    curr.filesChanged !== null &&
    curr.filesChanged < prev.filesChanged
  ) {
    const key = `shrinking_diff:${latestWave}`;
    if (!alreadyEmitted.has(key)) {
      alreadyEmitted.add(key);
      emit({
        event: 'shrinking_diff',
        ts: new Date().toISOString(),
        details: {
          wave: latestWave,
          previousFilesChanged: prev.filesChanged,
          currentFilesChanged: curr.filesChanged,
          delta: curr.filesChanged - prev.filesChanged,
        },
      });
    }
  }

  // pass_rate_plateau — identical pass count across consecutive waves.
  if (
    prev.testPassed !== null &&
    curr.testPassed !== null &&
    prev.testPassed === curr.testPassed
  ) {
    const key = `pass_rate_plateau:${latestWave}`;
    if (!alreadyEmitted.has(key)) {
      alreadyEmitted.add(key);
      emit({
        event: 'pass_rate_plateau',
        ts: new Date().toISOString(),
        details: {
          wave: latestWave,
          testPassed: curr.testPassed,
        },
      });
    }
  }

  // velocity_drop — fewer agents dispatched than prior wave.
  if (
    prev.agentDispatchCount !== null &&
    curr.agentDispatchCount !== null &&
    curr.agentDispatchCount < prev.agentDispatchCount
  ) {
    const key = `velocity_drop:${latestWave}`;
    if (!alreadyEmitted.has(key)) {
      alreadyEmitted.add(key);
      emit({
        event: 'velocity_drop',
        ts: new Date().toISOString(),
        details: {
          wave: latestWave,
          previousAgents: prev.agentDispatchCount,
          currentAgents: curr.agentDispatchCount,
          delta: curr.agentDispatchCount - prev.agentDispatchCount,
        },
      });
    }
  }
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Main tail loop.
 * @param {number} intervalS
 */
async function tailLoop(intervalS) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
  const absPath = join(pluginRoot, EVENTS_FILE_REL);
  /** @type {Map<number, WaveSummary>} */
  const state = new Map();
  /** @type {Set<string>} */
  const emitted = new Set();
  let offset = 0;
  let everSawFile = existsSync(absPath);

  emit({
    event: everSawFile ? 'tail.started' : 'no-events-yet',
    ts: new Date().toISOString(),
    details: { file: EVENTS_FILE_REL, intervalSeconds: intervalS, exists: everSawFile },
  });

  while (true) {
    await sleep(intervalS * 1000);
    const tick = tailRead(absPath, offset);
    if (tick.existed && !everSawFile) {
      everSawFile = true;
      emit({
        event: 'events-file.appeared',
        ts: new Date().toISOString(),
        details: { file: EVENTS_FILE_REL },
      });
    }
    if (tick.lines.length === 0) {
      offset = tick.offset;
      continue;
    }
    offset = tick.offset;
    let latestWave = -1;
    for (const line of tick.lines) {
      /** @type {Record<string, unknown> | null} */
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        // Malformed line — skip silently (events.jsonl shouldn't contain
        // garbage, but we don't want a corrupt write to crash the watcher).
        continue;
      }
      if (rec && typeof rec === 'object') {
        const w = classify(rec, state);
        if (w !== null && w > latestWave) latestWave = w;
      }
    }
    if (latestWave > 0) evaluateSignals(state, emitted, latestWave);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(
      [
        'Usage: convergence-monitor.mjs --tail [--interval=<seconds>]',
        '',
        'Plugin-monitor watcher for the convergence-monitoring skill. Tails',
        '.orchestrator/metrics/events.jsonl and emits convergence signals as',
        'NDJSON lines on stdout.',
        '',
        'Signals: shrinking_diff, pass_rate_plateau, velocity_drop.',
        '',
        'Flags:',
        '  --tail               Required. Run the tail loop.',
        '  --interval=<s>       Poll cadence in seconds (default 2).',
        '  --help, -h           Print this message.',
        '',
        'Exit codes: 0 clean / 1 user-error / 2 system-error.',
      ].join('\n') + '\n',
    );
    process.exit(0);
  }
  if (!args.tail) {
    process.stderr.write('convergence-monitor: --tail is required\n');
    process.exit(1);
  }

  const shutdown = (sig) => {
    emit({
      event: 'tail.shutdown',
      ts: new Date().toISOString(),
      details: { signal: sig },
    });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  tailLoop(args.intervalS).catch((err) => {
    emit({
      event: 'error',
      ts: new Date().toISOString(),
      details: { phase: 'tailLoop', message: String(err?.message ?? err) },
    });
    process.exit(2);
  });
}

main();
