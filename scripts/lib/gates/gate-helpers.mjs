/**
 * gate-helpers.mjs — Shared utility functions for quality-gate handlers.
 *
 * Pure ESM, Node stdlib only. Replaces gate-helpers.sh for .mjs gate scripts.
 *
 * Part of v3.2 shell-helper port migration (issue #218 / #317).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_GATE_TIMEOUT_MS,
  buildCommandSignature,
  spawnInGroup,
} from '../process-group.mjs';
import { detectStubCommand } from './echo-stub-detect.mjs';

const RUN_CHECK_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Lines of captured output kept in the human-facing `output` tail. */
const OUTPUT_TAIL_LINES = 5;

/**
 * Name of the per-invocation override for the gate wall-clock ceiling.
 *
 * Read at CALL time, never at module load, so a test (or a caller that sets it
 * for one child) is not defeated by import order.
 *
 * Named ceiling (BV-004): this is an ENV var, and an env var is inherited by
 * every descendant — the exact shape that made `SO_GATE_LEDGER_ROOT` reach
 * every vitest worker on 2026-09-06 (`scripts/run-quality-gate.mjs`, the
 * `--ledger-root` block). It is acceptable here only because the value is a
 * CEILING every descendant should honour anyway. A future Session-Config
 * wiring of `gate.timeout-path-b-ms` should prefer the explicit `timeoutMs`
 * option below — which reaches exactly one call — over exporting this name.
 */
export const GATE_TIMEOUT_ENV = 'SO_GATE_TIMEOUT_MS';

/**
 * The wall-clock ceiling one gate command is allowed, in ms.
 *
 * Precedence: `process.env.SO_GATE_TIMEOUT_MS` when set to a finite positive
 * number, else {@link DEFAULT_GATE_TIMEOUT_MS} (900_000 — the PRD's
 * `gate.timeout-path-b-ms`, deliberately the same 15 min the synchronous
 * path A already had, so both gate paths are allowed exactly as long).
 *
 * A non-numeric or non-positive value is IGNORED rather than honoured: a typo
 * that parsed as 0 would disable the cap, which is the failure this whole
 * change exists to remove.
 *
 * @returns {number} positive milliseconds
 */
export function resolveGateTimeoutMs() {
  const raw = (process.env[GATE_TIMEOUT_ENV] || '').trim();
  if (!raw) return DEFAULT_GATE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GATE_TIMEOUT_MS;
  return parsed;
}

/**
 * Last {@link OUTPUT_TAIL_LINES} lines of a captured text, trimmed.
 *
 * @param {string} text
 * @returns {string}
 */
function tailOf(text) {
  return String(text ?? '').split('\n').slice(-OUTPUT_TAIL_LINES).join('\n').trim();
}

/**
 * The one line a timed-out gate command MUST carry.
 *
 * A timeout is a FAILURE with a name, never a silent `fail`: without this line
 * a killed command is indistinguishable in the envelope from a command that
 * exited non-zero on its own, and the operator has nothing to act on. It names
 * the ceiling that fired, the process GROUP that was signalled, the ladder that
 * ran, and — the part an exit code can never carry — anything that SURVIVED
 * SIGKILL (PRD B6: a sent signal proves nothing).
 *
 * @param {number} timeoutMs
 * @param {{pgid: number, killSignals: string[], survivors: number[]}} run
 * @returns {string}
 */
function timeoutLine(timeoutMs, run) {
  const ladder = (run.killSignals ?? []).join('\u2192') || 'no signal sent';
  return `gate: TIMEOUT after ${timeoutMs} ms \u2014 process group ${run.pgid} ${ladder}, `
    + `survivors: [${(run.survivors ?? []).join(', ')}]`;
}

