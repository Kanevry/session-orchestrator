#!/usr/bin/env node
// gate-baseline.mjs — baseline quality gate handler
// Runs typecheck (tail-5) + test (tail-5); informational only, always exits 0.
//
// Required env: TYPECHECK_CMD, TEST_CMD
// Each may equal "skip" or empty string → treated as skip.

import { runCheck } from './gate-helpers.mjs';

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

let tcResult = { status: 'skip', output: '' };
let testResult = { status: 'skip', output: '' };

if (typecheckCmd !== 'skip') {
  tcResult = await runCheck(typecheckCmd, CHECK_OPTS);
}

if (testCmd !== 'skip') {
  testResult = await runCheck(testCmd, CHECK_OPTS);
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
