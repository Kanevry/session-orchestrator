/**
 * ci-status-banner.mjs — #369
 * Checks CI status for the current HEAD commit and returns a structured
 * result for session-start Phase 4 banner rendering.
 *
 * Plain-JS — no Zod dependency. Never throws.
 *
 * THREE return states (#1031), not two:
 *   - `null`                     — read, and there is nothing to report (a
 *                                  benign ABSENCE: no VCS remote, no pipeline
 *                                  worth a banner, green with no soft failures)
 *   - `{status, ok, details, …}` — a real CI reading (`green` | `red` |
 *                                  `unknown`)
 *   - `{severity, message, degraded, ok:false}` — the state could NOT be read.
 *     `degraded` is a member of the frozen {@link DEGRADED_REASONS} enum
 *     exported below. This must NEVER be read as "CI is green".
 *
 * Until #1031 every unreadable state collapsed onto `null`, which in the banner
 * contract reads as all-clear — the exact confusion #1022 (`gh repo view -R` →
 * `unknown shorthand flag`) hid behind on every GitHub repo. The shape is the
 * one `scripts/lib/mirror-issues-banner.mjs` established.
 *
 * Supports GitLab (via glab) and GitHub (via gh).
 * VCS is auto-detected from the repo's git remotes via
 * `vcs-repo-spec.mjs`'s `detectVcsFamily` — NOT from a hard-coded `origin`
 * lookup, which left the banner structurally dark in every repo whose remotes
 * are named `gitlab`/`github` (#1039).
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  resolveRepoSpec,
  resolveRepoHost,
  resolveGitlabProjectTarget,
  redactUrlCredentials,
  detectVcsFamily,
  isQueryFailure,
} from './vcs-repo-spec.mjs';

const execFileAsync = promisify(_execFile);

/** Default timeout in milliseconds for CLI invocations. */
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Closed set of `degraded` reasons (#1031). A degraded result means "the CI
 * state was NOT successfully read" — never "CI is green".
 *
 * Deliberately THIS module's own enum rather than a merged one shared with
 * `mirror-issues-banner.mjs` / `git-config-drift.mjs`: those two already carry
 * DIFFERENT member sets for their own failure surfaces, and a merged superset
 * would hand every consumer members its probe can never emit — an enum whose
 * members are not exhaustively reachable cannot be switched on exhaustively,
 * which is the only reason to freeze one. The members here are exactly what
 * this probe can fail at:
 *
 *   - `cli-missing`  a required binary (`git`, `glab`, `gh`) is not on PATH.
 *   - `timeout`      a subprocess outlived its budget. Not silent since #1031:
 *                    a hang is not actionable, but "state unknown" IS the
 *                    finding, and silence renders identically to green.
 *   - `parse-error`  a CLI answered with output this module could not read
 *                    (unparseable JSON, or valid JSON of the wrong shape).
 *   - `query-failed` residual bucket — a present CLI ran and rejected the
 *                    invocation, or a resolvable remote whose API target could
 *                    not be derived. Folding these into `parse-error` would
 *                    mislabel a rejected flag as malformed output.
 *   - `git-error`    the VCS probe itself failed (`git remote -v` non-zero for
 *                    a reason other than "not a work tree"). Distinct from
 *                    `query-failed` because it means the module never got as
 *                    far as choosing a CI platform.
 *
 * @type {readonly ['cli-missing','timeout','parse-error','query-failed','git-error']}
 */
export const DEGRADED_REASONS = Object.freeze([
  'cli-missing',
  'timeout',
  'parse-error',
  'query-failed',
  'git-error',
]);

/**
 * Build the third return state. Distinct from `null` on purpose: `null` in the
 * banner contract reads as "all clear", which a failed read has NOT
 * established.
 *
 * The `detail` is appended bounded (BV-004: 200 chars — long enough for a
 * `Command failed: <argv>` first line, short enough not to bury the
 * session-start banner it prints beside; revisit if a CLI starts emitting a
 * diagnostic that needs more). Callers pass ALREADY-redacted text — every
 * source here is either a fixed string or a `redactUrlCredentials` result.
 *
 * @param {'cli-missing'|'timeout'|'parse-error'|'query-failed'|'git-error'} reason
 * @param {string} [detail]  Optional, already-redacted diagnostic tail
 * @returns {{ severity: 'warn', ok: false, message: string, degraded: string }}
 */
function degradedResult(reason, detail) {
  // Redaction (the callers' job) and control-byte escaping are DIFFERENT
  // protections: `redactUrlCredentials` removes secrets, it does not neutralise
  // ANSI/CR. `parseCliJson` already escapes the text it embeds (see the call at
  // the JSON.parse catch), but the degraded tail reaches the operator's terminal
  // by a second route — a CLI stderr quoted into `err.message` — and skipped it.
  // Escape here so BOTH routes are covered at their common exit. Slice first,
  // escape after: the budget is 200 chars of DETAIL, and escaping cannot then
  // leave a cut mid-`\uXXXX`.
  const tail = detail ? ` — ${escapeControlBytes(String(detail).trim().slice(0, 200))}` : '';
  return {
    severity: 'warn',
    ok: false,
    message:
      `⚠ ci-status: CI status for HEAD could not be determined (${reason}) — ` +
      `state UNKNOWN, not "green".${tail}`,
    degraded: reason,
  };
}

/**
 * Wraps execFile with a per-call timeout race.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, execFile?: Function }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function execWithTimeout(cmd, args, opts = {}) {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, execFile = execFileAsync } = opts;
  return Promise.race([
    execFile(cmd, args, { cwd, env: process.env }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs),
    ),
  ]);
}

/** C0 controls plus DEL — matching them is the POINT, hence the disable. */
// eslint-disable-next-line no-control-regex
const CONTROL_BYTE_RE = /[\u0000-\u001f\u007f]/g;

/**
 * Replace every C0/DEL control byte with its printable `\uXXXX` escape.
 *
 * `JSON.stringify` covers the payload preview, but NOT `SyntaxError.message` —
 * V8 quotes the offending input INTO that message verbatim, so an ANSI/CR
 * payload reached the operator's terminal through the error text even after
 * the preview was escaped. Both halves go through here.
 *
 * @param {unknown} text
 * @returns {string}
 */
function escapeControlBytes(text) {
  return String(text).replace(
    CONTROL_BYTE_RE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Name a parsed JSON value's type WITHOUT quoting any of its content.
 *
 * @param {unknown} value
 * @returns {'null'|'array'|'object'|'string'|'number'|'boolean'|'undefined'}
 */
function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return /** @type {any} */ (typeof value);
}

/**
 * Parse CLI stdout as JSON, degrading an unparseable payload onto this module's
 * documented failure channel instead of a bare `SyntaxError` (CWE-502).
 *
 * The throw IS that channel, not an escape from it: every call site runs under
 * `checkCiStatus`'s outer catch, whose comment already names "unparseable
 * output" as a case it converts to `console.warn` + `null`. Measured
 * 2026-08-28 at 30940cb, BEFORE this helper existed: an HTML login page from
 * `gh repo view`, a literal `null`, and an empty `glab` stdout ALL already
 * returned `null` with a warn — nothing crashed, and
 * `tests/lib/ci-status-banner.test.mjs` § "error containment" pinned it. So
 * this does not fix a crash — the outer catch already turned non-JSON output
 * into a warn + `null`. The rule this helper closes is lexical
 * (`json-parse-untrusted-input`, see below), not a crash it prevents.
 *
 * What it does fix is the message. The raw parse error (`Unexpected token
 * '<'`) named neither the CLI nor the request, and this banner spawns four
 * different subprocesses — an operator reading that line at session-start
 * could not tell which one returned garbage, which is the same
 * "could not read looks like nothing to report" class #1022/#1039 attacked.
 * Guarding at the parse also satisfies the `json-parse-untrusted-input` rule,
 * which keys on a LEXICALLY enclosing try/catch and cannot see the outer one.
 *
 * Ceiling (BV-004): the payload preview is clamped to 120 characters. An
 * unbounded one would bury the session-start banner it is printed beside — a
 * paginated HTML error page is the realistic worst case. Revisit if a CLI
 * starts emitting a diagnostic that needs more than one line to identify.
 *
 * The preview is emitted through `JSON.stringify`, not raw. It comes from a
 * subprocess whose stdout this module does not control and lands in a
 * `console.warn` beside the session-start banner: a payload carrying ANSI
 * escapes, a `\r`, or a bare newline could otherwise repaint or overwrite the
 * lines around it. `JSON.stringify` escapes every control byte and quotes the
 * result, so the preview stays exactly one line of printable text.
 *
 * `expect` closes the second half of the same gap: valid JSON of the WRONG
 * SHAPE parsed fine and escaped this named channel entirely. Measured
 * 2026-08-28 at 7daa3d2 — a `gh repo view` that printed `null` reached
 * `const { nameWithOwner } = …` and threw a bare
 * `TypeError: Cannot destructure property 'nameWithOwner' of 'null'`, which
 * names neither the CLI nor the request; a `glab api …/pipelines` that printed
 * `null` was swallowed by `!Array.isArray(pipelines) → return null`, silent.
 * Both now fail as the SAME named error the parse failure produces.
 *
 * @param {string} stdout  Raw child-process stdout (untrusted)
 * @param {string} label   The command that produced it, for the failure message
 * @param {'object'|'array'} [expect]  Required shape; omit to accept any JSON
 * @returns {unknown} The parsed value
 * @throws {Error} Named parse/shape failure carrying a bounded payload preview
 */
function parseCliJson(stdout, label, expect) {
  const raw = String(stdout ?? '');
  // Bounded (BV-004: 120 chars — a paginated HTML error page is the realistic
  // worst case) AND escaped, so it can never break the line it is printed on.
  const preview = raw.trim().slice(0, 120);
  const shown = preview
    ? `got: ${escapeControlBytes(JSON.stringify(preview))}`
    : 'got: (empty stdout)';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = escapeControlBytes(err instanceof Error ? err.message : String(err));
    // `cause` preserves the original for a debugger; the reason is ALSO
    // inlined into the message because the outer catch reads `err.message`
    // only — a cause-only wrapper would lose it on the operator-facing line.
    throw tagParseError(new Error(
      `${label} returned unparseable JSON (${reason}) — ${shown}`,
      { cause: err },
    ));
  }

  // A shape mismatch reports the JSON TYPE, never the payload. The parse
  // succeeded, so the bytes add nothing an operator can act on — and
  // `tests/lib/ci-status-banner.test.mjs` § "unexpected benign pipeline
  // metadata" pins that a well-formed-but-wrong-shaped API body must not have
  // its contents echoed anywhere. A type name carries no body content.
  const actual = jsonTypeOf(parsed);
  if (expect === 'array' && actual !== 'array') {
    throw tagParseError(new Error(`${label} returned JSON of an unexpected shape — expected an array, got ${actual}`));
  }
  if (expect === 'object' && actual !== 'object') {
    throw tagParseError(new Error(`${label} returned JSON of an unexpected shape — expected an object, got ${actual}`));
  }
  return parsed;
}

/**
 * Stamp the `parse-error` degraded reason onto an error raised by
 * {@link parseCliJson}.
 *
 * Carried on the error object rather than re-derived from its message text in
 * the outer catch: a message-substring test would silently reclassify the
 * moment a wording changes, and the two failures (`unparseable JSON`, wrong
 * shape) are one class only because THIS function says so.
 *
 * @param {Error} err
 * @returns {Error}
 */
function tagParseError(err) {
  return Object.assign(err, { degradedReason: 'parse-error' });
}

/**
 * The one failure this probe can produce that the frozen
 * `REMOTE_RESOLUTION_REASONS` set has no member for: the async timeout race
 * every subprocess here runs under has no counterpart in the SYNCHRONOUS
 * `vcs-repo-spec.mjs` core (it uses `execFileSync`, which cannot time out).
 *
 * Deliberately NOT a query-failure for WARNING purposes — a timeout emits no
 * `console.warn`, matching how `checkCiStatus`'s outer catch has always
 * treated one, and warning on a hung `git` but not on a hung `glab` would be
 * an inconsistency inside a single banner.
 *
 * It is no longer SILENT, though (#1031). The old argument — "a hang is not a
 * fact an operator can act on the way 'git is not installed' is" — is
 * superseded: what the operator acts on is not the hang, it is that CI state
 * is UNKNOWN, and returning `null` rendered that identically to green. A
 * timeout therefore yields `degradedResult('timeout')` on both this path and
 * the outer catch.
 */
const PROBE_TIMEOUT = 'probe-timeout';

/**
 * The ONE `isQueryFailure` member this banner deliberately keeps silent.
 *
 * `vcs-repo-spec.mjs` classifies `not-a-git-repo` as a query failure, and that
 * is correct IN ITS DOMAIN: a remote-resolution helper genuinely could not
 * enumerate remotes. For THIS consumer the same fact is a benign absence —
 * session-start Phase 4 asking a non-repo directory about its CI has a complete
 * and unsurprising answer ("there is no CI here"), and an operator cannot act on
 * being told their directory is not a git repo. Warning would print on every
 * such session-start and train exactly the reflex that makes the
 * `git-unavailable` / `git-error` lines worthless.
 *
 * Expressed as a SUBTRACTION from `isQueryFailure` rather than as a hard-coded
 * warn-list, so a reason added to the frozen set upstream is warned by default
 * (fail-toward-visible) instead of silently inheriting the benign path.
 *
 * @type {ReadonlySet<string>}
 */
const SILENT_QUERY_FAILURES = new Set(['not-a-git-repo']);

/**
 * Project a `REMOTE_RESOLUTION_REASONS` query failure onto this module's own
 * {@link DEGRADED_REASONS} member.
 *
 * Written as explicit branches rather than a lookup table so that EVERY reason
 * literal this module can emit sits inside a literal call to the builder
 * call — which is what makes the enum-membership census in
 * `tests/lib/ci-status-banner.test.mjs` a regex over the source instead of a
 * hand-typed list that drifts.
 *
 * The fallthrough is `query-failed`, not a throw: a reason added to the frozen
 * upstream set must degrade visibly (fail-toward-visible), never crash the
 * probe or slip back onto the silent path.
 *
 * @param {string} reason
 * @param {string} [detail]  Already-redacted git stderr
 * @returns {{ severity: 'warn', ok: false, message: string, degraded: string }}
 */
function degradedForVcsReason(reason, detail) {
  // git itself is a CLI, and "not on PATH" is the same fact for it as for
  // glab/gh — one member, not two spellings of it.
  if (reason === 'git-unavailable') return degradedResult('cli-missing', detail);
  if (reason === 'git-error') return degradedResult('git-error', detail);
  return degradedResult('query-failed', detail);
}

/**
 * Classify a rejected ASYNC `execFile` into a `REMOTE_RESOLUTION_REASONS`
 * member.
 *
 * This cannot reuse `vcs-repo-spec.mjs`'s own (unexported) `classifyGitFailure`
 * because that one reads an `execFileSync` result, where the spawn errno lands
 * in `err.code` and the child's exit status in `err.status`. Async `execFile`
 * folds BOTH into `err.code`, discriminated only by TYPE: the string `'ENOENT'`
 * when the binary is not on PATH, the number `128` when git ran and rejected
 * the path as a work tree. Same taxonomy, different carrier.
 *
 * @param {unknown} err
 * @returns {'git-unavailable'|'not-a-git-repo'|'git-error'}
 */
function classifyGitProbeFailure(err) {
  const code = err && typeof err === 'object' ? /** @type {any} */ (err).code : undefined;
  if (code === 'ENOENT') return 'git-unavailable';
  // `git remote -v` exits 128 for "not a git repository" — and, unlike the
  // `remote get-url origin` call this replaced, NOT for "no such remote":
  // a repo with zero remotes exits 0 with empty stdout. That is exactly the
  // split that makes `no-remotes` (benign absence) reportable at all.
  if (code === 128) return 'not-a-git-repo';
  return 'git-error';
}

/**
 * Detect the repo's VCS family from its git remotes.
 *
 * **Never throws.** Returns a discriminated result carrying a reason from
 * `vcs-repo-spec.mjs`'s frozen `REMOTE_RESOLUTION_REASONS` (plus
 * {@link PROBE_TIMEOUT}), so the caller can separate "I could not ask"
 * (`isQueryFailure` → WARN) from "I asked; this repo has no VCS remote"
 * (benign, silent). This is the `mirror-issues-banner.mjs` shape — a third
 * state beyond `value | null` — applied to the last unmigrated path in this
 * module (#1039).
 *
 * What it replaces, and why both halves were defects:
 *   1. `git remote get-url origin` — a hard-coded remote NAME. In a repo whose
 *      remotes are `gitlab` + `github` (no `origin`) the call failed, the
 *      caller swallowed it to `null`, and the banner was structurally dark:
 *      it could never report, not even on a red pipeline.
 *   2. `remoteUrl.includes('github.com') ? 'github' : 'gitlab'` — a substring
 *      test that classifies GitHub Enterprise (`git@github.example.com:o/r`)
 *      as gitlab and then drives `glab` at a GitHub instance.
 * `detectVcsFamily` fixes both: preference-ordered remote selection, and
 * host-prefix classification (`github.*` / `gitlab.*`) ahead of remote-name.
 *
 * The `git remote -v` spawn stays HERE rather than inside `detectVcsFamily`
 * because this module owes every subprocess a timeout race — the shared core
 * is synchronous by design. So the output is captured once and handed to the
 * shared classifier through its `gitRun` seam: one spawn, one taxonomy, no
 * second copy of the parsing or the credential strip.
 *
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number }} deps
 * @returns {Promise<{ ok: true, vcs: 'github'|'gitlab' }
 *   | { ok: false, reason: string, stderr?: string }>}
 */
async function detectVcs(repoRoot, deps = {}) {
  // Use the smaller of 2000ms or the caller-supplied timeout so that a short
  // test-level timeout is still respected here.
  const gitTimeout = Math.min(2000, deps.timeoutMs ?? 2000);

  let stdout;
  try {
    const result = await execWithTimeout(
      'git',
      ['remote', '-v'],
      { cwd: repoRoot, timeoutMs: gitTimeout, execFile: deps.execFile },
    );
    stdout = String(result?.stdout ?? '');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (msg === 'timeout') return { ok: false, reason: PROBE_TIMEOUT };
    const stderr = err && typeof err === 'object' ? String(/** @type {any} */ (err).stderr ?? '') : '';
    return { ok: false, reason: classifyGitProbeFailure(err), stderr };
  }

  // Replay the captured output through the shared core's `gitRun` seam. The
  // arg guard is insurance, not decoration: `detectVcsFamily` asks only for
  // `remote -v` today, and if it ever grows a second query the guard turns a
  // silently-wrong answer (built from the WRONG command's output) into a
  // reported `git-error`.
  const replayGitRun = (args) =>
    Array.isArray(args) && args.at(-2) === 'remote' && args.at(-1) === '-v'
      ? { ok: true, stdout, stderr: '', status: 0 }
      : { ok: false, stdout: '', stderr: `unsupported git query in ci-status probe: ${String(args)}`, status: 1 };

  const family = detectVcsFamily({ repoRoot, gitRun: replayGitRun });
  if (!family.ok) return { ok: false, reason: family.reason, stderr: family.stderr };
  return { ok: true, vcs: family.vcs };
}

/**
 * Get current HEAD commit SHA.
 *
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number }} deps
 * @returns {Promise<string>}
 */
async function getHeadSha(repoRoot, deps = {}) {
  const gitTimeout = Math.min(2000, deps.timeoutMs ?? 2000);
  const result = await execWithTimeout(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: repoRoot, timeoutMs: gitTimeout, execFile: deps.execFile },
  );
  return result.stdout.trim();
}