/**
 * The stdout envelope `scripts/run-quality-gate.mjs` publishes when the GATE
 * SUB-SCRIPT itself was killed on the wall-clock ceiling.
 *
 * Lives here, beside the other envelope helpers, because the CLI that consumes
 * it is a top-level script with no exports — a pure function there would be
 * untestable without executing the CLI.
 *
 * Deliberately carries no `test`/`typecheck`/`lint` object: a killed gate
 * measured nothing, and `suiteCountsFromGateStdout` must return `null` for it
 * (absent is not zero). `error: 'gate-timeout'` is the machine-readable
 * discriminator; the exit code is 124, the same value `spawnInGroup` reports
 * and the same one coreutils `timeout(1)` uses.
 *
 * @param {object} args
 * @param {string} args.variant  The `--variant` value the run was started with.
 * @param {number} args.timeoutMs  Ceiling that fired.
 * @param {{pgid: number, durationMs: number, killSignals: string[], survivors: number[]}} args.run
 *   The {@link spawnInGroup} result.
 * @returns {{variant: string, error: 'gate-timeout', timeout_ms: number, duration_ms: number,
 *   pgid: number, kill_signals: string[], survivors: number[]}}
 */
export function gateTimeoutEnvelope({ variant, timeoutMs, run }) {
  return {
    variant,
    error: 'gate-timeout',
    timeout_ms: timeoutMs,
    duration_ms: run?.durationMs ?? 0,
    pgid: run?.pgid ?? -1,
    kill_signals: run?.killSignals ?? [],
    survivors: run?.survivors ?? [],
  };
}

/**
 * Decide WHAT a finished gate sub-script run publishes — stdout, stderr,
 * exit code and operator warnings — without performing any of the writes.
 *
 * ## Why this is a pure function and not four `process.*.write` calls
 *
 * The timeout branch in `scripts/run-quality-gate.mjs` was unreachable by any
 * test: reaching it required a REAL gate sub-script to exceed
 * `resolveGateTimeoutMs() + GATE_OUTER_TIMEOUT_RESERVE_MS` (15 min + 60 s, a
 * hard constant with no injection seam), so the four decisions it makes —
 * suppress the partial capture on stdout, re-publish it on stderr, emit ONE
 * complete `gate-timeout` envelope, warn about survivors — were pinned by
 * nothing. The CLI now decides here and only WRITES there, so each decision is
 * testable against a synthetic {@link spawnInGroup} result.
 *
 * ## The one-document contract on stdout
 *
 * A killed child never wrote its envelope, so its capture is at best a partial
 * JSON document. Publishing that hands every stdout consumer a parse error
 * where a named failure belongs; publishing BOTH the partial text and an
 * envelope breaks the "one JSON document" contract. Hence: capture → stderr,
 * envelope → stdout, and `stdout` carries EXACTLY the envelope line.
 *
 * @param {object} args
 * @param {{fullOutput?: string, exitCode?: number, timedOut?: boolean, pgid?: number,
 *   durationMs?: number, killSignals?: string[], survivors?: number[]}} args.result
 *   The {@link spawnInGroup} result for the gate sub-script.
 * @param {string} args.variant  The `--variant` value the run was started with.
 * @param {number} args.timeoutMs  The OUTER ceiling that applied to the sub-script.
 * @returns {{stdout: string, stderr: string, exitCode: number, warnings: string[]}}
 *   `stdout`/`stderr` are written verbatim (empty string = write nothing);
 *   `warnings` go through the caller's `warn()`; `exitCode` is the gate's own,
 *   which `spawnInGroup` reports as 124 on the timeout path.
 */
