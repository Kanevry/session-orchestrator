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
//   node scripts/ci/assert-vitest-green.mjs <result.json> [--min-tests=N] [--log=<path>]
//   Exit 0 → suite is verifiably green. Exit 1 → fail (with a [ci] reason line).
//
// The caller MUST `rm -f` the result file before the vitest run so a stale
// file from a prior run on a reused shell-executor host cannot be mistaken for
// the current run's result.
//
// SELF-DIAGNOSING HANGS (--log):
//   When the result JSON is missing/unreadable — the runner-contention hang case
//   where vitest is killed before writing onFinished — an optional `--log=<path>`
//   pointing at the captured `--reporter=default` stdout lets the verifier name
//   the test files that were IN-FLIGHT at the kill (started with `❯ <file>` but
//   never reached a `✓`/`×` completion marker). This turns a bare ENOENT into an
//   actionable "these N files were running when the run died" hint. Purely
//   additive: absent `--log` (or an unreadable/uninformative log) falls back to
//   the existing bare message and the exit-code contract is unchanged.

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
  // execution masquerading as green. The real suite is ~12.1k tests (2026-07-17).
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

/**
 * Parse a captured vitest `--reporter=default` log and return the test files
 * that bear a `❯ <file>` lead glyph but never reached a per-file completion
 * marker (`✓ <file>` / `× <file>`). The intent is to surface the "in-flight at
 * kill" set — the files that were still running when the runner timed vitest
 * out — so a hang dump names the likely culprit.
 *
 * BEST-EFFORT — DOES NOT reliably mark in-progress files in CI. This is a known
 * limitation, not a bug:
 *   - The `❯ U+276F` glyph denotes "in-progress/queued" only on an INTERACTIVE
 *     TTY, where vitest live-updates the running-file list in place.
 *   - In non-TTY CI (`--reporter=default --no-color`, no live rewrite), `❯`
 *     instead marks FAILED files in the FINAL summary block — NOT in-progress.
 *     There is no per-file "started" line emitted mid-flight to key off.
 *   - Consequence: on a TRUE mid-flight hang (vitest killed before it writes the
 *     summary), there is often no `❯` line at all, so this hint returns [] —
 *     empty exactly when it would be most useful, and potentially misleading
 *     (matching a failed-summary file) when the run did reach the summary.
 *
 * A robust in-flight signal would need `--reporter=verbose` per-file START
 * lines (which DO emit mid-flight). Wiring that in is deferred to a follow-up:
 * it needs a captured real CI log to pin the exact start-line token format
 * before changing the regex. THIS FUNCTION'S PARSE LOGIC IS UNCHANGED — the
 * correction here is documentation-only.
 *
 * Pure function — never throws. Returns [] when the text is empty or no
 * matching files are detectable.
 *
 * Marker glyphs (vitest default reporter, --no-color):
 *   ✓ U+2713  per-file PASS completion
 *   × U+00D7  per-file FAIL completion
 *   ❯ U+276F  in-progress/queued on a TTY; FAILED-in-summary in non-TTY CI
 *             (see the BEST-EFFORT caveat above — the non-TTY meaning is why
 *              this hint can be empty/misleading on a real hang)
 *
 * @param {string} logText - raw captured reporter stdout
 * @returns {string[]} sorted list of candidate test file paths (deduped)
 */
export function inFlightFilesFromLog(logText) {
  if (typeof logText !== 'string' || logText.length === 0) return [];

  const started = new Set();
  const completed = new Set();

  // Lead glyph, optional indentation, then the file path up to a trailing
  // " (N tests…" annotation or end-of-line. The default reporter emits the
  // file path as the first token after the status glyph.
  const STARTED = /[❯>]\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/;
  const COMPLETED = /[✓×✗]\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/;

  // Defense-in-depth (security-review Q2 NICE): the captured path is later
  // printed to stderr in a CI log pane. `\S+` admits control/ESC bytes, so
  // strip C0 + DEL before they reach the terminal — a malicious vitest log
  // line cannot smuggle terminal-escape sequences through the hint.
  // eslint-disable-next-line no-control-regex -- intentional: neutralizing C0 + DEL is the whole point
  const stripCtrl = (s) => s.replace(/[\u0000-\u001f\u007f]/g, '?');

  for (const line of logText.split('\n')) {
    const c = COMPLETED.exec(line);
    if (c) {
      completed.add(stripCtrl(c[1]));
      continue;
    }
    const s = STARTED.exec(line);
    if (s) started.add(stripCtrl(s[1]));
  }

  const inFlight = [...started].filter((f) => !completed.has(f));
  return inFlight.sort();
}

/**
 * Read a log file and extract the in-flight set. Fail-soft: a missing or
 * unreadable log yields [] (the caller falls back to the bare message).
 * @param {string} path
 * @returns {string[]}
 */
export function inFlightFilesFromLogFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return inFlightFilesFromLog(raw);
}

function parseArgs(argv) {
  const positional = [];
  let minTests = DEFAULT_MIN_TESTS;
  let logPath = null;
  for (const arg of argv) {
    const m = /^--min-tests=(\d+)$/.exec(arg);
    const l = /^--log=(.+)$/.exec(arg);
    if (m) minTests = Number(m[1]);
    else if (l) logPath = l[1];
    else positional.push(arg);
  }
  return { path: positional[0], minTests, logPath };
}

// CLI entry — only when run directly, not when imported by tests.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { path, minTests, logPath } = parseArgs(process.argv.slice(2));
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
  // Self-diagnosing hint: the result JSON could not be READ (the hang case
  // where vitest was killed before writing it). When a --log is supplied,
  // surface the test files that were in-flight at the kill. This is purely an
  // enriched stderr message — the exit-1 contract is unchanged.
  if (logPath && reason.startsWith('cannot read result file')) {
    const inFlight = inFlightFilesFromLogFile(logPath);
    if (inFlight.length > 0) {
      console.error(
        `[ci] hint: ${inFlight.length} test file(s) in-flight when killed ` +
          `(likely hang/slowdown): ${inFlight.join(', ')}`,
      );
    }
  }
  process.exit(1);
}
