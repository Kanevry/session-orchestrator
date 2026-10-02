/**
 * orphan-reaper/scan-throttle.mjs — the B4 throttle the trigger calls.
 *
 * Together with `trigger.mjs` this is the reaper's only hot-path surface:
 * `hooks/on-stop.mjs` and `hooks/post-tool-batch-wave-signal.mjs` reach THIS
 * module (lazily, via `trigger.mjs`), not the scan, so a tool batch pays for one
 * `stat` and a few tiny modules — never for the ledger, `ps` or kill-ladder code
 * the detached scan child loads.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * `lstat`, never `stat`: a symlinked (or otherwise non-regular) marker is not
 * one {@link touchScanMarker} wrote, and `stat` read the TARGET's mtime — so a
 * link to any often-written file (`events.jsonl`) throttled every scan for good
 * (#1487). Such a marker counts as absent, i.e. "scan" — and that scan's stamp
 * replaces a link with a regular marker, so the next fire throttles again
 * ({@link touchScanMarker}). Counting it as absent is the fail-safe
 * direction for this throttle: too many scans cost one detached child per hook
 * fire — visible in the process table, and in the `scan_completed` rate
 * whenever a scan finds anything — in an opt-in state (`reaper.enabled`
 * defaults false); too few silently disable the reaper, whose
 * orphans were measured at 86-588 % CPU and up to 8 GB RSS (HR-107), and a
 * disabled reaper is a state nothing can falsify (HR-105).
 *
 * @param {string} markerPath   Absolute path — build it with {@link scanMarkerPath}.
 * @param {number} nowMs
 * @param {number} [minIntervalSeconds]
 * @param {object} [opts]
 * @param {(p: string) => {mtimeMs: number, isFile?: () => boolean}} [opts.statFn]
 *   Defaults to `lstatSync`; an injected stat without `isFile` skips the
 *   regular-file check (test seam).
 * @returns {boolean}
 */
export function shouldScanNow(markerPath, nowMs, minIntervalSeconds = REAPER_DEFAULTS.minScanIntervalSeconds, {
  statFn = lstatSync,
} = {}) {
  if (typeof markerPath !== 'string' || markerPath.length === 0) return false;
  let stats;
  try {
    stats = statFn(markerPath);
  } catch {
    return true; // no marker yet → first scan
  }
  if (typeof stats?.isFile === 'function' && !stats.isFile()) return true;
  const mtimeMs = stats?.mtimeMs;
  if (typeof mtimeMs !== 'number' || Number.isNaN(mtimeMs)) return true;
  // A marker stamped in the future (`touch -t`, a clock stepped backwards) made
  // the age negative, so every fire read "too soon" — and the marker is only
  // re-stamped AFTER a scan, so the reaper never scanned again (#1487). Fail
  // toward a scan, the same direction as every other unreadable marker here.
  if (mtimeMs > nowMs) return true;
  return (nowMs - mtimeMs) >= minIntervalSeconds * 1000;
}

/**
 * Stamp the throttle marker. Best-effort and never throws — a marker that could
 * not be written means the next scan runs, which is the safe direction for a
 * read-only probe (the reasoning is on {@link shouldScanNow}). Callers must not
 * read a `false` as a stamped throttle: `maybeTriggerOrphanScan`
 * (`trigger.mjs`) returns it as `reason: 'spawned-unthrottled'`, and
 * `hooks/on-stop.mjs` records that reason as `reaper_trigger` on its
 * Stop/SubagentStop records — so an unwritable marker is countable in
 * events.jsonl, not only visible as one detached scan child per hook fire.
 *
 * Written to a sibling tmp file, then renamed over the marker path. A rename
 * replaces the directory ENTRY and never follows a symlink sitting there, so a
 * planted or accidental link is healed by the next stamp — not written through
 * (CWE-59: `writeFileSync` on the marker replaced the link's target), and not
 * refused either: refusing it returned `false` on every fire, which switched the
 * throttle off for good (#1489 Pkt 9). With no lstat-then-write step there is no
 * check-to-use window left. The tmp name carries pid + random bytes and is
 * opened `wx` (O_EXCL), so anything already at that name fails the stamp
 * instead of being written through; a tmp this call created is removed again
 * when the rename fails, or every failed fire would leave one behind.
 *
 * A DIRECTORY at the marker path is the one shape that stays unhealed: a rename
 * cannot replace it (EISDIR), and removing it would delete content this module
 * never wrote. It stays `false`. Silent, like every other failure here — this
 * runs inside a 50 ms hook budget.
 * Named ceiling (BV-004): the PARENT path is resolved normally, so a symlinked
 * `.orchestrator/tmp/` puts the marker into the link's target directory, where
 * it can replace only an entry of its own name. Acceptable for a gitignored
 * throttle stamp; revisit if the marker ever carries data.
 *
 * @param {string} markerPath
 * @param {object} [opts]
 * @param {(p: string, data: string) => void} [opts.writeFn]
 * @returns {boolean} whether the marker was written
 */
export function touchScanMarker(markerPath, { writeFn } = {}) {
  try {
    const stamp = `${new Date().toISOString()}\n`;
    if (writeFn) {
      writeFn(markerPath, stamp);
      return true;
    }
    mkdirSync(path.dirname(markerPath), { recursive: true });
    const tmp = `${markerPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, stamp, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      // EEXIST: the `wx` open was refused, so the entry at `tmp` is not ours.
      if (err?.code !== 'EEXIST') removeOwnTmp(tmp);
      return false;
    }
    try {
      renameSync(tmp, markerPath);
      return true;
    } catch {
      removeOwnTmp(tmp);
      return false;
    }
  } catch {
    return false;
  }
}

/** Best-effort removal of a tmp file {@link touchScanMarker} created. @param {string} tmp */
function removeOwnTmp(tmp) {
  try { unlinkSync(tmp); } catch { /* never created, or already gone */ }
}

/** Absolute path of the throttle marker for a repo. One constant per path.
 *  @param {string} repoRoot @returns {string} */
export function scanMarkerPath(repoRoot) {
  return underRepo(repoRoot, SCAN_MARKER_RELPATH);
}
