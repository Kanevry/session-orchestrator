/**
 * autopilot/telemetry.mjs — Telemetry helpers for the autopilot loop.
 *
 * Relocated from scripts/lib/autopilot-telemetry.mjs as part of the W1A6
 * decomposition. The original path is kept as a thin backward-compat re-export.
 *
 * Leaf module: imports node built-ins only — no circular dependencies.
 *
 * Exports:
 *   SCHEMA_VERSION
 *   writeAutopilotJsonl(state, jsonlPath) — atomic tmp+rename JSONL writer
 *   defaultRunId(branch, nowMs)           — autopilot_run_id builder
 *   readHostClass(hostJsonPath)           — reads host.json host_class field
 *   finalizeState(state, nowMs)           — stamps completed_at + duration_seconds
 */

import { writeFileSync, renameSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// JSONL writer (atomic tmp + rename)
// ---------------------------------------------------------------------------

/**
 * Append-once writer for `autopilot.jsonl`. Writes ONE record per /autopilot
 * invocation atomically: stage to a tmpfile in the same directory, then
 * rename. Existing file contents are preserved (read → append → atomic
 * rewrite). Crash-safe: a partial tmpfile is never visible at the destination.
 *
 * @param {object} state — fully-formed autopilot state record
 * @param {string} jsonlPath — destination JSONL path
 */
export function writeAutopilotJsonl(state, jsonlPath) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('writeAutopilotJsonl: state must be an object');
  }
  if (typeof jsonlPath !== 'string' || jsonlPath.length === 0) {
    throw new TypeError('writeAutopilotJsonl: jsonlPath must be a non-empty string');
  }

  const dir = path.dirname(jsonlPath);
  mkdirSync(dir, { recursive: true });

  let existing;
  try {
    existing = readFileSync(jsonlPath, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.length > 0 && !existing.endsWith('\n')) existing += '\n';

  const line = JSON.stringify(state) + '\n';
  const tmp = `${jsonlPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, existing + line, 'utf8');
  renameSync(tmp, jsonlPath);
}

// ---------------------------------------------------------------------------
// Run-id + host class helpers
// ---------------------------------------------------------------------------

/**
 * Build a default autopilot_run_id from the current branch name and timestamp.
 *
 * @param {string|null|undefined} branch — git branch name
 * @param {number} nowMs — wall-clock milliseconds (Date.now())
 * @returns {string}
 */
export function defaultRunId(branch, nowMs) {
  const d = new Date(nowMs);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hhmm = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  const safeBranch = (branch ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${safeBranch}-${ymd}-${hhmm}-autopilot`;
}

/**
 * Read the `host_class` field from `.orchestrator/host.json`. Returns `null`
 * on any parse or I/O error.
 *
 * @param {string} hostJsonPath — absolute or relative path to host.json
 * @returns {string|null}
 */
export function readHostClass(hostJsonPath) {
  try {
    const obj = JSON.parse(readFileSync(hostJsonPath, 'utf8'));
    return typeof obj?.host_class === 'string' ? obj.host_class : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State finalizer
// ---------------------------------------------------------------------------

/**
 * Stamp `completed_at` and `duration_seconds` onto the autopilot state record
 * in-place. Called once at the end of `runLoop` (and in dry-run) before writing
 * the JSONL record.
 *
 * @param {object} state — mutable autopilot state record
 * @param {() => number} nowMs — wall-clock supplier
 */
export function finalizeState(state, nowMs) {
  const completedMs = nowMs();
  const startedMs = Date.parse(state.started_at);
  state.completed_at = new Date(completedMs).toISOString();
  state.duration_seconds = Number.isFinite(startedMs)
    ? Math.max(0, Math.round((completedMs - startedMs) / 1000))
    : 0;
}
