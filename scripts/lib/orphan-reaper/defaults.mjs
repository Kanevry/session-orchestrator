/**
 * orphan-reaper/defaults.mjs — the reaper's parameter table and its repo-path join.
 *
 * Imports nothing but `node:path` on purpose: the trigger hooks reach it through
 * `scan-throttle.mjs` on a hot path whose import closure is measured (#1432), and
 * every other reaper module shares these numbers instead of re-spelling them.
 */

import path from 'node:path';

/**
 * Stufe-1 parameters. Every number carries its provenance from the PRD
 * parameter table (`docs/prd/2026-09-20-prozessgruppen-kill-und-waisen-waechter.md`
 * § 4) — NOT calibrated, so the provenance is what makes a later re-measurement
 * possible ("keine Zahl ohne ihre Population").
 */
export const REAPER_DEFAULTS = Object.freeze({
  /** `reaper.min-age-seconds`: DevWatchdogs' hard limit for `tsgo`; the
   *  2026-09-20 orphans were 7-17 min old, comfortably above it. */
  minAgeSeconds: 300,
  /** `reaper.min-scan-interval-seconds`: DevWatchdogs' normal scan cadence —
   *  keeps a `PostToolBatch` storm from taxing every tool call. */
  minScanIntervalSeconds: 30,
  /** `reaper.kill-grace-ms`: `DEFAULT_KILL_GRACE_MS` from `process-group.mjs` —
   *  a repo convention, not a new number. A literal rather than an import so this
   *  module stays out of `process-group.mjs`'s closure. */
  killGraceMs: 10_000,
  /** `reaper.verify-wait-ms`: without it the 2026-09-20 hand-run cleanup
   *  reported "still alive" for processes that were already gone. */
  verifyWaitMs: 500,
  /** `reaper.max-hook-latency-ms`: ceiling a scan may delay a hook by. */
  maxHookLatencyMs: 50,
  /** `reaper.false-alarm-window`: last N audit decisions — a ROLLING window
   *  rather than calendar time, so a quiet host still has a population (HR-101). */
  falseAlarmWindow: 50,
});

/** @param {string} repoRoot @param {string} relpath @returns {string} */
export function underRepo(repoRoot, relpath) {
  return path.join(repoRoot, ...relpath.split('/'));
}
