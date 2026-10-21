#!/usr/bin/env node
// gate-full.mjs — full-gate quality gate handler
// Runs typecheck + tests + lint sequentially; exits 2 if any check fails, 0 otherwise.
//
// Required env: TYPECHECK_CMD, TEST_CMD, LINT_CMD (each may equal "skip")
// Optional env: SESSION_START_REF

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runCheck,
  extractCount,
  extractTestCounts,
  extractFailedTestFiles,
  extractTimeoutOnlyFailedFiles,
  collectDebugArtifacts,
  commandKillFields,
} from './gate-helpers.mjs';

const typecheckCmd = process.env.TYPECHECK_CMD;
const testCmd = process.env.TEST_CMD;
const lintCmd = process.env.LINT_CMD;
const sessionStartRef = process.env.SESSION_START_REF ?? '';

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
  const opts = Number.isFinite(raw) && raw > 0 ? { timeoutMs: raw } : {};
  // GATE_LEDGER_ROOT (#1425 A4, W5 fix-pass): the wrapper publishes the ledger
  // root it resolved (--ledger-root > repo root) so the gate-process register
  // is written where the WRAPPER decided, not where this sub-script happens to
  // run. Without it every runCheck() here defaulted to process.cwd(), and a test
  // that spawned this script from the checkout wrote real lines into the live
  // .orchestrator/runtime/gate-processes.jsonl — the reaper's kill population.
  const ledgerRoot = (process.env.GATE_LEDGER_ROOT || "").trim();
  if (ledgerRoot && ledgerRoot.startsWith("/")) opts.repoRoot = ledgerRoot;
  return opts;
})();

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
const tcResult = await runCheck(typecheckCmd, CHECK_OPTS);
const tcErrorCount =
  tcResult.status === 'fail'
    ? extractCount(tcResult.fullOutput ?? tcResult.output, /error TS\d+/)
    : 0;

// --- Test ---
// NOTE: `testCounts`, NOT `failed` — a local `failed` is already bound near
// the bottom of this file and drives `process.exit(failed ? 2 : 0)`.
// Shadowing it would corrupt the gate's exit code.
const testResult = await runCheck(testCmd, CHECK_OPTS);
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
//
// `failed_files` (this change) is the fifth member of that same set and joins
// it for the same reason: it is DERIVED from the runner's file-level report, so
// it is published exactly when the file-level measurement exists. A count with
// no name is what made the 2026-09-06 pre-push block unusable —
// `files_failed: 1` out of 662, and reconstructing WHICH file cost a manual
// re-materialisation of the tracked tree. An EMPTY array here is meaningful and
// is NOT the absent case: it means vitest reported file-level failures but the
// file-name parser (`extractFailedTestFiles`) matched none of them out of the
// captured output — a parser gap worth seeing. The consumer,
// `failedFilesFromGateStdout()` in `scripts/run-quality-gate.mjs`, normalizes
// this `[]` to `null` (same as the true-absent case) before it reaches its own
// caller — so this array's "parsed but empty" distinction is visible here, in
// this envelope, and nowhere downstream.
const failedTestFiles = testResult.status === 'fail'
  ? extractFailedTestFiles(testResult.fullOutput ?? testResult.output ?? '')
  : [];

// --- Serial re-run of timeout-only failures (#1673) ---
// Under host load the parallel suite loses tests to their timeout while the
// code is fine: four pre-push runs on m5 blocked with four different red sets,
// none in the pushed diff, and the pushes then went out with the bypass. When
// EVERY failure of the run is a timeout, exactly those files run once more,
// one file at a time; only a clean re-run turns the test step green. An
// assertion failure is never re-run (it may be a genuine flake), a killed
// test command is never re-run (no complete error list), and the CI pipeline
// keeps running without this re-run, so it stays the strict instance.
// NAMED CEILING (BV-004): 10 files. More timeouts than that is not a few
// load victims but a broken run, and a serial re-run would double the wait.
// Revisit when a blocked push shows 11+ timeout-only files under load.
const RERUN_MAX_FILES = 10;
// The names go into a shell command line, so they must be plain paths.
const RERUN_FILE_NAME = /^[\w.@+][\w./@+-]*$/;
// Paths placed inside double quotes on that line: nothing the shell expands.
// NAMED CEILING (BV-004): a backslash is refused, so on Windows (`C:\…`
// temp paths) no re-run happens and the gate stays red as before. Revisit with
// the Windows gate work (#1612); cmd.exe also expands `%VAR%` inside quotes.
const QUOTABLE_PATH = /^[^"$`\\%\n\r]+$/;

/**
 * The re-run command: the gate's OWN test command with the file filters and
 * reporters appended, so its config, project selection, environment prefix and
 * binary are exactly those of the first run (Codex review round 2, H2). Only
 * shapes whose trailing arguments demonstrably reach vitest are accepted;
 * anything else returns null and nothing is re-run.
 * NAMED CEILING (BV-004): `npm test` / `npm run test` and a direct
 * `[VAR=… ][exec|npx ][path/]vitest run|--run` without shell operators. pnpm/yarn pass
 * `--` differently by version and are not accepted until measured. Revisit
 * when a consumer repo with another test command hits #1673.
 */
function rerunCommand(cmd, args) {
  const trimmed = (cmd ?? '').trim();
  if (/^npm (?:run )?test$/.test(trimmed)) return `${trimmed} -- ${args}`;
  // `[VAR=value …] [exec|npx] [path/]vitest run` — vitest itself is the program,
  // so the appended arguments are its own; no wrapper that might drop them.
  const direct = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|`$()<>]*\s+)*(?:(?:exec|npx)\s+)?(?:[^\s;&|`$()<>]*\/)?vitest (?:run|--run)$/;
  if (direct.test(trimmed)) return `${trimmed} ${args}`;
  return null;
}