/**
 * Run a host-pinned `glab api <path>` request and return parsed JSON.
 *
 * GitLab's API accepts neither a remote URL nor `-R`; callers provide the host
 * proven by `resolveGitlabProjectTarget` so this helper cannot fall back to
 * ambient `GITLAB_HOST` configuration.
 *
 * @param {string} apiPath
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number, repoHost: string }} deps
 * @param {'object'|'array'} [expect]  Required payload shape (see `parseCliJson`)
 * @returns {Promise<unknown>}
 */
async function glabApi(apiPath, repoRoot, deps = {}, expect = undefined) {
  const args = ['api', apiPath, '--hostname', deps.repoHost];
  const result = await execWithTimeout(
    'glab',
    args,
    { cwd: repoRoot, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, execFile: deps.execFile },
  );
  return parseCliJson(result.stdout, `glab api ${apiPath}`, expect);
}

/**
 * Run `gh api <path>` and return parsed JSON.
 *
 * #872: `gh api` has no repo/`-R` concept either — pinned via `--hostname`
 * from `deps.repoHost` when resolved.
 *
 * @param {string} apiPath
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number, repoHost?: string }} deps
 * @param {'object'|'array'} [expect]  Required payload shape (see `parseCliJson`)
 * @returns {Promise<unknown>}
 */
