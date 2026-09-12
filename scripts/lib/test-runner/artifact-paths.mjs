/**
 * test-runner/artifact-paths.mjs — Pure path builders for test-run artifacts.
 *
 * All functions are side-effect free. Callers are responsible for mkdir.
 *
 * Exports:
 *   RUN_ID_PATTERN               → RegExp  accepted run-id shape
 *   assertRunId(runId)           → string  the runId, or throws TypeError
 *   makeRunId()                  → string  e.g., '12345-1715688000123'
 *   runDirPath(runId)            → string
 *   findingsPath(runId)          → string
 *   reportPath(runId)            → string
 *   screenshotsDir(runId)        → string
 *   axSnapshotsDir(runId)        → string
 *   consoleLogPath(runId)        → string
 *   jsonlRollupPath()            → string
 */

import path from 'node:path';

const ROLLUP_REL = '.orchestrator/metrics/test-runs.jsonl';
const TEST_RUNS_REL = '.orchestrator/metrics/test-runs';

/**
 * Accepted shape of a run id — the single definition for test-runner AND
 * ux-grill (`scripts/lib/ux-grill/paths.mjs` imports it; ux-grill → test-runner
 * is the allowed dependency direction). A run id reaches `path.join` unescaped,
 * so `/` would escape the run directory. `.` and `..` match this class too and
 * are rejected separately by {@link assertRunId}.
 * @type {RegExp}
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a run id: a string matching {@link RUN_ID_PATTERN} that is not `.`
 * or `..` (both resolve to the base dir or its parent — path traversal, #1330).
 * @param {unknown} runId
 * @returns {string} the same runId
 * @throws {TypeError} if runId is not a string, does not match the pattern, or is `.`/`..`
 */
export function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId) || runId === '.' || runId === '..') {
    throw new TypeError(`runId must match ${RUN_ID_PATTERN} and not be "." or "..", got ${JSON.stringify(runId)}`);
  }
  return runId;
}

/**
 * Generate a unique run-id from PID + millisecond timestamp.
 * Format: `${process.pid}-${Date.now()}`
 * @returns {string}
 */
export function makeRunId() {
  return `${process.pid}-${Date.now()}`;
}

/**
 * Construct the run-dir path for a given runId. Every other per-run builder in
 * this module routes through here, so this is the single path-traversal guard.
 * @param {string} runId
 * @returns {string}
 * @throws {TypeError} on an invalid runId (see {@link assertRunId})
 */
export function runDirPath(runId) {
  return path.join(TEST_RUNS_REL, assertRunId(runId));
}

/**
 * Path to the findings JSONL file for a run.
 * @param {string} runId
 * @returns {string}
 */
export function findingsPath(runId) {
  return path.join(runDirPath(runId), 'findings.jsonl');
}

/**
 * Path to the Markdown report file for a run.
 * @param {string} runId
 * @returns {string}
 */
export function reportPath(runId) {
  return path.join(runDirPath(runId), 'report.md');
}

/**
 * Path to the screenshots directory for a run.
 * @param {string} runId
 * @returns {string}
 */
export function screenshotsDir(runId) {
  return path.join(runDirPath(runId), 'screenshots');
}

/**
 * Path to the accessibility-tree snapshots directory for a run.
 * @param {string} runId
 * @returns {string}
 */
export function axSnapshotsDir(runId) {
  return path.join(runDirPath(runId), 'ax-snapshots');
}

/**
 * Path to the console log file for a run.
 * @param {string} runId
 * @returns {string}
 */
export function consoleLogPath(runId) {
  return path.join(runDirPath(runId), 'console.log');
}

/**
 * Path to the shared JSONL rollup file (across all runs).
 * @returns {string}
 */
export function jsonlRollupPath() {
  return ROLLUP_REL;
}
