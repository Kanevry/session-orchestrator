#!/usr/bin/env node
// scripts/ci/assert-vitest-green.mjs
//
// Fail-closed verifier for a vitest JSON result file. Replaces the brittle
// grep-the-stdout heuristic the GitLab `test`/`coverage` jobs used to rely on.
//
// WHY THIS EXISTS (the silent-regression incident class):
//   The old CI test job ran `timeout --preserve-status 240s npm test … || true`
//   and then counted `✓`/`FAIL` markers in the captured stdout. Two ways that
//   reported a RED suite as GREEN:
//     1. The suite took longer than the 240s cap under runner contention
//        (observed: 257s on the Mac shell-executor). `timeout` killed vitest
//        BEFORE it printed the bottom failure-summary block; `|| true` swallowed
//        the kill; the grep found zero `FAIL  tests/…` lines → false GREEN.
//     2. The verbose reporter marks failing tests with `×` (U+00D7), which the
//        `✗` (U+2717) regex never matched.
//   Net effect: a 12-failure suite shipped green (commit c6e34e1 / pipeline
//   #5828). This is the same class as the documented 8-pipeline silent
//   regression (CLAUDE.md / AGENTS.md Critical Gotchas).
//
// THE FIX:
//   vitest's `--reporter=json --outputFile=<path>` writes a machine-readable
//   result on completion. This script is the single authority on pass/fail.
//   It is FAIL-CLOSED: any ambiguity (file missing, unparseable, truncated run,
//   success!==true) exits non-zero. The only GREEN path is an explicit, complete,
//   all-passing result.
//
//   Robustness to the legacy vitest-2.1.9 tinypool exit-hang (#268): the JSON
//   file is written at onFinished — AFTER all tests pass but BEFORE the hang —
//   so a post-completion hang (whose non-zero exit the CI step swallows with
//   `|| true`) still yields success:true here. A run killed mid-flight never
//   writes a complete file, so it fails closed. Both behaviours are correct.
//
// USAGE:
//   node scripts/ci/assert-vitest-green.mjs <result.json> [--min-tests=N]
//   Exit 0 → suite is verifiably green. Exit 1 → fail (with a [ci] reason line).
//
// The caller MUST `rm -f` the result file before the vitest run so a stale
// file from a prior run on a reused shell-executor host cannot be mistaken for
// the current run's result.

import { readFileSync } from 'node:fs';

const DEFAULT_MIN_TESTS = 5000;

/**
 * Verify a parsed vitest JSON result is a complete, all-passing run.
 * Pure function — returns { ok, reason, summary } and never throws or exits.
 * @param {unknown} result - parsed JSON (any shape; validated here)
 * @param {{ minTests?: number }} [opts]
 * @returns {{ ok: boolean, reason: string, summary: object }}
 */
export function verifyVitestResult(result, opts = {}) {
  const minTests = Number.isFinite(opts.minTests) ? opts.minTests : DEFAULT_MIN_TESTS;

  if (result === null || typeof result !== 'object') {
    return { ok: false, reason: 'result is not an object', summary: {} };
  }

  const numFailedTests = result.numFailedTests ?? null;
  const numFailedTestSuites = result.numFailedTestSuites ?? null;
  const numPassedTests = result.numPassedTests ?? null;
  const numTotalTests = result.numTotalTests ?? null;
  const success = result.success;

  const summary = { success, numPassedTests, numFailedTests, numFailedTestSuites, numTotalTests };

  // Shape guard: the required numeric fields must all be present. A partial /
  // truncated JSON (e.g. a half-written file) lacks them → fail closed.
  for (const [k, v] of Object.entries({ numFailedTests, numFailedTestSuites, numPassedTests, numTotalTests })) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, reason: `missing/invalid field "${k}" (truncated or wrong-shape JSON)`, summary };
    }
  }

  // Failed-count guards run BEFORE the generic success flag so a real failure
  // reports the actionable count ("12 failed test(s)") rather than the opaque
  // "success is false". success!==true with zero counts is a separate edge.
  if (numFailedTests > 0) {
    return { ok: false, reason: `${numFailedTests} failed test(s)`, summary };
  }
  if (numFailedTestSuites > 0) {
    return { ok: false, reason: `${numFailedTestSuites} failed test suite(s)`, summary };
  }
  if (success !== true) {
    return { ok: false, reason: `success is ${JSON.stringify(success)} (expected true)`, summary };
  }
  // Floor guard: a suspiciously small run signals a truncated/partial/empty
  // execution masquerading as green. The real suite is ~9870 tests.
  if (numTotalTests < minTests) {
    return {
      ok: false,
      reason: `only ${numTotalTests} total tests (< floor ${minTests}) — truncated or partial run`,
      summary,
    };
  }

  return { ok: true, reason: 'all tests passed', summary };
}

/**
 * Read + verify a vitest JSON result file. Fail-closed on any read/parse error.
 * @param {string} path
 * @param {{ minTests?: number }} [opts]
 * @returns {{ ok: boolean, reason: string, summary: object }}
 */
export function assertVitestGreenFile(path, opts = {}) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, reason: `cannot read result file "${path}": ${err.message}`, summary: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `result file "${path}" is not valid JSON: ${err.message}`, summary: {} };
  }
  return verifyVitestResult(parsed, opts);
}

function parseArgs(argv) {
  const positional = [];
  let minTests = DEFAULT_MIN_TESTS;
  for (const arg of argv) {
    const m = /^--min-tests=(\d+)$/.exec(arg);
    if (m) minTests = Number(m[1]);
    else positional.push(arg);
  }
  return { path: positional[0], minTests };
}

// CLI entry — only when run directly, not when imported by tests.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { path, minTests } = parseArgs(process.argv.slice(2));
  if (!path) {
    console.error('[ci] assert-vitest-green: missing <result.json> argument — failing closed');
    process.exit(1);
  }
  const { ok, reason, summary } = assertVitestGreenFile(path, { minTests });
  const s = summary || {};
  console.log(
    `[ci] vitest result: success=${s.success} passed=${s.numPassedTests} failed=${s.numFailedTests} ` +
      `failedSuites=${s.numFailedTestSuites} total=${s.numTotalTests} (floor=${minTests})`,
  );
  if (ok) {
    console.log(`[ci] ✓ suite verifiably green — ${reason}`);
    process.exit(0);
  }
  console.error(`[ci] ✗ FAIL-CLOSED: ${reason}`);
  process.exit(1);
}