async function ghApi(apiPath, repoRoot, deps = {}, expect = undefined) {
  const args = ['api', apiPath];
  if (deps.repoHost) args.push('--hostname', deps.repoHost);
  const result = await execWithTimeout(
    'gh',
    args,
    { cwd: repoRoot, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, execFile: deps.execFile },
  );
  return parseCliJson(result.stdout, `gh api ${apiPath}`, expect);
}

/**
 * Compute age in whole days between an ISO date string and `now`.
 *
 * @param {string} isoDate
 * @param {number} now  Unix epoch ms
 * @returns {number|null}
 */
function ageDaysFrom(isoDate, now) {
  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return null;
  return Math.floor((now - ts) / (24 * 60 * 60 * 1000));
}

/**
 * GitLab CI status check.
 * Returns a status result object or null on unrecoverable error.
 *
 * @param {string} repoRoot
 * @param {number} now
 * @param {{
 *   execFile?: Function,
 *   timeoutMs?: number,
 *   gitlabProject?: { host: string, encodedProjectPath: string },
 * }} deps
 * @returns {Promise<object|null>}
 */
async function checkGitlab(repoRoot, now, deps = {}) {
  const project = deps.gitlabProject;
  if (
    !project ||
    typeof project.host !== 'string' ||
    typeof project.encodedProjectPath !== 'string' ||
    project.host === '' ||
    project.encodedProjectPath === ''
  ) {
    return null;
  }

  const currentSha = await getHeadSha(repoRoot, deps);
  const apiDeps = { ...deps, repoHost: project.host };
  const projectPath = `projects/${project.encodedProjectPath}`;
  // `'array'` is load-bearing, not decoration: before it, a `glab api` that
  // returned valid JSON of the wrong shape (`null`, `"ok"`, an object) fell
  // into `!Array.isArray(pipelines) → return null` — a SILENT no-op an operator
  // reads as "nothing to report". It now raises the same named error an
  // unparseable payload does, so the outer catch warns.
  const pipelines = await glabApi(
    `${projectPath}/pipelines?order_by=updated_at&sort=desc&per_page=15`,
    repoRoot,
    apiDeps,
    'array',
  );

  const currentPipeline = pipelines.find((p) => p.sha === currentSha);

  if (!currentPipeline) {
    return {
      status: 'unknown',
      ok: false,
      details: {
        currentPipelineId: null,
        cliUsed: 'glab',
        reason: 'no-pipeline-for-head-sha',
      },
    };
  }

  const pipelineStatus = currentPipeline.status;

  if (pipelineStatus === 'success') {
    // A pipeline reports `success` even when jobs marked `allow_failure: true`
    // failed. Those jobs are invisible at the pipeline level, so a permanently
    // red allow-failure job (observed: 4/4 consecutive pipelines) would never
    // surface. Inspect the job list to name them. Non-fatal: a failed job query
    // still yields a plain green result.
    let allowFailureJobs;
    try {
      const jobs = await glabApi(
        `${projectPath}/pipelines/${currentPipeline.id}/jobs`,
        repoRoot,
        apiDeps,
        'array',
      );
      if (Array.isArray(jobs)) {
        const softFailed = jobs
          .filter((j) => j.status === 'failed' && j.allow_failure === true)
          .map((j) => j.name);
        if (softFailed.length > 0) allowFailureJobs = softFailed;
      }
    } catch {
      // Non-fatal — report green without the allow-failure detail.
    }

    return {
      status: 'green',
      ok: true,
      ...(allowFailureJobs ? { allowFailureJobs } : {}),
      details: {
        currentPipelineId: currentPipeline.id,
        cliUsed: 'glab',
      },
    };
  }

  if (pipelineStatus === 'running' || pipelineStatus === 'pending') {
    return {
      status: 'unknown',
      ok: false,
      details: {
        currentPipelineId: currentPipeline.id,
        cliUsed: 'glab',
        reason: `pipeline-${pipelineStatus}`,
      },
    };
  }

  if (pipelineStatus === 'failed' || pipelineStatus === 'canceled') {
    // Find the last green pipeline in the history.
    const currentIdx = pipelines.indexOf(currentPipeline);
    const rest = pipelines.slice(currentIdx + 1);
    const lastGreenPipeline = rest.find((p) => p.status === 'success');

    // Count consecutive non-success pipelines from current onwards.
    let redCount = 1;
    for (const p of rest) {
      if (p.status === 'success') break;
      redCount++;
    }

    let lastGreen;
    if (lastGreenPipeline) {
      const ageDays = ageDaysFrom(lastGreenPipeline.created_at, now);
      // Approximate commit distance: redCount is the number of red pipelines
      // before reaching the last green (pipelines are one-per-commit on this project).
      lastGreen = {
        sha: lastGreenPipeline.sha,
        pipelineId: lastGreenPipeline.id,
        ageCommits: redCount,
        ageDays,
      };
    }

    // Get the name of the first failing job on the current pipeline.
    let failingJobName;
    try {
      const jobs = await glabApi(
        `${projectPath}/pipelines/${currentPipeline.id}/jobs`,
        repoRoot,
        apiDeps,
        'array',
      );
      if (Array.isArray(jobs)) {
        const failedJob = jobs.find((j) => j.status === 'failed');
        failingJobName = failedJob ? failedJob.name : undefined;
      }
    } catch {
      // Non-fatal — we still report red status without job name.
    }

    return {
      status: 'red',
      ok: false,
      ...(lastGreen ? { lastGreen } : {}),
      redCount,
      ...(failingJobName !== undefined ? { failingJobName } : {}),
      details: {
        currentPipelineId: currentPipeline.id,
        cliUsed: 'glab',
      },
    };
  }

  // Any other status (skipped, manual, etc.) → unknown.
  return {
    status: 'unknown',
    ok: false,
    details: {
      currentPipelineId: currentPipeline.id,
      cliUsed: 'glab',
      reason: `unrecognised-status-${pipelineStatus}`,
    },
  };
}

