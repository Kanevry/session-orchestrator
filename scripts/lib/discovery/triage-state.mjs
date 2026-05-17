/**
 * triage-state.mjs — Persistent triage state for discovery findings.
 *
 * Implements append-only JSONL state tracking for discovery findings
 * introduced in issue #419. State is keyed by a stable fingerprint derived
 * from {probe, file, severity, ruleId} — line_number intentionally excluded
 * because it drifts on refactoring without the underlying issue changing.
 *
 * Design decisions (from W1-A5 discovery):
 * - Fingerprint: sha256(probe|file|severity|ruleId).slice(0, 16) hex
 * - State enum: open | dismissed | promoted-to-#NNN | accepted-as-known | reopened
 * - No TTL on dismissed state — recurrence requires a genuine fingerprint change
 * - Last-writer-wins per fingerprint when loading state
 * - Re-run flow: load state → filter new findings → present only open/missing
 */

import { createHash } from 'node:crypto';
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '../common.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid triage state values. */
export const VALID_STATES = [
  'open',
  'dismissed',
  'accepted-as-known',
  'reopened',
];

// promoted-to-#NNN is a dynamic variant — validated via prefix check below
const PROMOTED_PREFIX = 'promoted-to-#';

/**
 * Default state file path relative to the repo root.
 * Override by passing `stateFilePath` explicitly.
 */
export const DEFAULT_STATE_FILE = '.orchestrator/metrics/discovery-triage.jsonl';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute state file path.
 * If `stateFilePath` is already absolute, use it as-is.
 * Otherwise join with the project root.
 *
 * @param {string|undefined} stateFilePath
 * @returns {string}
 */
function resolveStatePath(stateFilePath) {
  const p = stateFilePath ?? DEFAULT_STATE_FILE;
  if (path.isAbsolute(p)) return p;
  return path.join(findProjectRoot(), p);
}

/**
 * Return true if `state` is a valid triage state value.
 * Accepts fixed enum values AND the dynamic `promoted-to-#NNN` form.
 *
 * @param {string} state
 * @returns {boolean}
 */
function isValidState(state) {
  if (typeof state !== 'string') return false;
  if (VALID_STATES.includes(state)) return true;
  if (state.startsWith(PROMOTED_PREFIX)) {
    const suffix = state.slice(PROMOTED_PREFIX.length);
    return /^\d+$/.test(suffix);
  }
  return false;
}

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic 16-character hex fingerprint for a finding.
 * Stable across runs as long as probe/file/severity/ruleId are unchanged.
 * line_number is intentionally excluded — it drifts on refactoring.
 *
 * @param {{probe: string, file: string, severity: string, ruleId: string}} finding
 * @returns {string} 16-char lowercase hex string
 * @throws {TypeError} if any required field is missing or not a string
 */
export function computeFingerprint({ probe, file, severity, ruleId } = {}) {
  const fields = { probe, file, severity, ruleId };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(
        `computeFingerprint: field '${key}' must be a non-empty string, got ${JSON.stringify(value)}`
      );
    }
  }
  const input = [probe, file, severity, ruleId].join('|');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// loadTriageState
// ---------------------------------------------------------------------------

/**
 * Load discovery triage state from a JSONL file.
 *
 * Each line is a JSON object with at minimum `{fingerprint, state}`.
 * Entries are accumulated by fingerprint — later entries overwrite earlier
 * ones (last-writer-wins). Malformed lines are silently skipped.
 *
 * Returns an empty Map if the file does not exist.
 *
 * @param {string} [stateFilePath] — path to the JSONL file (absolute or
 *   repo-relative). Defaults to DEFAULT_STATE_FILE.
 * @returns {Promise<Map<string, {state: string, issue_id?: number, timestamp: string, session_id: string}>>}
 */