export function publishGateOutcome({ result, variant, timeoutMs }) {
  const capture = String(result?.fullOutput ?? '');
  const exitCode = result?.exitCode ?? 0;

  if (!result?.timedOut) {
    return { stdout: capture, stderr: '', exitCode, warnings: [] };
  }

  const survivors = result.survivors ?? [];
  return {
    stdout: `${JSON.stringify(gateTimeoutEnvelope({ variant, timeoutMs, run: result }))}\n`,
    stderr: capture.trim()
      ? `\n\u2500\u2500\u2500\u2500 gate TIMED OUT \u2014 captured output before the kill \u2500\u2500\u2500\u2500\n${capture}\n\u2500\u2500\u2500\u2500 end \u2500\u2500\u2500\u2500\n`
      : '',
    exitCode,
    warnings: survivors.length > 0
      ? [`gate process group ${result.pgid} left survivors after SIGKILL: ${survivors.join(', ')}`]
      : [],
  };
}

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
 * Execute a shell command as the LEADER OF ITS OWN PROCESS GROUP, under a
 * wall-clock ceiling, and return a structured result.
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
 * ## Why a process group, and why a timeout (Epic #1425 A3)
 *
 * This used to be `execSync(cmd, { maxBuffer })` — no timeout at all, and the
 * shell as the only signalled process. On 2026-09-20 four `tsgo --noEmit`
 * grandchildren of gate runs outlived their parents at PPID 1 with up to 8.0 GB
 * RSS each and took the host to 13 % free memory. {@link spawnInGroup} spawns
 * `detached`, so `process.kill(-pgid, …)` reaches every descendant, and it runs
 * the SIGTERM→grace→SIGKILL ladder with a read-back verification.
 *
 * ## What changed for callers
 *
 * 1. It is ASYNC. Every call site must `await`.
 * 2. `fullOutput` now interleaves stdout AND stderr on the PASS path too
 *    (`execSync` discarded stderr when the command succeeded). A runner that
 *    prints its summary to stderr is therefore no longer invisible to
 *    {@link extractTestCounts}.
 * 3. Three fields are added — `timedOut`, `killSignals`, `survivors` — and they
 *    are present ONLY when a process actually ran. A skipped or stubbed command
 *    spawned nothing, so it carries no `timedOut: false`: absent is not a
 *    measured false, the same contract `counts` and `files` already keep.
 *
 * A timeout is a REPORTED failure: `status: 'fail'`, `exitCode: 124`, and a
 * `gate: TIMEOUT after …` line appended to `output`/`fullOutput` naming the
 * ceiling, the group, the signal ladder and any survivor. It is never a silent
 * `fail`.
 *
 * @param {string} cmd - Shell command to run, or `"skip"` / empty to skip.
 * @param {object} [opts] - Forwarded verbatim to {@link spawnInGroup}, and it
 *   OVERRIDES the defaults below (`timeoutMs`, `maxOutputBytes`, `repoRoot`,
 *   `commandSignature`). This is also the seam tests inject `spawnFn` /
 *   `killFn` / `isAliveFn` through.
 * @param {number|null} [opts.timeoutMs] - Wall-clock ceiling; defaults to
 *   {@link resolveGateTimeoutMs} (`SO_GATE_TIMEOUT_MS` or 900_000). `null`
 *   disables the clock — the byte cap still applies.
 * @param {string} [opts.repoRoot] - Root whose gate-process ledger the spawn is
 *   recorded in; defaults to `process.cwd()`, which is the tree under test.
 * @returns {Promise<{ status: 'pass'|'fail'|'skip', output: string, fullOutput: string,
 *   exitCode: number, timedOut?: boolean, killSignals?: string[], survivors?: number[],
 *   stubbed?: { kind: 'echo'|'noop' } }>}
 */