/**
 * GitHub CI status check (v1 — red/green only; lastGreen not implemented).
 *
 * #872/#1022: pins the `gh repo view` lookup to `deps.repoSpec` when resolved
 * (host-pinning — `gh repo view` otherwise falls back to the ambient
 * `GH_HOST`). The spec is passed POSITIONALLY, not via `-R`: `gh repo view`
 * takes `[<repository>]` as a positional argument and has no `-R`/`--repo`
 * flag at all, so `-R` made gh exit 1 with `unknown shorthand flag: 'R'` —
 * an error `checkCiStatus`'s outer catch swallowed to `null`, leaving the
 * Phase 4 banner silently dead on EVERY GitHub repo (#1022). The
 * `[HOST/]OWNER/REPO` shape `resolveRepoSpec({ vcs: 'github' })` returns is
 * exactly the positional's documented input format.
 *
 * GitLab CI differs deliberately: it derives a host-pinned API target from
 * the selected remote, while GitHub still needs this lookup because its API
 * path requires `nameWithOwner`. Do not unify these call sites.
 *
 * `nameWithOwner` is NOT derivable from `deps.repoSpec`, so this lookup
 * cannot be dropped: the spec carries a HOST prefix the `repos/<owner>/<repo>`
 * API path must not contain, it is `undefined` whenever no remote resolves
 * (cross-family guard, unsafe-argv guard), and `normalizeGithubSpec` falls
 * back to the raw URL on an unrecognised remote shape.
 *
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number, repoSpec?: string, repoHost?: string }} deps
 * @returns {Promise<object|null>}
 */