export async function loadTriageState(stateFilePath) {
  const resolved = resolveStatePath(stateFilePath);
  if (!existsSync(resolved)) return new Map();

  const raw = await readFile(resolved, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  const map = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry.fingerprint !== 'string') continue;
      map.set(entry.fingerprint, {
        state: entry.state,
        issue_id: entry.issue_id,
        timestamp: entry.timestamp,
        session_id: entry.session_id,
        user_decision: entry.user_decision,
      });
    } catch {
      // Skip malformed lines without surfacing errors
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// appendTriageEntry
// ---------------------------------------------------------------------------

/**
 * Append a single triage entry to the JSONL state file.
 *
 * The entry shape is:
 * ```json
 * {
 *   "fingerprint": "...",
 *   "state": "open|dismissed|accepted-as-known|reopened|promoted-to-#NNN",
 *   "issue_id": 123,          // optional — for promoted-to-#NNN entries
 *   "user_decision": "...",   // optional — human-readable decision context
 *   "timestamp": "2026-01-01T00:00:00.000Z",
 *   "session_id": "deep-1"
 * }
 * ```
 *
 * Creates parent directories if missing.
 *
 * @param {string} stateFilePath — absolute or repo-relative path
 * @param {{fingerprint: string, state: string, issue_id?: number, user_decision?: string, timestamp: string, session_id: string}} entry
 * @returns {Promise<void>}
 * @throws {TypeError} if state is not a valid enum value
 * @throws {TypeError} if fingerprint, timestamp, or session_id is missing
 */
export async function appendTriageEntry(stateFilePath, entry) {
  if (typeof entry?.fingerprint !== 'string' || entry.fingerprint.length === 0) {
    throw new TypeError('appendTriageEntry: entry.fingerprint must be a non-empty string');
  }
  if (typeof entry?.timestamp !== 'string' || entry.timestamp.length === 0) {
    throw new TypeError('appendTriageEntry: entry.timestamp must be a non-empty string');
  }
  if (typeof entry?.session_id !== 'string' || entry.session_id.length === 0) {
    throw new TypeError('appendTriageEntry: entry.session_id must be a non-empty string');
  }
  if (!isValidState(entry?.state)) {
    throw new TypeError(
      `appendTriageEntry: invalid state '${entry?.state}'. ` +
        `Valid values: ${VALID_STATES.join(', ')}, or promoted-to-#<number>`
    );
  }

  const resolved = resolveStatePath(stateFilePath);
  await mkdir(path.dirname(resolved), { recursive: true });

  const line = JSON.stringify(entry) + '\n';
  await appendFile(resolved, line, 'utf8');
}

// ---------------------------------------------------------------------------
// filterFindings
// ---------------------------------------------------------------------------

/**
 * Partition a list of findings against the loaded triage state map.
 *
 * Returns three buckets:
 * - `toShow`     — findings with state=open or NO prior state entry (new findings)
 * - `suppressed` — findings with state=dismissed or state=accepted-as-known
 * - `tracked`    — findings with state=promoted-to-#NNN (informational; issue_id attached)
 *
 * For `reopened` findings, they are included in `toShow` (re-presented for triage).
 *
 * Each finding must have enough fields to compute a fingerprint:
 * {probe, file, severity, ruleId}. Findings that cannot be fingerprinted
 * are included in `toShow` (safe default — show rather than suppress).
 *
 * @param {{
 *   findings: Array<{probe: string, file: string, severity: string, ruleId: string, [key: string]: unknown}>,
 *   stateMap: Map<string, {state: string, issue_id?: number}>
 * }} params
 * @returns {{
 *   toShow: typeof params.findings,
 *   suppressed: typeof params.findings,
 *   tracked: Array<typeof params.findings[number] & {issue_id?: number}>
 * }}
 */
export function filterFindings({ findings, stateMap }) {
  const toShow = [];
  const suppressed = [];
  const tracked = [];

  for (const finding of findings) {
    let fingerprint;
    try {
      fingerprint = computeFingerprint({
        probe: finding.probe,
        file: finding.file,
        severity: finding.severity,
        ruleId: finding.ruleId,
      });
    } catch {
      // Cannot fingerprint → show by default
      toShow.push(finding);
      continue;
    }

    const entry = stateMap.get(fingerprint);

    if (!entry) {
      // New finding — no prior state
      toShow.push(finding);
      continue;
    }

    const { state } = entry;

    if (state === 'dismissed' || state === 'accepted-as-known') {
      suppressed.push(finding);
    } else if (state.startsWith(PROMOTED_PREFIX)) {
      tracked.push({ ...finding, issue_id: entry.issue_id });
    } else {
      // open, reopened, or any unknown future state → show
      toShow.push(finding);
    }
  }

  return { toShow, suppressed, tracked };
}