const realOrSelf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Judge the re-run from vitest's JSON report, never from its exit code or its
 * summary counts alone: the default reporter does not name passing files, so
 * only the report proves that EXACTLY the requested files ran and passed (a
 * filter matching another file, or a config excluding the file, would
 * otherwise read as green). Returns `{ reason, passed, failed }`, `reason`
 * null when clean.
 */
function judgeRerunReport(reportPath, files, cwd) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return { reason: 'report-unreadable', passed: null, failed: null };
  }
  const counts = { passed: report?.numPassedTests ?? null, failed: report?.numFailedTests ?? null };
  if (report?.success !== true || report.numFailedTests !== 0 || !Array.isArray(report.testResults)) {
    return { reason: 'report-not-clean', ...counts };
  }
  const root = realOrSelf(cwd);
  const ran = report.testResults.map((t) => [
    path.relative(root, realOrSelf(String(t?.name ?? ''))).split(path.sep).join('/'),
    t?.status,
  ]);
  const wanted = new Set(files);
  const exact =
    ran.length === files.length && ran.every(([file, status]) => status === 'passed' && wanted.delete(file));
  return { reason: exact && wanted.size === 0 ? null : 'file-set-mismatch', ...counts };
}

let rerun = null;
let rerunResult = null;
// Only a run that ENDED with exit 1 — not by a signal (`exitSignal`, which
// `exitCode` alone reports as 1), not by the gate's own kill — and printed
// vitest's closing `Test Files` summary (`testCounts.files`). A signal that hits
// vitest under `npm test` surfaces as npm exit 143 (measured, npm 11.19.1), so
// both routes of an externally ended run stay out (Codex review rounds 2+3, M3).
if (
  testResult.status === 'fail' &&
  testResult.timedOut !== true &&
  testResult.exitCode === 1 &&
  !testResult.exitSignal &&
  (testResult.killSignals ?? []).length === 0 &&
  testCounts.files
) {
  const timeouts = extractTimeoutOnlyFailedFiles(testResult.fullOutput ?? testResult.output ?? '');
  if (
    timeouts.eligible &&
    timeouts.files.length <= RERUN_MAX_FILES &&
    timeouts.files.every((f) => RERUN_FILE_NAME.test(f))
  ) {
    let reportDir = null;
    try {
      reportDir = mkdtempSync(path.join(tmpdir(), 'gate-rerun-'));
      const reportPath = path.join(reportDir, 'report.json');
      const command = QUOTABLE_PATH.test(reportPath)
        ? rerunCommand(
            testCmd,
            // `default` keeps a readable failure on stderr; `json` is the proof.
            `--no-file-parallelism --reporter=default --reporter=json --outputFile.json="${reportPath}" ${timeouts.files.join(' ')}`,
          )
        : null;
      if (command !== null) {
        rerunResult = await runCheck(command, CHECK_OPTS);
        const judged = judgeRerunReport(reportPath, timeouts.files, process.cwd());
        const verdict = rerunResult.status === 'pass' ? judged : { ...judged, reason: 'exit-non-zero' };
        rerun = {
          files: timeouts.files,
          status: verdict.reason === null ? 'pass' : 'fail',
          ...(verdict.reason ? { reason: verdict.reason } : {}),
          passed: verdict.passed,
          failed: verdict.failed,
          ...commandKillFields(rerunResult),
        };
      }
    } catch (err) {
      // Any failure around the re-run keeps the step red and still names the files.
      rerun = { files: timeouts.files, status: 'fail', reason: `rerun-error: ${err?.code ?? err?.message ?? 'unknown'}`, passed: null, failed: null };
    } finally {
      if (reportDir !== null) {
        try {
          rmSync(reportDir, { recursive: true, force: true });
        } catch {
          /* a leftover temp dir must not crash the gate or flip its verdict */
        }
      }
    }
  }
}
const testStatus = rerun?.status === 'pass' ? 'pass' : testResult.status;

