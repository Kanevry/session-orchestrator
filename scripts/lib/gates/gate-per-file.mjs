#!/usr/bin/env node
/**
 * gate-per-file.mjs — per-file quality gate handler
 * Runs typecheck on whole project + tests scoped to specified files; exits 0.
 *
 * Required env: TYPECHECK_CMD, TEST_CMD
 * Optional env: FILES (comma-separated)
 *
 * Part of v3.2 shell-helper port migration (issue #218 / #317).
 */

import { runCheck, csvToJsonArray } from './gate-helpers.mjs';

const typecheckCmd = process.env.TYPECHECK_CMD;
const testCmd = process.env.TEST_CMD;

/**
 * Per-command wall-clock ceiling, published by `scripts/run-quality-gate.mjs`
 * as `GATE_TIMEOUT_MS` (#1425 A3 / #1432). It carries the ALREADY-RESOLVED
 * value — operator override `SO_GATE_TIMEOUT_MS` > Session Config
 * `gate.timeout-path-b-ms` > 900 000 — so this script only has to read it.
 *
 * Absent or non-numeric (this gate invoked directly, not through the wrapper)
 * → the option is OMITTED, and `runCheck` falls back to `resolveGateTimeoutMs()`
 * exactly as before. An empty object is deliberate: passing `timeoutMs:
 * undefined` would NOT trigger that fallback in every spread order.
 */
const CHECK_OPTS = (() => {
  const raw = Number((process.env.GATE_TIMEOUT_MS || '').trim());
  return Number.isFinite(raw) && raw > 0 ? { timeoutMs: raw } : {};
})();

if (!typecheckCmd) {
  process.stderr.write('gate-per-file: TYPECHECK_CMD must be set\n');
  process.exit(1);
}

if (!testCmd) {
  process.stderr.write('gate-per-file: TEST_CMD must be set\n');
  process.exit(1);
}

const files = csvToJsonArray(process.env.FILES || '');

if (files.length === 0) {
  process.stderr.write(
    'gate-per-file: per-file variant requires FILES; skipping file-specific tests\n'
  );
}

// Typecheck runs on the whole project, not per-file
const tcResult = await runCheck(typecheckCmd, CHECK_OPTS);
const tcStatus = tcResult.status;

let testStatus = 'skip';

if (testCmd !== 'skip' && files.length > 0) {
  const fileArgs = files.join(' ');
  const testResult = await runCheck(`${testCmd} -- ${fileArgs}`, CHECK_OPTS);
  testStatus = testResult.status;
}

const result = {
  variant: 'per-file',
  typecheck: tcStatus,
  test: testStatus,
  files,
};

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(0);
