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
 *   appendJsonlAtomic(record, jsonlPath)               — shared atomic tmp+rename helper
 *   writeAutopilotJsonl(state, jsonlPath)              — atomic tmp+rename JSONL writer
 *   defaultRunId(branch, nowMs)                        — autopilot_run_id builder
 *   readHostClass(hostJsonPath)                        — reads host.json host_class field
 *   finalizeState(state, nowMs)                        — stamps completed_at + duration_seconds
 *   writeMultiStoryCoordinatorEntry(entry, jsonlPath)  — Phase D coordinator summary entry
 *   linkChildLoopToCoordinator(childRunId, parentRunId)— Phase D linkage documentation helper
 */

import { writeFileSync, renameSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Shared atomic JSONL append helper
// ---------------------------------------------------------------------------

/**
 * Atomically append a record as a JSONL line to `jsonlPath`.
 * Strategy: read existing file content → append new line in memory →
 * write to a tmp file in the same directory → rename tmp → final path.
 * Crash-safe: a partial tmpfile is never visible at the destination path.
 * POSIX rename(2) is atomic within the same filesystem.
 *
 * The directory must already exist (callers are responsible for mkdirSync).
 *
 * @param {object} record    — the record to serialize as a JSONL line
 * @param {string} jsonlPath — destination JSONL path
 */
export function appendJsonlAtomic(record, jsonlPath) {
  let existing;
  try {
    existing = readFileSync(jsonlPath, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.length > 0 && !existing.endsWith('\n')) existing += '\n';

  const line = JSON.stringify(record) + '\n';
  const tmp = `${jsonlPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, existing + line, 'utf8');
  renameSync(tmp, jsonlPath);
}

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

  appendJsonlAtomic(state, jsonlPath);
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

// ---------------------------------------------------------------------------
// Phase D — multi-story coordinator helpers
// ---------------------------------------------------------------------------

const DEFAULT_AUTOPILOT_JSONL = '.orchestrator/metrics/autopilot.jsonl';

/**
 * Write a per-orchestrator-run coordinator entry to autopilot.jsonl.
 * Used by autopilot-multi.mjs to log the multi-story run summary distinct
 * from individual story-loop entries (which are written by runLoop itself).
 *
 * Schema additions (additive, no version bump):
 *   - parent_run_id: null (the coordinator IS the parent — its id is the
 *     parent_run_id used by children)
 *   - kind: 'multi-story-coordinator' (vs 'single-loop' implied for legacy entries)
 *   - child_run_ids: string[] of loopIds that this coordinator spawned
 *   - cohort_aborted: boolean
 *
 * Fault-tolerant: errors are logged but never thrown — telemetry failures
 * must not crash the orchestrator.
 *
 * @param {object}   entry
 * @param {string}   entry.run_id           - the coordinator's parent_run_id
 * @param {string}   entry.started_at       - ISO 8601
 * @param {string}   entry.ended_at         - ISO 8601
 * @param {string}   entry.stop_reason      - 'first-kill-switch'|'backlog-empty'|'inactivity-timeout'|'max-hours'|'cohort-abort'
 * @param {number}   entry.loop_count
 * @param {number}   entry.completed_count
 * @param {number}   entry.failed_count
 * @param {string[]} entry.child_run_ids
 * @param {boolean}  entry.cohort_aborted
 * @param {object}   [entry.kill_detail]    - optional kill-switch detail when stop_reason is fatal
 * @param {string}   [jsonlPath]            - defaults to .orchestrator/metrics/autopilot.jsonl
 * @returns {void}
 */
export function writeMultiStoryCoordinatorEntry(entry, jsonlPath = DEFAULT_AUTOPILOT_JSONL) {
  // Defensive: ensure metrics directory exists
  const dir = path.dirname(jsonlPath);
  try { mkdirSync(dir, { recursive: true }); } catch { /* idempotent — directory may already exist */ }

  // Compose canonical record with required field defaults
  const record = {
    schema_version: 1,            // additive — coordinator entries are still v1
    run_id: entry.run_id,
    started_at: entry.started_at,
    ended_at: entry.ended_at,
    kind: 'multi-story-coordinator',
    parent_run_id: null,          // coordinator is at top of the tree
    child_run_ids: Array.isArray(entry.child_run_ids) ? entry.child_run_ids : [],
    stop_reason: entry.stop_reason,
    loop_count: entry.loop_count ?? 0,
    completed_count: entry.completed_count ?? 0,
    failed_count: entry.failed_count ?? 0,
    cohort_aborted: entry.cohort_aborted ?? false,
    kill_detail: entry.kill_detail ?? null,
  };

  try {
    appendJsonlAtomic(record, jsonlPath);
  } catch (err) {
    console.error(`[telemetry] writeMultiStoryCoordinatorEntry failed: ${err.message}`);
    // Do NOT throw — telemetry failures must not crash the orchestrator
  }
}

/**
 * Documentation-only helper. The linkage between child loops and the
 * coordinator is established via `state.parent_run_id` set by autopilot-multi
 * before calling runLoop. Children's autopilot.jsonl entries inherit the
 * parent_run_id automatically via the existing writeAutopilotJsonl path.
 *
 * This function exists so call-sites can self-document the contract.
 *
 * @param {string} childRunId  - the child's run_id
 * @param {string} parentRunId - the coordinator's run_id
 * @returns {{linked: true, child: string, parent: string}}
 */
export function linkChildLoopToCoordinator(childRunId, parentRunId) {
  return { linked: true, child: childRunId, parent: parentRunId };
}
