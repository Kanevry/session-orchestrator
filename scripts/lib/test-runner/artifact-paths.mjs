/**
 * test-runner/artifact-paths.mjs — Pure path builders for test-run artifacts.
 *
 * All functions are side-effect free. Callers are responsible for mkdir.
 *
 * Exports:
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
 * Generate a unique run-id from PID + millisecond timestamp.
 * Format: `${process.pid}-${Date.now()}`
 * @returns {string}
 */
export function makeRunId() {
  return `${process.pid}-${Date.now()}`;
}

/**
 * Construct the run-dir path for a given runId.
 * @param {string} runId
 * @returns {string}
 */
export function runDirPath(runId) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new TypeError('runDirPath: runId must be a non-empty string');
  }
  return path.join(TEST_RUNS_REL, runId);
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
