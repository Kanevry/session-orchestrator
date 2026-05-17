#!/usr/bin/env node
/**
 * ecosystem-health.mjs — Plugin-monitor watcher for ecosystem-health skill.
 *
 * Runs as a persistent background process for the lifetime of the session
 * (registered via .claude-plugin/plugin.json -> experimental.monitors path).
 * Each NDJSON line written to stdout becomes a `<task_notification>` event
 * Claude sees mid-session.
 *
 * Behaviour:
 *   - Watches .orchestrator/metrics/ecosystem-health.jsonl for state changes
 *     (line-count growth + last-line change detection).
 *   - If the state file does not exist yet, emits one `no-state-yet` event
 *     at startup and idles until it appears.
 *   - Coverage rule LM-002: stdout emits cover both progress AND failure
 *     cases. Errors during the watch loop are surfaced as `error` events,
 *     never silently swallowed (silence != success).
 *
 * Line-buffering contract:
 *   Every emit uses `process.stdout.write(line + '\n')` — one line per
 *   notification. Never console.log multi-line strings.
 *
 * Flags:
 *   --watch        Run the watcher loop (required; no other mode supported).
 *   --interval=N   Probe cadence in seconds (default 900 = 15min). Cron-style
 *                  pre-warming pattern: keep cadence below any cache-related TTLs.
 *   --help         Print usage to stderr and exit 0.
 *
 * Exit codes:
 *   0 — clean shutdown (SIGTERM/SIGINT received).
 *   1 — user/input error (unknown flag, --watch missing).
 *   2 — system error (unexpected failure outside the watch loop).
 *
 * @typedef {Object} EmitEvent
 * @property {string} event       Event name (lowercase.dot.case).
 * @property {string} ts          ISO-8601 timestamp.
 * @property {Record<string, unknown>} [details]  Optional structured payload.
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_INTERVAL_S = 15 * 60; // 15min
const STATE_FILE_REL = '.orchestrator/metrics/ecosystem-health.jsonl';

/**
 * Parse CLI args into a typed config object. No deps — node:util's parseArgs
 * is overkill for this surface and adds 2 lines of overhead per call.
 * @param {string[]} argv
 * @returns {{ watch: boolean, intervalS: number, help: boolean }}
 */
function parseArgs(argv) {
  let watch = false;
  let intervalS = DEFAULT_INTERVAL_S;
  let help = false;
  for (const arg of argv) {
    if (arg === '--watch') {
      watch = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--interval=')) {
      const v = Number(arg.slice('--interval='.length));
      if (!Number.isFinite(v) || v <= 0) {
        process.stderr.write(`ecosystem-health: invalid --interval value: ${arg}\n`);
        process.exit(1);
      }
      intervalS = v;
    } else {
      process.stderr.write(`ecosystem-health: unknown flag: ${arg}\n`);
      process.exit(1);
    }
  }
  return { watch, intervalS, help };
}

/**
 * Emit one NDJSON line to stdout (one notification = one line).
 * @param {EmitEvent} payload
 */
function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Read state-file fingerprint (size + last-line) for change detection.
 * @param {string} absPath
 * @returns {{ exists: boolean, size: number, mtimeMs: number, lastLine: string | null }}
 */
function fingerprint(absPath) {
  if (!existsSync(absPath)) {
    return { exists: false, size: 0, mtimeMs: 0, lastLine: null };
  }
  try {
    const st = statSync(absPath);
    // Tail read for last line — small file in practice (append-only JSONL).
    // Reading full file is acceptable here at 15-min cadence.
    let lastLine = null;
    if (st.size > 0) {
      const text = readFileSync(absPath, 'utf8');
      const trimmed = text.replace(/\n$/, '');
      const idx = trimmed.lastIndexOf('\n');
      lastLine = idx === -1 ? trimmed : trimmed.slice(idx + 1);
    }
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs, lastLine };
  } catch (err) {
    // Surface as an error event rather than silently returning a fake fingerprint.
    emit({
      event: 'error',
      ts: new Date().toISOString(),
      details: { phase: 'fingerprint', file: absPath, message: String(err?.message ?? err) },
    });
    return { exists: false, size: 0, mtimeMs: 0, lastLine: null };
  }
}

/**
 * Main watch loop. Runs until SIGTERM/SIGINT.
 * @param {number} intervalS
 */
async function watchLoop(intervalS) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
  const absPath = join(pluginRoot, STATE_FILE_REL);

  // Startup event — confirms the watcher is alive even when nothing has
  // happened yet. Without this, a "no events" stream is indistinguishable
  // from a crashed monitor.
  let prev = fingerprint(absPath);
  emit({
    event: prev.exists ? 'watcher.started' : 'no-state-yet',
    ts: new Date().toISOString(),
    details: { file: STATE_FILE_REL, intervalSeconds: intervalS, exists: prev.exists },
  });

  // Loop forever — the Claude harness sends SIGTERM on session-end and the
  // process exits 0 via the signal handlers below.
  while (true) {
    await sleep(intervalS * 1000);
    const next = fingerprint(absPath);
    if (!prev.exists && next.exists) {
      emit({
        event: 'state-file.appeared',
        ts: new Date().toISOString(),
        details: { file: STATE_FILE_REL, size: next.size },
      });
    } else if (prev.exists && !next.exists) {
      emit({
        event: 'state-file.disappeared',
        ts: new Date().toISOString(),
        details: { file: STATE_FILE_REL },
      });
    } else if (next.exists && (next.size !== prev.size || next.lastLine !== prev.lastLine)) {
      emit({
        event: 'state.changed',
        ts: new Date().toISOString(),
        details: {
          file: STATE_FILE_REL,
          sizeDelta: next.size - prev.size,
          lastLine: next.lastLine,
        },
      });
    }
    prev = next;
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(
      [
        'Usage: ecosystem-health.mjs --watch [--interval=<seconds>]',
        '',
        'Plugin-monitor watcher for the ecosystem-health skill. Persistent',
        'background process; one NDJSON line per state change → stdout.',
        '',
        'Flags:',
        '  --watch              Required. Run the watch loop.',
        '  --interval=<s>       Probe cadence in seconds (default 900).',
        '  --help, -h           Print this message.',
        '',
        'Exit codes: 0 clean / 1 user-error / 2 system-error.',
      ].join('\n') + '\n',
    );
    process.exit(0);
  }
  if (!args.watch) {
    process.stderr.write('ecosystem-health: --watch is required\n');
    process.exit(1);
  }

  // Graceful shutdown — Claude harness sends SIGTERM at session-end.
  const shutdown = (sig) => {
    emit({
      event: 'watcher.shutdown',
      ts: new Date().toISOString(),
      details: { signal: sig },
    });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  watchLoop(args.intervalS).catch((err) => {
    emit({
      event: 'error',
      ts: new Date().toISOString(),
      details: { phase: 'watchLoop', message: String(err?.message ?? err) },
    });
    process.exit(2);
  });
}

main();