async function checkGithub(repoRoot, deps = {}) {
  // Resolve owner/repo from gh to keep the API path generic.
  const repoViewArgs = ['repo', 'view'];
  if (deps.repoSpec) repoViewArgs.push(deps.repoSpec);
  repoViewArgs.push('--json', 'nameWithOwner');
  const repoViewResult = await execWithTimeout(
    'gh',
    repoViewArgs,
    { cwd: repoRoot, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, execFile: deps.execFile },
  );
  // `'object'` before the destructuring: a `gh repo view` that printed `null`
  // (or a bare string, or an array) used to throw a bare
  // `TypeError: Cannot destructure property 'nameWithOwner' of 'null'`, whose
  // message names neither the CLI nor the request — the exact identification
  // failure this helper exists to fix.
  const { nameWithOwner } = parseCliJson(
    repoViewResult.stdout,
    `gh ${repoViewArgs.join(' ')}`,
    'object',
  );

  const data = await ghApi(
    `repos/${nameWithOwner}/commits/HEAD/check-runs`,
    repoRoot,
    deps,
    'object',
  );

  const checkRuns = data.check_runs;
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) {
    return {
      status: 'unknown',
      ok: false,
      details: {
        cliUsed: 'gh',
        reason: 'no-check-runs-for-head',
      },
    };
  }

  const failedRun = checkRuns.find(
    (r) => r.conclusion === 'failure' || r.conclusion === 'action_required',
  );

  if (failedRun) {
    return {
      status: 'red',
      ok: false,
      failingJobName: failedRun.name,
      details: {
        cliUsed: 'gh',
        reason: 'lastGreen-not-implemented-for-github',
      },
    };
  }

  const allSuccess = checkRuns.every((r) => r.conclusion === 'success');
  if (allSuccess) {
    return {
      status: 'green',
      ok: true,
      details: {
        cliUsed: 'gh',
      },
    };
  }

  // Some runs pending / in-progress / etc.
  return {
    status: 'unknown',
    ok: false,
    details: {
      cliUsed: 'gh',
      reason: 'check-runs-not-complete',
    },
  };
}

