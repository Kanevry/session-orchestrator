/**
 * orphan-reaper/trigger.mjs — the B4 trigger both hooks call (#1432 B4).
 *
 * `hooks/on-stop.mjs` (Stop + SubagentStop) and
 * `hooks/post-tool-batch-wave-signal.mjs` (PostToolBatch) are the two trigger
 * points the PRD declares. Until 2026-10-02 each carried its own verbatim copy
 * of this code (138 identical lines, one comment apart, measured by diffing the
 * blocks); the copies are now this one module (#1489).
 *
 * Its own file rather than part of `scan-throttle.mjs`, for two closures:
 *  - `scan-throttle.mjs` is re-exported by the detached scan CLI
 *    (`scripts/lib/orphan-reaper.mjs`); putting the trigger there would load the
 *    config parser and `platform.mjs` into every scan child for nothing.
 *  - The throttle stays a LAZY import below, so a host with the reaper disabled
 *    (the default) pays for one config read and no throttle module at all.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { _parseReaper } from '../config/reaper.mjs';
import { getProjectDir } from '../platform.mjs';

/**
 * Filesystem path of the scan CLI, spawned as a PLAIN argv call.
 *
 * It used to be a `file://` URL handed to `node --input-type=module -e
 * <program>`, because `scripts/lib/orphan-reaper.mjs` had no entry guard. It
 * has one now (`parseReaperCliArgs` + the `isMainModule` tail), so the child's
 * contract lives in that module instead of as source text duplicated here —
 * and nothing this trigger builds is a program any more: every variable part is
 * an argv value, which cannot become code whatever the checkout path contains.
 *
 * `fileURLToPath`, not `new URL(...).pathname`: the latter leaves a
 * percent-encoded path for any checkout directory containing a space.
 */
const ORPHAN_REAPER_SCRIPT = fileURLToPath(new URL('../orphan-reaper.mjs', import.meta.url));

/**
 * Read the `reaper:` block from the project's Session Config host file.
 * Sync + inline, mirroring `hooks/loop-guard.mjs` `loadConfig()` — a hot hook
 * path must not import the full config orchestrator. A missing or unreadable
 * file yields the parser defaults, i.e. DISABLED.
 *
 * @param {string} projectDir
 * @returns {ReturnType<typeof _parseReaper>}
 */
function loadReaperConfig(projectDir) {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      return _parseReaper(readFileSync(path.join(projectDir, name), 'utf8'));
    } catch {
      // missing or unreadable — try the next candidate
    }
  }
  return _parseReaper('');
}

/**
 * Trigger the orphan scan, throttled and NON-BLOCKING (PRD FA4).
 *
 * The hook itself does exactly two pieces of I/O — one config read and one
 * `stat` of the throttle marker — and then hands the work to a DETACHED,
 * unref'd child. The scan is never run inline: one `ps` round-trip out of Node
 * was measured at ~47 ms over 287 KB of output, which alone would blow the
 * 50 ms `reaper.max-hook-latency-ms` budget this hook has to stay inside.
 *
 * The marker is stamped BEFORE the spawn, so a spawn that fails still consumes
 * the throttle window — otherwise a broken spawn would be retried on every
 * single tool batch.
 *
 * `reaper.max-hook-latency-ms` is the ceiling on the work above — measured here
 * with `performance.now()` and reported as ONE stderr WARN line when exceeded.
 * A WARN and not an event: this fires from a `PostToolBatch`-class hook, and a
 * per-fire telemetry record is exactly the always-on signal
 * `.claude/rules/host-resources.md` HR-101 calls a broken instrument. The
 * measurement covers preparation only — the scan itself runs detached, which is
 * the whole reason the budget can be held.
 *
 * Never throws: any failure degrades silently (PRD FA4 "lautlos degradieren").
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir]  Repo root; defaults to `getProjectDir()`.
 * @param {number} [opts.now]         Injected clock (ms).
 * @param {Function} [opts.spawnFn]   Injected `spawn` (tests).
 * @param {Function} [opts.statFn]    Injected marker `lstatSync` (tests).
 * @param {Function} [opts.writeFn]   Injected marker writer (tests).
 * @param {() => number} [opts.clockFn]  Injected monotonic clock for the latency
 *   budget (tests); defaults to `performance.now`.
 * @returns {Promise<{spawned: boolean, reason: string}>} `reason` is one of
 *   `'disabled' | 'throttled' | 'spawned' | 'spawned-unthrottled' | 'error'`.
 *   `'spawned-unthrottled'` means the scan ran but the marker could not be
 *   stamped — the next fire will scan again, and the result must not read like
 *   a throttled spawn. `hooks/on-stop.mjs` records `reason` as `reaper_trigger`
 *   on its per-turn and per-agent records (HR-105: a signal nothing records is
 *   unfalsifiable); the PostToolBatch hook does not, because the marker is one
 *   file per repo — a defeated marker shows on the very next Stop record, and a
 *   per-batch record is the HR-101 shape the WARN above already refuses.
 */
