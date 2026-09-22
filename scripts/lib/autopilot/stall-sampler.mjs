/**
 * autopilot/stall-sampler.mjs — Stateless progress sampler for STALL_TIMEOUT
 * kill-switch (ADR-364, issue #371).
 *
 * PROGRESS MARKER PRECEDENCE (HR-102: a better signal REPLACES a worse one).
 *
 *   1. `session.lock` `last_heartbeat` (schema v2) — advances DURING a run:
 *      `hooks/on-stop.mjs` refreshes it at every turn-end and
 *      `hooks/post-tool-batch-wave-signal.mjs` at every tool batch.
 *   2. `autopilot.jsonl` mtime — the legacy marker, used only when no lock path
 *      is supplied or the lock is absent/corrupt/timestamp-less.
 *
 * The header of this module used to claim `autopilot.jsonl` carries "one record
 * per session". It does not: `telemetry.mjs` writes ONE record per /autopilot
 * INVOCATION, and `loop.mjs` calls it exactly twice — once for the dry-run
 * preview and once AFTER the `for(;;)` loop. So during a real run the mtime the
 * sampler read belonged to the PREVIOUS autopilot run, typically hours or days
 * old, and the post-session check fired STALL_TIMEOUT after iteration 1 every
 * time. The append-once contract is correct and stays; the marker was wrong.
 *
 * CEILING (BV-004). The heartbeat only advances while some live session owns the
 * lock: `updateHeartbeat()` refuses on a session_id mismatch, and a child
 * `claude -p` spawned while a parent session already holds the lock never
 * acquires one (`hooks/_lib/lock-bootstrap.mjs` bails on `reason: 'active'`).
 * In that one invocation shape — the headless driver started FROM a chat
 * session rather than from a bare shell — the heartbeat freezes and the check
 * degrades to today's behaviour. Revisit if STALL_TIMEOUT is ever observed
 * firing on a run whose child session did real work.
 *
 * Stateless — at most two sync reads per invocation, no side effects, no async.
 *
 * Exports:
 *   SAMPLE_CADENCE_MS — shared constant (30_000) defining the "fresh" window
 *   sampleProgress(opts) — returns progress descriptor; never throws
 */

import { readFileSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Window (ms) within which a marker is considered "fresh". If the autopilot.jsonl
 * mtime is within the last SAMPLE_CADENCE_MS, the sampler reports progressed=true.
 * Exported so the kill-switch caller and tests share the same value.
 */
export const SAMPLE_CADENCE_MS = 30_000;

const DEFAULT_AUTOPILOT_JSONL = '.orchestrator/metrics/autopilot.jsonl';
const DEFAULT_STALL_TIMEOUT_SECONDS = 600;
const MARKER_SUCCESS = 'autopilot.jsonl:mtime';
const MARKER_HEARTBEAT = 'session.lock:last_heartbeat';
const MARKER_MISSING = 'missing';
const MARKER_INVALID = 'invalid';

/**
 * Read the live heartbeat timestamp (ms) out of `session.lock`.
 *
 * Returns `null` — meaning "fall back to the mtime marker" — for every failure
 * mode: no path supplied, file absent, unreadable, not JSON, or carrying no
 * parsable timestamp. A missing measurement is NOT a zero here; conflating the
 * two would report a stall of `now` seconds the moment the lock is unreadable.
 *
 * @param {string} [sessionLockPath]
 * @returns {number | null}
 */
function readHeartbeatMs(sessionLockPath) {
  if (typeof sessionLockPath !== 'string' || sessionLockPath.length === 0) return null;
  let lock;
  try {
    lock = JSON.parse(readFileSync(sessionLockPath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof lock !== 'object' || lock === null) return null;
  // Same precedence `session-lock.mjs` uses on read: a v1 lock has no
  // `last_heartbeat`, and its `started_at` is the best available stand-in.
  const raw = typeof lock.last_heartbeat === 'string' && lock.last_heartbeat.length > 0
    ? lock.last_heartbeat
    : lock.started_at;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Progress sampler
// ---------------------------------------------------------------------------

/**
 * Sample autopilot progress by reading `autopilot.jsonl` mtime.
 *
 * @param {object} [opts]
 * @param {string} [opts.autopilotJsonlPath] — path to autopilot.jsonl (default
 *   '.orchestrator/metrics/autopilot.jsonl').
 * @param {string} [opts.sessionLockPath] — path to `session.lock`. When supplied
 *   and readable, its `last_heartbeat` (falling back to `started_at`, the schema
 *   v1 normalisation `session-lock.mjs` applies on read) REPLACES the mtime
 *   marker. Omitted → mtime only, which is what every pre-existing caller gets.
 * @param {number} [opts.stallTimeoutSeconds] — kill-switch threshold (default
 *   600). NOT range-clamped here; caller is responsible for bounds.
 * @param {() => number} [opts.nowMs] — wall-clock supplier (default Date.now).
 *   DI seam for deterministic tests.
 * @returns {{
 *   progressed: boolean,
 *   lastMarker: number | null,
 *   stallSeconds: number,
 *   marker: string,
 * }}
 */
export function sampleProgress(opts = {}) {
  const autopilotJsonlPath = opts.autopilotJsonlPath ?? DEFAULT_AUTOPILOT_JSONL;
  // stallTimeoutSeconds is currently informational — the caller decides if
  // stallSeconds exceeds threshold. We read it (with default) so the signature
  // stays stable when (future) clamp logic moves here. Underscore prefix marks
  // intentional non-use per the project ESLint config.
  const _stallTimeoutSeconds = opts.stallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS;
  void _stallTimeoutSeconds;
  const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : Date.now;

  let markerMs = readHeartbeatMs(opts.sessionLockPath);
  let markerName = MARKER_HEARTBEAT;

  if (markerMs === null) {
    markerName = MARKER_SUCCESS;
    try {
      markerMs = statSync(autopilotJsonlPath).mtimeMs;
    } catch (err) {
      const marker = err && err.code === 'ENOENT' ? MARKER_MISSING : MARKER_INVALID;
      return {
        progressed: false,
        lastMarker: null,
        stallSeconds: 0,
        marker,
      };
    }
  }

  const now = nowMs();
  const deltaMs = now - markerMs;
  // Clamp negative deltas (clock skew, file mtime in the future) to 0.
  const stallSeconds = Math.max(0, Math.round(deltaMs / 1000));
  // Fresh if within the sample cadence window (also covers the clock-skew
  // future-mtime case where deltaMs < SAMPLE_CADENCE_MS).
  const progressed = deltaMs < SAMPLE_CADENCE_MS;

  return {
    progressed,
    lastMarker: markerMs,
    stallSeconds,
    marker: markerName,
  };
}