export async function runCheck(cmd, opts = {}) {
  if (!cmd || cmd === 'skip') {
    return { status: 'skip', output: '', fullOutput: '', exitCode: 0 };
  }

  const stub = detectStubCommand(cmd);
  if (stub.isStub) {
    return { status: 'pass', output: `(stubbed: ${stub.kind})`, fullOutput: `(stubbed: ${stub.kind})`, exitCode: 0, stubbed: { kind: stub.kind } };
  }

  const timeoutMs = opts.timeoutMs === undefined ? resolveGateTimeoutMs() : opts.timeoutMs;
  const run = await spawnInGroup(cmd, {
    maxOutputBytes: RUN_CHECK_MAX_BUFFER_BYTES,
    repoRoot: process.cwd(),
    commandSignature: buildCommandSignature(cmd),
    ...opts,
    timeoutMs,
  });

  // Reported in every returned shape below, so a consumer never has to ask a
  // second question to learn whether the group is actually gone.
  const groupFields = { killSignals: run.killSignals, survivors: run.survivors };

  if (run.timedOut) {
    const fullOutput = `${run.fullOutput}\n${timeoutLine(timeoutMs, run)}\n`;
    return {
      status: 'fail',
      output: tailOf(fullOutput),
      fullOutput,
      exitCode: run.exitCode,
      timedOut: true,
      ...groupFields,
    };
  }

  // Exit code 127 means command not found — treat as skip.
  if (run.exitCode === 127) {
    return { status: 'skip', output: 'command not found', fullOutput: '', exitCode: 127, timedOut: false, ...groupFields };
  }

  return {
    status: run.exitCode === 0 ? 'pass' : 'fail',
    output: tailOf(run.fullOutput),
    fullOutput: run.fullOutput,
    exitCode: run.exitCode,
    timedOut: false,
    ...groupFields,
  };
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
 * Matches vitest's FILE-level summary line (`Test Files  8 failed | 595 passed (603)`).
 *
 * Distinct from {@link TEST_SUMMARY_LINE} (the TEST-CASE line, `Tests  ...`): a
 * suite that dies at import time is counted HERE, and the `Tests` line then
 * carries no `N failed` segment at all (#1149) — vitest omits it whenever zero
 * individual test cases ran. Last matching line wins (the final summary after
 * any rerun), mirroring `TEST_SUMMARY_LINE`'s own convention.
 */
const TEST_FILES_SUMMARY_LINE = /^\s*Test Files\b/;

/**
 * Parse a `<N> passed` / `<N> failed` pair out of one summary line/scope.
 * `total` is their sum (skipped excluded) — the same rule the top-level
 * test-case triple in {@link extractTestCounts} publishes.
 *
 * @param {string} scope
 * @returns {{ passed: number, failed: number, total: number }}
 */
function parseCountTriple(scope) {
  const passMatch = scope.match(/(\d+)\s+passed/);
  const failMatch = scope.match(/(\d+)\s+failed/);
  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  return { passed, failed, total: passed + failed };
}

/**
 * Parse test-runner output for pass/fail/total TEST-CASE counts, plus the
 * vitest FILE-level triple when a `Test Files` summary line is present.
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
 * `Tests`-anchored summary line exists, ONLY that line is parsed for the
 * test-case triple (the LAST one, which is the final summary after any
 * rerun). Terse or non-vitest output with no such line falls back to scanning
 * the whole string, which preserves the bare `"42 passed"` / `"10 passed, 5
 * failed"` forms.
 *
 * The `Test Files` line is parsed the same way, into a SEPARATE nested `files`
 * triple — never folded into `failed`/`total`. `total === passed + failed` is
 * load-bearing for the test-case triple (`admitSuiteCounts`, and historically
 * `failed = total - passed` in `run-quality-gate.mjs`); mixing file counts in
 * would either break that invariant or invent phantom test-case failures. A
 * suite that dies at import is invisible on the `Tests` line (vitest omits
 * `N failed` there when zero test cases ran) and visible only on `Test
 * Files` — #1149, measured as
 * `{"test":{"status":"fail","total":14671,"passed":14671,"failed":0}}`, with
 * no field anywhere naming the 8 files that actually died.
 * `gate-full.mjs` derives a `suite_died` boolean from `files.failed` for
 * exactly this shape.
 *
 * ## `files` is NULL when no `Test Files` line was seen — never a zero triple
 *
 * Only vitest prints that line. A non-vitest runner, a terse reporter, or a
 * fail-fast crash produces output with no file-level summary at all, and the
 * function used to publish `files_total/passed/failed: 0` there — an UNMEASURED
 * zero, byte-identical in the envelope to a measured one, from which
 * `gate-full.mjs` then derived `suite_died: false` as if it had checked. That is
 * the same "absent is not zero" defect `admitSuiteCounts` exists to prevent one
 * field over, so it uses the same channel: `null` means "no file-level
 * measurement", and the caller OMITS the keys rather than zero-filling them.
 * The test-case triple keeps its zeros — those are the caller's fallback, not a
 * parse result, and `total: 0` is already the "no counts" signal
 * `admitSuiteCounts` rejects.
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
 * @returns {{ passed: number, failed: number, total: number, files: {passed: number, failed: number, total: number}|null }}
 *   Test-case `total === passed + failed`. `files` is `null` when the output
 *   carried no `Test Files` summary line; when present,
 *   `files.total === files.passed + files.failed`.
 */
export function extractTestCounts(output) {
  const EMPTY = { passed: 0, failed: 0, total: 0, files: null };
  if (!output) return EMPTY;

  const lines = output.split('\n');
  const summaryLines = lines.filter((line) => TEST_SUMMARY_LINE.test(line));
  const scope = summaryLines.length > 0 ? summaryLines[summaryLines.length - 1] : output;
  const { passed, failed, total } = parseCountTriple(scope);

  const fileSummaryLines = lines.filter((line) => TEST_FILES_SUMMARY_LINE.test(line));
  const fileScope = fileSummaryLines.length > 0 ? fileSummaryLines[fileSummaryLines.length - 1] : '';
  // No `Test Files` line → NOT MEASURED. See the docstring section above: a zero
  // triple here would be indistinguishable from a real all-passed-zero-files run.
  const files = fileScope ? parseCountTriple(fileScope) : null;

  return { passed, failed, total, files };
}

/**
 * ANSI SGR / CSI escapes vitest emits when it believes it writes to a TTY.
 * `runCheck` captures through a pipe, where vitest disables colour — but a
 * runner invoked through a pty wrapper, or with `FORCE_COLOR`, still colours
 * its output and would defeat every anchored match below.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Path shape of a test/spec file, as printed by vitest/jest. */
const TEST_FILE_PATH = String.raw`[^\s()]+\.(?:test|spec)\.[cm]?[jt]sx?`;

/**
 * `FAIL <path>` — printed once per failing FILE in the "Failed Tests" and
 * "Failed Suites" sections. Two real shapes, both covered by this anchor
 * (measured against vitest 4.1.5, 2026-09-06):
 *
 *   ` FAIL  dead.test.mjs [ dead.test.mjs ]`      ← suite died at import
 *   ` FAIL  red.test.mjs > red > fails`           ← a test case failed
 */
const FAIL_LINE = new RegExp(String.raw`^\s*FAIL\s+(${TEST_FILE_PATH})(?:\s|$)`);

/**
 * `❯ <path> (N tests | M failed)` — the per-file line of the run summary.
 *
 * The `(… | … failed)` group is load-bearing, NOT decoration: vitest prefixes
 * STACK FRAMES with the same `❯` and the frame carries the same file name
 * (` ❯ red.test.mjs:3:33`). Requiring the parenthesised counts is what keeps a
 * frame — and a PASSING file's summary line, ` ❯ green.test.mjs (2 tests)` —
 * out of the result.
 */
const FILE_SUMMARY_FAIL_LINE = new RegExp(
  String.raw`^\s*❯\s+(${TEST_FILE_PATH})\s+\(\d+\s+tests?[^)]*\|\s*\d+\s+failed`,
);

/**
 * Name the test FILES a failing run blamed — the one thing the gate envelope
 * never carried.
 *
 * Measured 2026-09-06: a husky pre-push run blocked `git push origin main` with
 * `{"test":{"status":"fail","total":16417,"passed":16415,"failed":2,
 * "files_total":662,"files_passed":661,"files_failed":1,…}}` — a COUNT and no
 * name. `files_failed: 1` says a file died; reconstructing WHICH one cost a
 * full manual re-materialisation of the tracked tree, even though the runner
 * had printed the path in the very output this envelope was built from.
 *
 * Order is first-appearance and duplicates are dropped: vitest names the same
 * file on its summary line AND once per failing case inside it, so a raw match
 * list would repeat one path N times and read as N failing files.
 *
 * Absolute paths are relativised against `cwd` when it is a prefix — a gate
 * report is read next to `git status`, so a repo-relative path is the useful
 * form. A path outside `cwd` is left verbatim rather than turned into a `../..`
 * chain that names nothing an operator can act on.
 *
 * @param {string} output - Captured test-runner stdout/stderr.
 * @param {string} [cwd=process.cwd()] - Root to relativise absolute paths against.
 * @returns {string[]} De-duplicated file paths, in first-appearance order.
 */
export function extractFailedTestFiles(output, cwd = process.cwd()) {
  if (!output || typeof output !== 'string') return [];

  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
  const seen = new Set();

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(ANSI_ESCAPE, '');
    const match = FAIL_LINE.exec(line) ?? FILE_SUMMARY_FAIL_LINE.exec(line);
    if (!match) continue;
    const file = match[1].startsWith(prefix) ? match[1].slice(prefix.length) : match[1];
    seen.add(file);
  }

  return [...seen];
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
