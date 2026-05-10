/**
 * autopilot/stall-sampler.mjs — Stateless progress sampler for STALL_TIMEOUT
 * kill-switch (ADR-364, issue #371).
 *
 * The sampler reads `autopilot.jsonl` mtime as the progress marker: the
 * autopilot loop writes one record per session atomically (tmp+rename), so the
 * file mtime advances exactly when the loop makes progress. No false-positive
 * churn from in-place writes, no need to parse JSON, microsecond precision.
 *
 * Stateless — single statSync call per invocation, no side effects, no async.
 * Wire-up to the kill-switch + loop is deferred (see #371 follow-up); this
 * module ships in isolation under the ADR-364 thin-slice MVP.
 *
 * Exports:
 *   SAMPLE_CADENCE_MS — shared constant (30_000) defining the "fresh" window
 *   sampleProgress(opts) — returns progress descriptor; never throws
 */

import { statSync } from 'node:fs';

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
const MARKER_MISSING = 'missing';
const MARKER_INVALID = 'invalid';

// ---------------------------------------------------------------------------
// Progress sampler
// ---------------------------------------------------------------------------

/**
 * Sample autopilot progress by reading `autopilot.jsonl` mtime.
 *
 * @param {object} [opts]
 * @param {string} [opts.autopilotJsonlPath] — path to autopilot.jsonl (default
 *   '.orchestrator/metrics/autopilot.jsonl').
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

  let mtimeMs;
  try {
    const st = statSync(autopilotJsonlPath);
    mtimeMs = st.mtimeMs;
  } catch (err) {
    const marker = err && err.code === 'ENOENT' ? MARKER_MISSING : MARKER_INVALID;
    return {
      progressed: false,
      lastMarker: null,
      stallSeconds: 0,
      marker,
    };
  }

  const now = nowMs();
  const deltaMs = now - mtimeMs;
  // Clamp negative deltas (clock skew, file mtime in the future) to 0.
  const stallSeconds = Math.max(0, Math.round(deltaMs / 1000));
  // Fresh if within the sample cadence window (also covers the clock-skew
  // future-mtime case where deltaMs < SAMPLE_CADENCE_MS).
  const progressed = deltaMs < SAMPLE_CADENCE_MS;

  return {
    progressed,
    lastMarker: mtimeMs,
    stallSeconds,
    marker: MARKER_SUCCESS,
  };
}
