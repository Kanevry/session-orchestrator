/**
 * gate-helpers.mjs — Shared utility functions for quality-gate handlers.
 *
 * Pure ESM, Node stdlib only. Replaces gate-helpers.sh for .mjs gate scripts.
 *
 * Part of v3.2 shell-helper port migration (issue #218 / #317).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { detectStubCommand } from './echo-stub-detect.mjs';

// ---------------------------------------------------------------------------
// Internal pattern helpers
// ---------------------------------------------------------------------------

/** Test patterns that identify test/spec files. */
const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.test\.mjs$/,
  /\.spec\.[jt]sx?$/,
  /\.spec\.mjs$/,
  /__tests__\//,
];

/**
 * Returns true if the given file path matches a test-file pattern.
 * @param {string} filePath
 * @returns {boolean}
 */
function isTestFile(filePath) {
  return TEST_PATTERNS.some((re) => re.test(filePath));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Execute a shell command and return a structured result.
 *
 * @param {string} cmd - Shell command to run, or `"skip"` / empty to skip.
 * @returns {{ status: 'pass'|'fail'|'skip', output: string, exitCode: number, stubbed?: { kind: 'echo'|'noop' } }}
 */
export function runCheck(cmd) {
  if (!cmd || cmd === 'skip') {
    return { status: 'skip', output: '', exitCode: 0 };
  }

  const stub = detectStubCommand(cmd);
  if (stub.isStub) {
    return { status: 'pass', output: `(stubbed: ${stub.kind})`, exitCode: 0, stubbed: { kind: stub.kind } };
  }

  try {
    const raw = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = raw.split('\n').slice(-5).join('\n').trim();
    return { status: 'pass', output, exitCode: 0 };
  } catch (err) {
    const exitCode = typeof err.status === 'number' ? err.status : 1;

    // Exit code 127 means command not found — treat as skip.
    if (exitCode === 127) {
      return { status: 'skip', output: 'command not found', exitCode };
    }

    const combined = [err.stdout ?? '', err.stderr ?? ''].join('\n');
    const output = combined.split('\n').slice(-5).join('\n').trim();
    return { status: 'fail', output, exitCode };
  }
}

/**
 * Parse a comma-separated string into an array of trimmed, non-empty entries.
 *
 * @param {string} csv
 * @returns {string[]}
 */
export function csvToJsonArray(csv) {
  if (!csv || typeof csv !== 'string') return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Return the list of files changed between `ref` and HEAD.
 *
 * @param {string} ref - Git ref (commit hash, branch, tag). Returns [] if empty.
 * @returns {string[]}
 */
export function findChangedFiles(ref) {
  if (!ref || typeof ref !== 'string' || !ref.trim()) return [];
  try {
    const output = execSync(`git diff --name-only ${ref} HEAD`, {
      encoding: 'utf8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Return only the test/spec files from the set of changed files since `ref`.
 *
 * @param {string} ref - Git ref passed to {@link findChangedFiles}.
 * @returns {string[]}
 */
export function findChangedTestFiles(ref) {
  return findChangedFiles(ref).filter(isTestFile);
}

/**
 * Count the number of regex matches of `pattern` in `output`.
 *
 * @param {string} output
 * @param {string|RegExp} pattern
 * @returns {number}
 */
export function extractCount(output, pattern) {
  if (!output || !pattern) return 0;
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'gi');
  const matches = output.match(re);
  return matches ? matches.length : 0;
}

/**
 * Parse vitest-style output for pass/fail/total counts.
 *
 * Looks for patterns like "42 passed", "3 failed".
 *
 * @param {string} output
 * @returns {{ passed: number, failed: number, total: number }}
 */
export function extractTestCounts(output) {
  if (!output) return { passed: 0, failed: 0, total: 0 };

  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const total = passed + failed;

  return { passed, failed, total };
}

/**
 * Scan changed files (since `ref`) for debug artifacts: `console.log`, `debugger`, `TODO`, `FIXME`.
 *
 * @param {string} ref - Git ref. Returns [] if empty or no changed files.
 * @returns {Array<{ file: string, line: number, snippet: string }>}
 */
export function collectDebugArtifacts(ref) {
  if (!ref) return [];

  const changedFiles = findChangedFiles(ref);
  if (changedFiles.length === 0) return [];

  const DEBUG_PATTERN = /console\.log|debugger|TODO|FIXME/;
  const artifacts = [];

  for (const filePath of changedFiles) {
    let contents;
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch {
      // File may have been deleted; skip silently.
      continue;
    }

    const lines = contents.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (DEBUG_PATTERN.test(lines[i])) {
        artifacts.push({
          file: filePath,
          line: i + 1,
          snippet: lines[i].trim(),
        });
        if (artifacts.length >= 50) return artifacts;
      }
    }
  }

  return artifacts;
}

/**
 * Return lines from `output` that match `pattern`, each wrapped in an object.
 *
 * @param {string} output
 * @param {string|RegExp} pattern
 * @returns {Array<{ line: string }>}
 */
export function extractErrorLinesJson(output, pattern) {
  if (!output || !pattern) return [];
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return output
    .split('\n')
    .filter((l) => re.test(l))
    .slice(0, 20)
    .map((line) => ({ line }));
}

/**
 * Resolve the test-file list from either an explicit CSV or changed files since `startRef`.
 *
 * If `filesCsv` is non-empty, splits on commas and returns entries that match
 * test-file patterns. Otherwise delegates to {@link findChangedTestFiles}.
 *
 * @param {string} filesCsv  - Comma-separated list of explicit test files (may be empty).
 * @param {string} startRef  - Git ref used when `filesCsv` is absent.
 * @returns {string[]}
 */
export function resolveTestFiles(filesCsv, startRef) {
  if (filesCsv && filesCsv.trim()) {
    return csvToJsonArray(filesCsv).filter(isTestFile);
  }
  if (startRef && startRef.trim()) {
    return findChangedTestFiles(startRef);
  }
  return [];
}
