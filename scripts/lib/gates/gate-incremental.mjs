#!/usr/bin/env node
// gate-incremental.mjs — incremental quality gate handler
// Runs typecheck (full project) + targeted tests for changed/specified files.
// Always exits 0; emits a single JSON object to stdout.
//
// Required env: TYPECHECK_CMD, TEST_CMD
// Optional env: FILES (comma-separated), SESSION_START_REF

import { runCheck, resolveTestFiles, extractErrorLinesJson, commandKillFields } from './gate-helpers.mjs';

const typecheckCmd = process.env.TYPECHECK_CMD;
const testCmd = process.env.TEST_CMD;
const files = process.env.FILES ?? '';
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

const start = Date.now();

// A skipped test run spawned nothing: `{ status: 'skip' }`, no kill keys.
let testResult = { status: 'skip' };
let errors = [];

// --- typecheck (always runs unless cmd is "skip") ---
const tcResult = await runCheck(typecheckCmd, CHECK_OPTS);
if (tcResult.status === 'fail') {
  errors = errors.concat(extractErrorLinesJson(tcResult.output, /error TS\d+/));
}

// --- test (scoped to changed/specified files) ---
if (testCmd !== 'skip') {
  const testFiles = await resolveTestFiles(files, sessionStartRef);
  if (testFiles.length > 0) {
    const fileArgs = testFiles.join(' ');
    testResult = await runCheck(`${testCmd} -- ${fileArgs}`, CHECK_OPTS);
  } else if (!files && !sessionStartRef) {
    // No FILES or SESSION_START_REF supplied: run the full test suite
    testResult = await runCheck(testCmd, CHECK_OPTS);
  } else {
    // Files/ref supplied but no test files found — skip
    process.stderr.write('warn: No test files found for incremental run; skipping tests\n');
  }
  if (testResult.status === 'fail') {
    const testErrors = extractErrorLinesJson(testResult.output, /(fail|error|FAIL)/i);
    errors = errors.concat(testErrors);
  }
}

const duration_seconds = Math.round((Date.now() - start) / 1000);

const result = {
  variant: 'incremental',
  duration_seconds,
  // Each command object also carries its INNER kill ladder (`timed_out`,
  // `kill_signals`, `survivors` pids) when `runCheck` spawned it — omitted for
  // skip/stub (#1457). `run-quality-gate.mjs` joins them into its event.
  typecheck: { status: tcResult.status, ...commandKillFields(tcResult) },
  test: { status: testResult.status, ...commandKillFields(testResult) },
  errors,
};

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(0);
