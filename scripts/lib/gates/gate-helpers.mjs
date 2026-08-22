/**
 * gate-helpers.mjs — Shared utility functions for quality-gate handlers.
 *
 * Pure ESM, Node stdlib only. Replaces gate-helpers.sh for .mjs gate scripts.
 *
 * Part of v3.2 shell-helper port migration (issue #218 / #317).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { detectStubCommand } from './echo-stub-detect.mjs';

const RUN_CHECK_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Internal pattern helpers
// ---------------------------------------------------------------------------

/** Test patterns that identify test/spec files. */
const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.test\.mjs$/,
  /\.spec\.[jt]sx?$/,
  /\.spec\.mjs$/,
  /__tests__\//,
];

/**
 * Returns true if the given file path matches a test-file pattern.
 * @param {string} filePath
 * @returns {boolean}
 */
function isTestFile(filePath) {
  return TEST_PATTERNS.some((re) => re.test(filePath));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Execute a shell command and return a structured result.
 *
 * `output` is a bounded TAIL for humans. `fullOutput` is the complete captured
 * text and is what every COUNT parse must read.
 *
 * Why both: the tail was 5 lines and was also the parser's input. Vitest prints
 * its `Test Files` / `Tests` summary and THEN the per-failure detail, so on any
 * real failure the summary sits hundreds of lines above the tail — measured
 * 2026-08-22: line 174 of 936. `extractTestCounts` then found nothing and the
 * gate reported `test: fail, total 0, passed 0, failed 0`, which reads as
 * "the runner never produced results" and hides WHICH test failed. An hour was
 * spent chasing that phantom before the real cause (one red test) was found.
 *
 * @param {string} cmd - Shell command to run, or `"skip"` / empty to skip.
 * @returns {{ status: 'pass'|'fail'|'skip', output: string, fullOutput: string, exitCode: number, stubbed?: { kind: 'echo'|'noop' } }}
 */
export function runCheck(cmd) {
  if (!cmd || cmd === 'skip') {
    return { status: 'skip', output: '', fullOutput: '', exitCode: 0 };
  }

  const stub = detectStubCommand(cmd);
  if (stub.isStub) {
    return { status: 'pass', output: `(stubbed: ${stub.kind})`, fullOutput: `(stubbed: ${stub.kind})`, exitCode: 0, stubbed: { kind: stub.kind } };
  }

  try {
    const raw = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: RUN_CHECK_MAX_BUFFER_BYTES,
    });
    const output = raw.split('\n').slice(-5).join('\n').trim();
    return { status: 'pass', output, fullOutput: raw, exitCode: 0 };
  } catch (err) {
    const exitCode = typeof err.status === 'number' ? err.status : 1;

    // Exit code 127 means command not found — treat as skip.
    if (exitCode === 127) {
      return { status: 'skip', output: 'command not found', fullOutput: '', exitCode };
    }

    const combined = [err.stdout ?? '', err.stderr ?? ''].join('\n');
    const output = combined.split('\n').slice(-5).join('\n').trim();
    return { status: 'fail', output, fullOutput: combined, exitCode };
  }
}

/**
 * Parse a comma-separated string into an array of trimmed, non-empty entries.
 *
 * @param {string} csv
 * @returns {string[]}
 */