/**
 * Checks CI status for the current HEAD commit.
 *
 * Returns `null` (silent no-op) ONLY for a measured ABSENCE: the repo has no
 * usable VCS remote (not a git repo, no remotes at all, or >= 2 remotes with no
 * preference match). That is a complete answer — there is no CI here.
 *
 * Returns a DEGRADED result (`{severity:'warn', ok:false, message, degraded}`,
 * see {@link DEGRADED_REASONS}) when the state could not be read: the
 * VCS-detection query itself failed (`git` not on PATH, `git remote -v`
 * erroring), a required CLI is missing, an invocation timed out, a present CLI
 * rejected its invocation, a GitLab API target could not be derived, or a CLI
 * returned output this module could not parse (see {@link parseCliJson}).
 * Callers MUST treat that as "state unknown", never as clean — the generic
 * degraded path in `scripts/lib/session-start-probes.mjs` does exactly that.
 *
 * Missing-CLI and timeout additionally stay SILENT on the `console.warn`
 * channel (they are normal states on a CLI-less machine); every other degraded
 * reason also emits a warn.
 *
 * @param {{
 *   repoRoot?: string,
 *   vcs?: 'gitlab'|'github',
 *   timeoutMs?: number,
 *   now?: number,
 * }} opts
 * @param {{
 *   execFile?: Function,
 *   resolveRepoSpec?: (opts: { repoRoot: string, vcs: 'gitlab'|'github' }) => string|undefined,
 *   resolveRepoHost?: (opts: { repoRoot: string, vcs: 'gitlab'|'github' }) => string|undefined,
 *   resolveGitlabProjectTarget?: (opts: { repoRoot: string }) =>
 *     { host: string, encodedProjectPath: string }|undefined,
 * }} deps  Dependency-injection seam for testing. GitLab defaults to
 *   `resolveGitlabProjectTarget`, which proves host and project path from one
 *   sanitized remote; GitHub retains the #872 spec/host resolvers.
 * @returns {Promise<null | {
 *   severity: 'warn',
 *   ok: false,
 *   message: string,
 *   degraded: 'cli-missing'|'timeout'|'parse-error'|'query-failed'|'git-error',
 * } | {
 *   status: 'green'|'red'|'unknown',
 *   ok: boolean,
 *   lastGreen?: { sha: string, pipelineId: number, ageCommits: number, ageDays: number|null },
 *   redCount?: number,
 *   failingJobName?: string,
 *   details: {
 *     currentPipelineId?: number,
 *     cliUsed: 'glab'|'gh',
 *     reason?: string,
 *     error?: string,
 *   },
 * }>}
 */