export async function maybeTriggerOrphanScan({
  projectDir,
  now,
  spawnFn = spawn,
  statFn,
  writeFn,
  clockFn = () => performance.now(),
} = {}) {
  const startedAt = clockFn();
  /** One WARN line when the preparation overran `reaper.max-hook-latency-ms`. */
  const checkLatency = (budgetMs) => {
    const elapsed = clockFn() - startedAt;
    if (Number.isFinite(budgetMs) && budgetMs > 0 && elapsed > budgetMs) {
      process.stderr.write(
        `orphan-reaper trigger: hook latency ${elapsed.toFixed(1)} ms exceeded `
        + `reaper.max-hook-latency-ms (${budgetMs} ms)\n`,
      );
    }
  };
  let root;
  try {
    root = typeof projectDir === 'string' && projectDir ? projectDir : getProjectDir();
  } catch {
    // No project dir, no config to read (#1498): `process.cwd()` throws ENOENT
    // when the hook starts in a deleted directory with no `*_PROJECT_DIR` set.
    // That is an unreadable config — the parser defaults, DISABLED — and not a
    // failure of an armed reaper, so it must not surface as `error`: on-stop
    // stamps `reaper_trigger` only for a reaper that is enabled.
    return { spawned: false, reason: 'disabled' };
  }
  try {
    const cfg = loadReaperConfig(root);
    // Cheapest gate first: disabled means no stat, no spawn, no module load.
    if (cfg.enabled !== true) return { spawned: false, reason: 'disabled' };

    // The throttle module only — the scan's ledger, `ps` and kill-ladder code
    // load in the detached child, never on this hook path (#1437).
    const reaper = await import('./scan-throttle.mjs');
    const markerPath = reaper.scanMarkerPath(root);
    const nowMs = typeof now === 'number' ? now : Date.now();

    if (!reaper.shouldScanNow(markerPath, nowMs, cfg['min-scan-interval-seconds'], { statFn })) {
      checkLatency(cfg['max-hook-latency-ms']);
      return { spawned: false, reason: 'throttled' };
    }
    // An unwritable marker does not cancel the scan — the throttle fails toward
    // scanning (see shouldScanNow) — but the result says the throttle is off.
    // No output: this runs on every hook fire (each tool batch, each Stop) in
    // every session on the host.
    const stamped = reaper.touchScanMarker(markerPath, { writeFn });

    const child = spawnFn(
      process.execPath,
      [
        ORPHAN_REAPER_SCRIPT,
        '--repo-root', root,
        '--mode', cfg.mode,
        '--min-age-seconds', String(cfg['min-age-seconds']),
        '--kill-grace-ms', String(cfg['kill-grace-ms']),
        '--verify-wait-ms', String(cfg['verify-wait-ms']),
        '--false-alarm-window', String(cfg['false-alarm-window']),
      ],
      { detached: true, stdio: 'ignore' },
    );
    if (child && typeof child.unref === 'function') child.unref();
    checkLatency(cfg['max-hook-latency-ms']);
    return { spawned: true, reason: stamped ? 'spawned' : 'spawned-unthrottled' };
  } catch {
    return { spawned: false, reason: 'error' };
  }
}
