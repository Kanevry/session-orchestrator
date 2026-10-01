/**
 * orphan-reaper/scan-throttle.mjs — the B4 throttle the two trigger hooks call.
 *
 * This is the reaper's only hot-path surface: `hooks/on-stop.mjs` and
 * `hooks/post-tool-batch-wave-signal.mjs` import THIS module, not the scan, so a
 * tool batch pays for one `stat` and two tiny modules — never for the ledger,
 * `ps` or kill-ladder code the detached scan child loads.
 */

import { lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
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
 * A marker path that is a symlink or not a regular file is left alone and
 * reported as not written: `writeFileSync` follows a link, so a marker linked to
 * any file would overwrite that file on every hook (CWE-59). Silent, like every
 * other failure here — this runs inside a 50 ms hook budget.
 * Named ceiling (BV-004): lstat-then-write leaves a check-to-use window of one
 * syscall; a link planted inside it is still written through. Acceptable for a
 * gitignored throttle stamp; revisit (O_NOFOLLOW open) if the marker ever
 * carries data.
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
    let existing = null;
    try {
      existing = lstatSync(markerPath);
    } catch {
      /* no marker yet — the first stamp creates it */
    }
    if (existing && !existing.isFile()) return false;
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
