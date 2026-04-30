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
const tcResult = runCheck(typecheckCmd);
const tcStatus = tcResult.status;

let testStatus = 'skip';

if (testCmd !== 'skip' && files.length > 0) {
  const fileArgs = files.join(' ');
  const testResult = runCheck(`${testCmd} -- ${fileArgs}`);
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
