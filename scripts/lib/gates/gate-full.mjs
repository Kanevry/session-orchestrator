#!/usr/bin/env node
// gate-full.mjs — full-gate quality gate handler
// Runs typecheck + tests + lint sequentially; exits 2 if any check fails, 0 otherwise.
//
// Required env: TYPECHECK_CMD, TEST_CMD, LINT_CMD (each may equal "skip")
// Optional env: SESSION_START_REF

import {
  runCheck,
  extractCount,
  extractTestCounts,
  collectDebugArtifacts,
} from './gate-helpers.mjs';

const typecheckCmd = process.env.TYPECHECK_CMD;
const testCmd = process.env.TEST_CMD;
const lintCmd = process.env.LINT_CMD;
const sessionStartRef = process.env.SESSION_START_REF ?? '';

if (!typecheckCmd) {
  process.stderr.write('TYPECHECK_CMD must be set\n');
  process.exit(1);
}
if (!testCmd) {
  process.stderr.write('TEST_CMD must be set\n');
  process.exit(1);
}
if (!lintCmd) {
  process.stderr.write('LINT_CMD must be set\n');
  process.exit(1);
}

const startTime = Date.now();

// --- Typecheck ---
const tcResult = runCheck(typecheckCmd);
const tcErrorCount =
  tcResult.status === 'fail'
    ? extractCount(tcResult.output, /error TS\d+/)
    : 0;

// --- Test ---
const testResult = runCheck(testCmd);
const { passed: testPassed, total: testTotal } =
  testResult.status !== 'skip'
    ? extractTestCounts(testResult.output)
    : { passed: 0, total: 0 };

// --- Lint ---
const lintResult = runCheck(lintCmd);
const lintWarnings =
  lintResult.status !== 'skip'
    ? extractCount(lintResult.output, /warning/i)
    : 0;

// --- Debug artifacts ---
const debugArtifacts = collectDebugArtifacts(sessionStartRef);

// --- Duration ---
const durationSeconds = Math.round((Date.now() - startTime) / 1000);

// --- Output ---
const output = {
  variant: 'full-gate',
  duration_seconds: durationSeconds,
  typecheck: { status: tcResult.status, error_count: tcErrorCount },
  test: { status: testResult.status, total: testTotal, passed: testPassed },
  lint: { status: lintResult.status, warnings: lintWarnings },
  debug_artifacts: debugArtifacts,
};

process.stdout.write(JSON.stringify(output) + '\n');

// Exit 2 if any check failed; skipped counts as pass.
const failed = [tcResult, testResult, lintResult].some(
  (r) => r.status === 'fail',
);
process.exit(failed ? 2 : 0);
