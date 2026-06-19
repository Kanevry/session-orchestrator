/**
 * autopilot/recent-runs.mjs — pure, no-throw reader for the per-repo
 * autopilot.jsonl run history (Epic #673 P3, issue #682 verdict-gated launch).
 *
 * `readRecentAutopilotRuns({ repoRoot, limit })` reads
 * `<repoRoot>/.orchestrator/metrics/autopilot.jsonl`, parses each JSONL line
 * (tolerating corrupt/partial lines), and returns the most-recent `limit`
 * records. The ONLY consumer is the dispatcher launch-gate (#682): it feeds the
 * returned array into `computeSuitabilityVerdict({ recentRuns })`
 * (scripts/lib/autonomy/suitability.mjs) whose G2 kill-switch gate counts the
 * records and reads each record's `kill_switch` field.
 *
 * CONTRACT (mirrors the never-throws + tolerant-parse idioms in
 * scripts/lib/autopilot/telemetry.mjs and the trailing-line skip in
 * scripts/lib/dispatcher/rank.mjs `defaultStaleDaysFor`):
 *   - PURE READ, NEVER throws — a missing file, an unreadable file, or a
 *     wholly-unparseable file all return `[]`. Telemetry/launch-gate failures
 *     must never crash the dispatcher.
 *   - TRUE COUNT preserved: when ≥ `KILL_SWITCH_MIN_RUNS` (5) valid records
 *     exist on disk, the reader returns the true tail count — it does NOT
 *     pre-truncate below 5. (NICE-a: pre-truncating would falsely trigger the
 *     engine's <5-run omission branch and skip the kill-switch gate.) The
 *     `limit` argument is an UPPER BOUND for very large files (default 50) — it
 *     caps the tail to keep parse work bounded, it is never a floor. Callers
 *     MUST NOT pass `limit < 5` for the launch-gate read: a `limit` below the
 *     engine's 5-run floor would silently mask a real ≥5-run history and force
 *     the G2 kill-switch gate into its omission branch — exactly the NICE-a
 *     failure mode. The default 50 is comfortably above the floor; leave it
 *     alone for the verdict path. (A `limit < 5` is still honoured as a literal
 *     cap — the reader does not clamp it upward — so the discipline is on the
 *     caller, documented here so it is not "fixed" by silently raising it.)
 *   - INTEGRITY (NICE-a): `autopilot.jsonl` is NOT subject to size-based
 *     events-rotation. `scripts/lib/events-rotation.mjs` (`maybeRotate`) targets
 *     `events.jsonl` ONLY — the session-start hook passes that single `logPath`;
 *     the rotation module contains zero references to `autopilot.jsonl`. So the
 *     autopilot run history this reader sees is never truncated/shifted out from
 *     under the launch gate by rotation: the on-disk tail IS the true history
 *     (only `autopilot.mjs` itself appends to it; see `skills/autopilot/SKILL.md`
 *     / `AGENTS.md` § Telemetry — sole-writer rule).
 *   - Ordering is NEWEST-LAST (chronological / file order): the returned array
 *     is a tail slice of the file, preserving on-disk append order. The engine
 *     only COUNTS records and reads `kill_switch`; order does not affect G2.
 *   - Corrupt lines are SKIPPED (not fatal): one malformed JSON line does not
 *     discard the rest of the history.
 *
 * No imports beyond node builtins. ESM. eslint-clean (eqeqeq, no-throw).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Canonical per-repo autopilot telemetry path (relative to repoRoot). */
const AUTOPILOT_JSONL_RELPATH = path.join('.orchestrator', 'metrics', 'autopilot.jsonl');

/** Default tail window — generous; the engine's G2 floor is only 5 runs. */
const DEFAULT_LIMIT = 50;

/**
 * Read the most-recent autopilot run records for a repo. Never throws.
 *
 * @param {{ repoRoot?: string, limit?: number }} [opts]
 * @param {string} [opts.repoRoot]  Repo whose `.orchestrator/metrics/autopilot.jsonl`
 *                                  to read. Falsy/non-string ⇒ `[]`.
 * @param {number} [opts.limit=50]  UPPER BOUND on records returned (the newest
 *                                  `limit`). Non-finite / ≤ 0 ⇒ falls back to the
 *                                  default 50. NICE-a discipline: never pass
 *                                  `limit < 5` on the launch-gate read — a value
 *                                  below the engine's 5-run kill-switch floor
 *                                  masks a real ≥5-run history and forces G2's
 *                                  omission branch. The reader honours a small
 *                                  `limit` literally (it does NOT clamp upward);
 *                                  keeping it ≥ 5 (default 50) is the caller's job.
 * @returns {Array<{ kill_switch?: string|null, [k: string]: unknown }>}
 *          Tail slice of parsed records, NEWEST-LAST. `[]` on any failure.
 */
export function readRecentAutopilotRuns({ repoRoot, limit = DEFAULT_LIMIT } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return [];

  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;

  let raw;
  try {
    raw = readFileSync(path.join(repoRoot, AUTOPILOT_JSONL_RELPATH), 'utf8');
  } catch {
    // Missing / unreadable file ⇒ no history ⇒ [] (G2 gate omitted with a warning).
    return [];
  }

  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      // Only keep object records; primitives/arrays are not run records.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Skip a corrupt/partial line — one bad line never discards the history.
    }
  }

  // Return the newest `cap` records, preserving on-disk (newest-last) order.
  return records.length > cap ? records.slice(records.length - cap) : records;
}
