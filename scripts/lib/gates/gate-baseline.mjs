#!/usr/bin/env node
// gate-baseline.mjs — baseline quality gate handler
// Runs typecheck (tail-5) + test (tail-5); informational only, always exits 0.
//
// Required env: TYPECHECK_CMD, TEST_CMD
// Each may equal "skip" or empty string → treated as skip.

import { runCheck } from './gate-helpers.mjs';

const typecheckCmd = process.env.TYPECHECK_CMD;
const testCmd = process.env.TEST_CMD;

if (!typecheckCmd) {
  process.stderr.write('TYPECHECK_CMD must be set\n');
  process.exit(1);
}
if (!testCmd) {
  process.stderr.write('TEST_CMD must be set\n');
  process.exit(1);
}

let tcResult = { status: 'skip', output: '' };
let testResult = { status: 'skip', output: '' };

if (typecheckCmd !== 'skip') {
  tcResult = await runCheck(typecheckCmd);
}

if (testCmd !== 'skip') {
  testResult = await runCheck(testCmd);
}

const result = {
  variant: 'baseline',
  typecheck: tcResult.status,
  test: testResult.status,
  typecheck_output: tcResult.output,
  test_output: testResult.output,
};

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(0);