export async function checkCiStatus(opts = {}, deps = {}) {
  const {
    repoRoot = process.cwd(),
    vcs: forcedVcs,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now(),
  } = opts;

  const execFileDep = deps.execFile
    ? promisify(deps.execFile)
    : execFileAsync;

  const resolveRepoSpecDep = deps.resolveRepoSpec ?? resolveRepoSpec;
  const resolveRepoHostDep = deps.resolveRepoHost ?? resolveRepoHost;
  const resolveGitlabProjectTargetDep = deps.resolveGitlabProjectTarget ?? resolveGitlabProjectTarget;

  const depsWithExec = { execFile: execFileDep, timeoutMs };

  try {
    // Step 1: detect VCS (or use forced value).
    let vcs = forcedVcs;
    if (!vcs) {
      const detected = await detectVcs(repoRoot, depsWithExec);
      if (!detected.ok) {
        // An ABSENCE (`no-remotes`, `no-matching-remote`, `unsafe-value`) is a
        // real, benign answer and stays `null` AND silent — degrading there
        // would print a banner on every session-start in a remote-less repo and
        // train operators to ignore this line, which is the more expensive
        // error. A QUERY FAILURE (`git-unavailable`, `git-error`) means the
        // question could not be asked at all: since #1031 that is the third
        // state, no longer a warn-only side channel on top of an all-clear
        // `null`. `not-a-git-repo` is the one query failure this banner reads
        // as an absence — see {@link SILENT_QUERY_FAILURES}.
        if (detected.reason === PROBE_TIMEOUT) {
          return degradedResult('timeout');
        }
        if (isQueryFailure(detected.reason) && !SILENT_QUERY_FAILURES.has(detected.reason)) {
          const stderr = detected.stderr
            ? redactUrlCredentials(detected.stderr).trim()
            : '';
          const detail = stderr ? ` — ${stderr}` : '';
          console.warn(
            `WARN ci-status-banner: VCS detection failed (${detected.reason}), banner suppressed — ` +
              `CI state is UNKNOWN, not "green".${detail}`,
          );
          return degradedForVcsReason(
            detected.reason,
            stderr ? `${detected.reason}: ${stderr}` : detected.reason,
          );
        }
        return null;
      }
      vcs = detected.vcs;
    }

    // Step 1b: GitLab's API target must be proven before its first glab spawn.
    // A missing target is never permission to fall back to ambient
    // GITLAB_HOST/repository configuration. GitHub retains its distinct
    // repository lookup because its API path requires `nameWithOwner`.
    //
    // It is also not an ABSENCE: detectVcs just proved a GitLab remote exists,
    // so `!gitlabProject` means "remote present, its form was rejected" — a
    // QUERY FAILURE by the same rule the block above states. Returning null
    // silently put this repo back in the pre-#1039 state where "CI green" and
    // "could not ask" look identical. Reachable inputs measured 2026-08-21:
    // `git://` scheme, a doubled slash in the path, a query string.
    if (vcs === 'gitlab') {
      const gitlabProject = resolveGitlabProjectTargetDep({ repoRoot });
      if (!gitlabProject) {
        console.warn(
          'WARN ci-status-banner: a GitLab remote was detected but its host/project path ' +
            'could not be derived, banner suppressed — CI state is UNKNOWN, not "green".',
        );
        return degradedResult(
          'query-failed',
          'a GitLab remote was detected but its host/project path could not be derived',
        );
      }
      return await checkGitlab(repoRoot, now, { ...depsWithExec, gitlabProject });
    }

    if (vcs === 'github') {
      const repoSpec = resolveRepoSpecDep({ repoRoot, vcs });
      const repoHost = resolveRepoHostDep({ repoRoot, vcs });
      return await checkGithub(repoRoot, { ...depsWithExec, repoSpec, repoHost });
    }

    // Unknown VCS value — silent no-op.
    return null;
  } catch (err) {
    // Never throws: every failure below leaves as the third return state.
    const msg = err instanceof Error ? err.message : String(err);

    // Timeout and ENOENT (missing CLI) stay SILENT on the warn channel — a
    // machine without `glab` is a normal state, and a warn on every
    // session-start there drowns the #1022 signal this channel carries. Since
    // #1031 they are no longer silent on the RETURN channel: neither state
    // established that CI is green, so both degrade.
    if (msg === 'timeout') return degradedResult('timeout');
    if (err && err.code === 'ENOENT') {
      return degradedResult('cli-missing', redactUrlCredentials(msg));
    }

    // Everything else means the CLI was PRESENT but the invocation failed —
    // non-zero exit, rejected flag, unparseable output. A bare `null` here made
    // that state indistinguishable from "CLI not installed" AND from "CI is
    // green", which is exactly how #1022 (`gh repo view -R` → `unknown
    // shorthand flag: 'R'`) stayed invisible on every GitHub repo.
    //
    // #1031 finished the migration this comment used to describe as pending:
    // the third state `{ severity, message, degraded }` — the shape
    // `scripts/lib/mirror-issues-banner.mjs` established — now leaves here too,
    // alongside (not instead of) the stderr trace. `parse-error` is carried on
    // the error by `tagParseError`; everything else is the residual
    // `query-failed`.
    //
    // Credentials redacted defense-in-depth (#907) — the message can quote the
    // failed argv, which carries the repo spec — and the redacted text is what
    // reaches BOTH the warn and the operator-facing `message`.
    const redacted = redactUrlCredentials(msg);
    console.warn(
      `WARN ci-status-banner: CI status check failed, banner suppressed — ${redacted}`,
    );
    // Literal reasons on BOTH branches, never `degradedResult(reason)` with a
    // computed variable: the enum census in the test file is a regex over this
    // source, and a variable hides the member from it.
    if (err && typeof err === 'object' && err.degradedReason === 'parse-error') {
      return degradedResult('parse-error', redacted);
    }
    return degradedResult('query-failed', redacted);
  }
}