export function csvToJsonArray(csv) {
  if (!csv || typeof csv !== 'string') return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Return the list of files changed between `ref` and HEAD.
 *
 * @param {string} ref - Git ref (commit hash, branch, tag). Returns [] if empty.
 * @returns {string[]}
 */
export function findChangedFiles(ref) {
  if (!ref || typeof ref !== 'string' || !ref.trim()) return [];
  try {
    const output = execSync(`git diff --name-only ${ref} HEAD`, {
      encoding: 'utf8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Return only the test/spec files from the set of changed files since `ref`.
 *
 * @param {string} ref - Git ref passed to {@link findChangedFiles}.
 * @returns {string[]}
 */
export function findChangedTestFiles(ref) {
  return findChangedFiles(ref).filter(isTestFile);
}

/**
 * Count the number of regex matches of `pattern` in `output`.
 *
 * @param {string} output
 * @param {string|RegExp} pattern
 * @returns {number}
 */
export function extractCount(output, pattern) {
  if (!output || !pattern) return 0;
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'gi');
  const matches = output.match(re);
  return matches ? matches.length : 0;
}

/**
 * Matches a runner summary line that reports TEST-CASE counts.
 *
 * Deliberately anchored on `Tests` + a word boundary so it matches vitest's
 * `      Tests  12904 passed | 11 skipped (12915)` and jest's
 * `Tests:       1 failed, 4 passed, 5 total`, but NOT vitest's preceding
 * `  Test Files  550 passed (550)` line ("Test" is not followed by "s").
 */
const TEST_SUMMARY_LINE = /^\s*Tests\b/;

/**
 * Parse test-runner output for pass/fail/total TEST-CASE counts.
 *
 * ## Which line is parsed
 *
 * Real vitest prints TWO `<N> passed` summary lines, files first:
 *
 * ```
 *  Test Files  550 passed (550)
 *       Tests  12904 passed | 11 skipped (12915)
 * ```
 *
 * A naive whole-output scan hits the FILE count (550) and publishes it as the
 * test count — the number then rides `gate-full.mjs`'s `test.passed` into the
 * `orchestrator.quality_gate.*` event stream looking authoritative. So: when a
 * `Tests`-anchored summary line exists, ONLY that line is parsed (the LAST one,
 * which is the final summary after any rerun). Terse or non-vitest output with
 * no such line falls back to scanning the whole string, which preserves the
 * bare `"42 passed"` / `"10 passed, 5 failed"` forms.
 *
 * ## What `total` means — passed + failed, NOT vitest's parenthesised number
 *
 * `total` is `passed + failed` and deliberately EXCLUDES skipped/todo tests.
 * This is load-bearing, not an oversight: `scripts/run-quality-gate.mjs`
 * reconstructs the third number from the published envelope as
 * `failed = total - passed`. Adopting vitest's parenthesised total (12915,
 * which counts the 11 skipped) would make that derivation report 11 phantom
 * FAILURES. `total` therefore answers "how many test cases produced a verdict",
 * and `total - passed === failed` holds by construction for every consumer.
 *
 * Skipped is not returned: neither call site (`gate-full.mjs`,
 * `quality-gate.mjs`) consumes it, and its only use would be to rebuild the
 * parenthesised total — precisely the number the downstream derivation must not
 * see. Add it together with a consumer, never ahead of one.
 *
 * @param {string} output - Captured test-runner stdout/stderr (or a tail of it).
 * @returns {{ passed: number, failed: number, total: number }} `total === passed + failed`.
 */
export function extractTestCounts(output) {
  if (!output) return { passed: 0, failed: 0, total: 0 };

  const summaryLines = output.split('\n').filter((line) => TEST_SUMMARY_LINE.test(line));
  const scope = summaryLines.length > 0 ? summaryLines[summaryLines.length - 1] : output;

  const passMatch = scope.match(/(\d+)\s+passed/);
  const failMatch = scope.match(/(\d+)\s+failed/);

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const total = passed + failed;

  return { passed, failed, total };
}

/**
 * Admit a suite-count triple, or refuse to claim a measurement.
 *
 * ## Why this exists (#967 item 2)
 *
 * Two functions used to write the `counts` field of the SAME
 * `orchestrator.quality_gate.*` event under DIFFERENT admission policies:
 * `suiteCountsFromGateStdout` (`scripts/run-quality-gate.mjs`) rejected
 * inconsistent triples, while `suiteCountsFromOutput` (`scripts/lib/quality-gate.mjs`)
 * admitted `passed > total` and a negative `passed`. A consumer therefore had to
 * know two policies to read one field. This is the single shared policy; both
 * callers keep only their own input adapter.
 *
 * ## Absent-not-null
 *
 * Returns `null` — NEVER a zero triple — for any unmeasured or inconsistent
 * input. `{passed: 0, failed: 0, total: 0}` would be indistinguishable from a
 * real all-skipped run and would publish a phantom measurement. Callers spread
 * the result so the field is OMITTED rather than zero-filled:
 *
 * ```js
 * const counts = admitSuiteCounts(raw);
 * await emitEvent(name, { ...(counts ? { counts } : {}) });
 * ```
 *
 * ## ONE channel for "the gate did not run" — a NULL `raw` (#969 MED-2)
 *
 * This function used to take a second `opts.measured` channel: `false` was an
 * unconditional refusal, meant to carry the caller's positional evidence that no
 * test gate ran. It was dead. Both adapters ALREADY convert that evidence to a
 * null `raw` before the policy sees it (`suiteCountsFromOutput` returns
 * `admitSuiteCounts(null)` for a null/empty output; the CLI's
 * `suiteCountsFromGateStdout` returns `null` from its own envelope checks and
 * never passed the opt at all), so no production path could ever reach here with
 * a non-null triple AND `measured: false` — only test rows exercised the flag.
 *
 * Keeping both was the real cost: "the gate did not run" was expressible two
 * ways and checked in two places, so a future caller could pass a real triple
 * with `measured: false`, or a STALE triple with `measured: true`, and the two
 * channels would disagree with the unverifiable boolean silently winning. A
 * null `raw` is the channel that survives because the policy must reject
 * non-objects anyway — it is structural, not an extra parameter, and it is
 * expressible by every caller including the one that never opted in.
 *
 * ## What stays with the CALLER (deliberately not absorbed)
 *
 * This function sees a candidate triple and nothing else. It performs no I/O and
 * reads no files. The following are per-caller INPUT ADAPTERS and must not
 * migrate here: JSON-envelope parsing; the `test`-object-vs-status-string
 * variant discrimination (non-full-gate variants emit a bare status string);
 * `test.status ∈ {pass, fail}`; the `parsed.stubbed?.test` short-circuit; the
 * raw-text tail parse ({@link extractTestCounts}); and the positional evidence
 * that the test gate ran at all — which each caller expresses by handing over
 * `null` rather than a triple.
 *
 * `failed` is accepted when the caller parsed one and DERIVED as `total - passed`
 * when it did not, so both the parsed-`failed` path and the derived-`failed` path
 * land on one consistency check (`passed + failed === total`).
 *
 * @param {{passed?: unknown, failed?: unknown, total?: unknown}|null|undefined} raw
 *   `null`/`undefined` is the caller's evidence that there is no measurement to
 *   admit (gate skipped, stub command, fail-fast before the test step, or no
 *   parseable count in the output).
 * @returns {{passed: number, failed: number, total: number}|null}
 */
export function admitSuiteCounts(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const { passed, total } = raw;
  if (!Number.isFinite(passed) || !Number.isFinite(total)) return null;

  const failed = Number.isFinite(raw.failed) ? raw.failed : total - passed;

  if (total <= 0) return null;
  if (passed < 0 || failed < 0) return null;
  // Redundant given the sum check below while `failed >= 0`, but kept explicit:
  // it is the check the looser of the two former policies was missing.
  if (passed > total) return null;
  if (passed + failed !== total) return null;

  return { passed, failed, total };
}

/**
 * Scan changed files (since `ref`) for debug artifacts: `console.log`, `debugger`, `TODO`, `FIXME`.
 *
 * @param {string} ref - Git ref. Returns [] if empty or no changed files.
 * @returns {Array<{ file: string, line: number, snippet: string }>}
 */
export function collectDebugArtifacts(ref) {
  if (!ref) return [];

  const changedFiles = findChangedFiles(ref);
  if (changedFiles.length === 0) return [];

  const DEBUG_PATTERN = /console\.log|debugger|TODO|FIXME/;
  const artifacts = [];

  for (const filePath of changedFiles) {
    let contents;
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch {
      // File may have been deleted; skip silently.
      continue;
    }

    const lines = contents.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (DEBUG_PATTERN.test(lines[i])) {
        artifacts.push({
          file: filePath,
          line: i + 1,
          snippet: lines[i].trim(),
        });
        if (artifacts.length >= 50) return artifacts;
      }
    }
  }

  return artifacts;
}

/**
 * Return lines from `output` that match `pattern`, each wrapped in an object.
 *
 * @param {string} output
 * @param {string|RegExp} pattern
 * @returns {Array<{ line: string }>}
 */
export function extractErrorLinesJson(output, pattern) {
  if (!output || !pattern) return [];
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return output
    .split('\n')
    .filter((l) => re.test(l))
    .slice(0, 20)
    .map((line) => ({ line }));
}

/**
 * Resolve the test-file list from either an explicit CSV or changed files since `startRef`.
 *
 * If `filesCsv` is non-empty, splits on commas and returns entries that match
 * test-file patterns. Otherwise delegates to {@link findChangedTestFiles}.
 *
 * @param {string} filesCsv  - Comma-separated list of explicit test files (may be empty).
 * @param {string} startRef  - Git ref used when `filesCsv` is absent.
 * @returns {string[]}
 */
export function resolveTestFiles(filesCsv, startRef) {
  if (filesCsv && filesCsv.trim()) {
    return csvToJsonArray(filesCsv).filter(isTestFile);
  }
  if (startRef && startRef.trim()) {
    return findChangedTestFiles(startRef);
  }
  return [];
}