const fileFields = testCounts.files
  ? {
      files_total: testCounts.files.total,
      files_passed: testCounts.files.passed,
      files_failed: testCounts.files.failed,
      failed_files: failedTestFiles,
      // Self-diagnosing: true exactly when `status: 'fail'` sits beside a
      // test-case `failed: 0` that a file-level failure explains. Greppable —
      // a consumer no longer has to recompute the contradiction by hand.
      suite_died:
        // `testStatus`: a suite whose only failure was a hook timeout and that
        // re-ran clean (#1673) did not die.
        testStatus === 'fail' && testCounts.failed === 0 && testCounts.files.failed > 0,
    }
  : {};

// --- Lint ---
const lintResult = await runCheck(lintCmd, CHECK_OPTS);
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
  // Each command object also carries its INNER kill ladder (`timed_out`,
  // `kill_signals`, `survivors` pids) when `runCheck` spawned it — omitted for
  // skip/stub (#1457). `run-quality-gate.mjs` joins them into its event.
  typecheck: { status: tcResult.status, error_count: tcErrorCount, ...commandKillFields(tcResult) },
  // `failed` is published explicitly (#967 item 1) rather than left to be
  // re-derived as `total - passed` downstream: the derivation and the parse can
  // disagree, and only an explicit third number lets a consumer check
  // `passed + failed === total` as a real producer/consumer drift guard.
  // `status` is the step's verdict after a re-run; the counts below stay the
  // first, parallel run's measurement, and `rerun` says what turned it green.
  test: {
    status: testStatus,
    total: testCounts.total,
    passed: testCounts.passed,
    failed: testCounts.failed,
    // File-level counts + `suite_died` (#1149) — present only when a
    // `Test Files` line was actually parsed; see `fileFields` above.
    // Additive keys only: `admitSuiteCounts` / `suiteCountsFromGateStdout`
    // read just passed/failed/total, so the stdout JSON contract stays one
    // document and the test-case triple keeps `total === passed + failed`.
    ...fileFields,
    ...commandKillFields(testResult),
    ...(rerun ? { rerun } : {}),
  },
  lint: { status: lintResult.status, warnings: lintWarnings, ...commandKillFields(lintResult) },
  debug_artifacts: debugArtifacts,
  stubbed,
};

process.stdout.write(JSON.stringify(output) + '\n');

// Exit 2 if any check failed; skipped counts as pass.
const failed = [tcResult.status, testStatus, lintResult.status].some(
  (status) => status === 'fail',
);

// Every re-run is named, green or not, so a load-sensitive file stays visible
// even when the push goes through.
if (rerun) {
  process.stderr.write(
    `\n──── test re-run: ${rerun.files.length} file(s) failed only by timeout, re-ran serially → ${rerun.status} ────\n` +
      rerun.files.map((f) => `  ${f}\n`).join(''),
  );
}

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
  // Names FIRST, raw output after. Under the pre-push hook the raw block is
  // hundreds of lines; the operator reads the top of it, and the one fact he
  // needs to act (`npx vitest run <file>`) must not sit at the bottom.
  if (testStatus === 'fail' && failedTestFiles.length > 0) {
    process.stderr.write(
      `\n──── failing test files (${failedTestFiles.length}) ────\n` +
        failedTestFiles.map((f) => `  ${f}\n`).join('') +
        `  reproduce: npx vitest run ${failedTestFiles.join(' ')}\n`,
    );
  }
  for (const [name, result, status] of [
    ['typecheck', tcResult, tcResult.status],
    ['test', testResult, testStatus],
    ['test re-run', rerunResult, rerun?.status],
    ['lint', lintResult, lintResult.status],
  ]) {
    if (status !== 'fail') continue;
    // A re-run that never started (temp dir, spawn) has no result, only a reason.
    const raw = result ? (result.fullOutput ?? result.output ?? '') : `(not run: ${rerun?.reason ?? 'unknown'})\n`;
    process.stderr.write(`\n──── ${name} FAILED — raw output ────\n`);
    process.stderr.write(raw.length > 0 ? raw : '(the gate captured no output)\n');
    process.stderr.write(`──── end ${name} ────\n`);
  }
}

// stderr is asynchronous when piped (pre-push/offload capture). Drain queued
// writes before the forced exit; natural exit would retain kill-ladder timers.
await Promise.all([
  new Promise((resolve) => process.stdout.write('', resolve)),
  new Promise((resolve) => process.stderr.write('', resolve)),
]);
process.exit(failed ? 2 : 0);
