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
    ? extractCount(tcResult.fullOutput ?? tcResult.output, /error TS\d+/)
    : 0;

// --- Test ---
// NOTE: `testCounts`, NOT `failed` — a local `failed` is already bound near
// the bottom of this file and drives `process.exit(failed ? 2 : 0)`.
// Shadowing it would corrupt the gate's exit code.
const testResult = runCheck(testCmd);
const testCounts =
  testResult.status !== 'skip'
    ? extractTestCounts(testResult.fullOutput ?? testResult.output)
    : { passed: 0, failed: 0, total: 0, files: null };

// A suite that dies at import time (a bad import, a syntax error in a test
// file) is counted on vitest's `Test Files` line, not its `Tests` line —
// vitest omits `N failed` from `Tests` when zero individual test CASES ran.
// That leaves `status: 'fail'` sitting beside `failed: 0`, which reads as "no
// failures" even though the gate is about to block. `suite_died` names the
// contradiction explicitly, in the JSON itself, rather than leaving it
// inferable only by cross-referencing three separate fields (#1149).
//
// All FOUR of these fields are file-measurement-derived, so all four are
// published together or not at all. Only vitest prints a `Test Files` line; a
// non-vitest runner or a terse reporter prints none, and the previous
// zero-filled `files_*: 0` was an UNMEASURED zero the envelope could not tell
// from a measured one — with `suite_died: false` derived from it, stating a
// verdict nobody had checked. Absent, not zero: the same contract this
// envelope's `counts` field already keeps (`admitSuiteCounts`).
const fileFields = testCounts.files
  ? {
      files_total: testCounts.files.total,
      files_passed: testCounts.files.passed,
      files_failed: testCounts.files.failed,
      // Self-diagnosing: true exactly when `status: 'fail'` sits beside a
      // test-case `failed: 0` that a file-level failure explains. Greppable —
      // a consumer no longer has to recompute the contradiction by hand.
      suite_died:
        testResult.status === 'fail' && testCounts.failed === 0 && testCounts.files.failed > 0,
    }
  : {};

// --- Lint ---
const lintResult = runCheck(lintCmd);
const lintWarnings =
  lintResult.status !== 'skip'
    ? extractCount(lintResult.fullOutput ?? lintResult.output, /warning/i)
    : 0;

// --- Debug artifacts ---
const debugArtifacts = collectDebugArtifacts(sessionStartRef);

// --- Duration ---
const durationSeconds = Math.round((Date.now() - startTime) / 1000);

// --- Stub map ---
const stubbed = {};
if (tcResult.stubbed) stubbed.typecheck = tcResult.stubbed;
if (testResult.stubbed) stubbed.test = testResult.stubbed;
if (lintResult.stubbed) stubbed.lint = lintResult.stubbed;

// --- Output ---
const output = {
  variant: 'full-gate',
  duration_seconds: durationSeconds,
  typecheck: { status: tcResult.status, error_count: tcErrorCount },
  // `failed` is published explicitly (#967 item 1) rather than left to be
  // re-derived as `total - passed` downstream: the derivation and the parse can
  // disagree, and only an explicit third number lets a consumer check
  // `passed + failed === total` as a real producer/consumer drift guard.
  test: {
    status: testResult.status,
    total: testCounts.total,
    passed: testCounts.passed,
    failed: testCounts.failed,
    // File-level counts + `suite_died` (#1149) — present only when a
    // `Test Files` line was actually parsed; see `fileFields` above.
    // Additive keys only: `admitSuiteCounts` / `suiteCountsFromGateStdout`
    // read just passed/failed/total, so the stdout JSON contract stays one
    // document and the test-case triple keeps `total === passed + failed`.
    ...fileFields,
  },
  lint: { status: lintResult.status, warnings: lintWarnings },
  debug_artifacts: debugArtifacts,
  stubbed,
};

process.stdout.write(JSON.stringify(output) + '\n');

// Exit 2 if any check failed; skipped counts as pass.
const failed = [tcResult, testResult, lintResult].some(
  (r) => r.status === 'fail',
);

// --- Failure disclosure ---
// A gate that BLOCKS and says nothing is not concise, it is unusable. Measured
// 2026-08-23: a pre-push run emitted exactly
//   {"test":{"status":"fail","total":14671,"passed":14671,"failed":0}, …}
// and nothing else. `failed: 0` beside `status: fail` was not a contradiction
// in the data — it was the SHAPE of the report: `extractTestCounts` reads
// vitest's `Tests …` summary line, and vitest OMITS the `N failed` segment
// when no individual test case failed. A suite that dies at import time is
// counted on the `Test Files …` line instead, which this payload had no field
// for. So a file-level failure was, by construction, reported as zero
// failures. The JSON envelope now carries `files_failed` and `suite_died`
// (#1149) so that contradiction is published rather than only inferable —
// but the envelope still does not name WHICH file died.
//
// Reconstructing which file died then cost a full manual re-materialisation of
// the tracked tree. That is the cost this block removes: on failure the raw
// output of every failing gate goes to STDERR, where the JSON contract on
// STDOUT is untouched and every existing consumer keeps parsing one line.
//
// stderr, not stdout, and only on failure, for three reasons that are all
// contract-preserving: `scripts/run-quality-gate.mjs` and the pre-push hook
// parse stdout as ONE JSON document; a green run stays silent, so the "~2 min
// of silence" the hook promises still holds; and the operator gets the failure
// at the moment of the block instead of a second run to find it.
if (failed) {
  for (const [name, result] of [
    ['typecheck', tcResult],
    ['test', testResult],
    ['lint', lintResult],
  ]) {
    if (result.status !== 'fail') continue;
    const raw = result.fullOutput ?? result.output ?? '';
    process.stderr.write(`\n──── ${name} FAILED — raw output ────\n`);
    process.stderr.write(raw.length > 0 ? raw : '(the gate captured no output)\n');
    process.stderr.write(`──── end ${name} ────\n`);
  }
}

process.exit(failed ? 2 : 0);
