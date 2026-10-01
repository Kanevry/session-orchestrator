/**
 * orphan-reaper/scan-throttle.mjs — the B4 throttle the two trigger hooks call.
 *
 * This is the reaper's only hot-path surface: `hooks/on-stop.mjs` and
 * `hooks/post-tool-batch-wave-signal.mjs` import THIS module, not the scan, so a
 * tool batch pays for one `stat` and two tiny modules — never for the ledger,
 * `ps` or kill-ladder code the detached scan child loads.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { REAPER_DEFAULTS, underRepo } from './defaults.mjs';

/** Relative path of the scan-throttle marker (B4). Gitignored via
 *  `.gitignore:141` (`.orchestrator/tmp/`). */
export const SCAN_MARKER_RELPATH = '.orchestrator/tmp/reaper-last-scan';

/**
 * Throttle gate (B4): may a scan run now?
 *
 * Reads the marker's mtime; a missing or unreadable marker means "yes" — the
 * first scan of a host must not be blocked by the absence of its own throttle
 * file. Writing the marker is the CALLER's job ({@link touchScanMarker}), so
 * this stays a read-only predicate a hook can call cheaply.
 *
 * @param {string} markerPath   Absolute path — build it with {@link scanMarkerPath}.
 * @param {number} nowMs
 * @param {number} [minIntervalSeconds]
 * @param {object} [opts]
 * @param {(p: string) => {mtimeMs: number}} [opts.statFn]
 * @returns {boolean}
 */
export function shouldScanNow(markerPath, nowMs, minIntervalSeconds = REAPER_DEFAULTS.minScanIntervalSeconds, {
  statFn = statSync,
} = {}) {
  if (typeof markerPath !== 'string' || markerPath.length === 0) return false;
  let mtimeMs;
  try {
    mtimeMs = statFn(markerPath)?.mtimeMs;
  } catch {
    return true; // no marker yet → first scan
  }
  if (typeof mtimeMs !== 'number' || Number.isNaN(mtimeMs)) return true;
  return (nowMs - mtimeMs) >= minIntervalSeconds * 1000;
}

/**
 * Stamp the throttle marker. Best-effort and never throws — a marker that could
 * not be written means the next scan runs, which is the safe direction for a
 * read-only probe.
 *
 * @param {string} markerPath
 * @param {object} [opts]
 * @param {(p: string, data: string) => void} [opts.writeFn]
 * @returns {boolean} whether the marker was written
 */
export function touchScanMarker(markerPath, { writeFn } = {}) {
  try {
    if (writeFn) {
      writeFn(markerPath, `${new Date().toISOString()}\n`);
      return true;
    }
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the throttle marker for a repo. One constant per path.
 *  @param {string} repoRoot @returns {string} */
export function scanMarkerPath(repoRoot) {
  return underRepo(repoRoot, SCAN_MARKER_RELPATH);
}
