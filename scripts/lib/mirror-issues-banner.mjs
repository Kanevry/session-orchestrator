/**
 * mirror-issues-banner.mjs — the mirror blind spot (#1022 follow-up)
 *
 * `skills/gitlab-ops/SKILL.md` § VCS Auto-Detection picks EXACTLY ONE platform
 * via if/else. In a repo whose `origin` is GitLab and whose `github` remote is
 * a public mirror, no code path ever reads issues from the mirror — so issues
 * filed by external reporters against the mirror are structurally invisible to
 * every session. This probe is the counter-measure: it asks the OTHER side.
 *
 * The VCS family is therefore HARD-PINNED to `'github'`, never auto-detected.
 * Auto-detection is the defect this module exists to compensate for; deriving
 * the family here would reproduce it.
 *
 * No new Session Config key by design. `resolveRepoSpec({ vcs:'github' })`
 * derives the `gh -R` spec straight from `git remote` (its `REMOTE_PREFERENCE`
 * tries the remote literally named `github` first, and its `WRONG_FAMILY_HOST`
 * guard discards a cross-family match). That makes the probe SELF-DISABLING: a
 * repo without a GitHub mirror resolves to `undefined` → `null` → no spawn, no
 * network call. A config key would be a second SSOT drifting against
 * `git remote`.
 *
 * Plain-JS — no Zod dependency. Never throws.
 *
 * Mirrors the Phase 4 banner contract documented in
 * `scripts/lib/loop-readiness-banner.mjs:23-26`: a single `checkXxx()` entry
 * point returning `null` or `{ severity, message, ... }`.
 *
 * Cross-references:
 *  - `scripts/lib/ci-status-banner.mjs` — the sibling project-facing probe
 *    (whose `null`-collapsing this module deliberately does NOT copy, see below).
 *  - `scripts/lib/reconcile-nudge-banner.mjs:183-186` — the same
 *    absence-preserving discipline applied to a count.
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRepoSpec as _resolveRepoSpec } from './vcs-repo-spec.mjs';

const execFileAsync = promisify(_execFile);

/** Default timeout in ms for the `gh` invocation. Mirrors `ci-status-banner.mjs:20`. */
export const DEFAULT_TIMEOUT_MS = 8000;

/** Default `--limit` passed to `gh issue list`. */
export const DEFAULT_LIMIT = 20;

/**
 * The VCS family this probe queries. Deliberately a module constant, not a
 * parameter: querying the auto-detected platform would make this probe a no-op
 * in exactly the repos it exists for.
 */
const MIRROR_VCS = 'github';

/** How many issue numbers the banner message names before summarising. */
const MESSAGE_ISSUE_CAP = 5;

/**
 * Closed set of `degraded` reasons. A degraded result means "the mirror was
 * NOT successfully read" — never "the mirror is clean".
 *
 * `query-failed` is the residual bucket for a `gh` that ran and exited
 * non-zero for a reason that is neither missing-CLI, timeout, nor auth
 * (network down, repo renamed, rate limit). It is a deliberate fifth member
 * beyond the four originally specified: folding those into `parse-error`
 * would mislabel a network failure as malformed output, reintroducing the
 * dishonest-state class this module was built to remove.
 *
 * @type {readonly ['cli-missing','timeout','parse-error','auth-error','query-failed']}
 */
export const DEGRADED_REASONS = Object.freeze([
  'cli-missing',
  'timeout',
  'parse-error',
  'auth-error',
  'query-failed',
]);

/**
 * Run `cmd` with a timeout race. Mirrors `ci-status-banner.mjs:30-38`.
 *
 * The timer is cleared and `unref`ed so a fast success does not hold the event
 * loop open for the full budget (`.claude/rules/testing.md` § Async & Timeout
 * Patterns). KNOWN LIMIT, inherited from the shared pattern and NOT fixed
 * here: losing the race abandons the `gh` child process rather than killing
 * it — a hung `gh` is left orphaned.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, execFile?: Function }} [opts]
 * @returns {Promise<{ stdout?: string, stderr?: string }>}
 */
async function execWithTimeout(cmd, args, opts = {}) {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, execFile = execFileAsync } = opts;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([
      execFile(cmd, args, { cwd, env: process.env }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Map a failed `gh` invocation onto a {@link DEGRADED_REASONS} member.
 *
 * @param {unknown} err
 * @returns {'cli-missing'|'timeout'|'auth-error'|'query-failed'}
 */
function classifyFailure(err) {
  const code = err && typeof err === 'object' ? /** @type {any} */ (err).code : undefined;
  if (code === 'ENOENT') return 'cli-missing';

  const message = err instanceof Error ? err.message : String(err ?? '');
  if (message === 'timeout') return 'timeout';

  const stderr = err && typeof err === 'object' ? String(/** @type {any} */ (err).stderr ?? '') : '';
  const haystack = `${message}\n${stderr}`.toLowerCase();
  if (
    haystack.includes('gh auth login') ||
    haystack.includes('not logged in') ||
    haystack.includes('authentication') ||
    haystack.includes('http 401') ||
    haystack.includes('http 403')
  ) {
    return 'auth-error';
  }
  return 'query-failed';
}

/**
 * Build the degraded result. Distinct from `null` on purpose: `null` in the
 * banner contract reads as "all clear", which a failed query has NOT
 * established.
 *
 * @param {string} repoSpec
 * @param {string} reason
 * @returns {{ severity: 'warn', message: string, repoSpec: string, degraded: string }}
 */
function degradedResult(repoSpec, reason) {
  return {
    severity: 'warn',
    message:
      `⚠ mirror-issues: Mirror ${repoSpec} konnte nicht abgefragt werden (${reason}) ` +
      `— Zustand unbekannt, nicht "sauber".`,
    repoSpec,
    degraded: reason,
  };
}

/**
 * Render the found-issues banner message, naming issue numbers up to
 * {@link MESSAGE_ISSUE_CAP} and summarising any remainder.
 *
 * @param {string} repoSpec
 * @param {Array<{ number: number, title: string }>} issues
 * @returns {string}
 */
function formatMessage(repoSpec, issues) {
  const named = issues.slice(0, MESSAGE_ISSUE_CAP).map((i) => `#${i.number}`).join(', ');
  const rest = issues.length - Math.min(issues.length, MESSAGE_ISSUE_CAP);
  const tail = rest > 0 ? ` (+${rest} weitere)` : '';
  const plural = issues.length === 1 ? 'offenes Issue' : 'offene Issues';
  return (
    `⚠ mirror-issues: ${issues.length} ${plural} im Mirror ${repoSpec}: ${named}${tail} ` +
    `— kein anderer Codepfad dieser Session liest sie.`
  );
}

/**
 * Check the GitHub mirror for open issues and produce a session-start banner.
 *
 * Return contract — three states, not two:
 *  - `null` when the mirror remote does not resolve (repo genuinely has no
 *    mirror; NO subprocess is spawned) or when the query SUCCEEDED and found
 *    zero open issues (measured and clean).
 *  - `{ severity:'warn', message, count, repoSpec, issues }` when N > 0.
 *  - `{ severity:'warn', message, repoSpec, degraded }` when the query did not
 *    succeed. `degraded` is present ONLY in this case, so its absence proves
 *    the mirror was actually read — the distinction `ci-status-banner.mjs`
 *    collapses (CLI-missing, bad JSON and no-remote all return `null` there,
 *    which is why the mirror gap went unseen for months).
 *
 * Never throws.
 *
 * @param {{ repoRoot?: string, timeoutMs?: number, limit?: number }} [opts]
 * @param {{ execFile?: Function, resolveRepoSpec?: Function }} [deps] DI for tests only.
 * @returns {Promise<null | { severity: 'warn', message: string, repoSpec: string, count?: number, issues?: Array<{number:number,title:string}>, degraded?: string }>}
 */
export async function checkMirrorIssues(opts = {}, deps = {}) {
  try {
    const { repoRoot, timeoutMs = DEFAULT_TIMEOUT_MS, limit = DEFAULT_LIMIT } = opts ?? {};
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const { execFile = execFileAsync, resolveRepoSpec = _resolveRepoSpec } = deps ?? {};

    // Step 1 — resolve the mirror spec from `git remote`. `undefined` here is
    // the self-disabling path: no mirror, no spawn, no network cost.
    let repoSpec;
    try {
      repoSpec = resolveRepoSpec({ repoRoot, vcs: MIRROR_VCS });
    } catch {
      return null;
    }
    if (!repoSpec || typeof repoSpec !== 'string') return null;

    // Step 2 — query. Args array, never a shell string.
    let stdout;
    try {
      const result = await execWithTimeout(
        'gh',
        [
          'issue',
          'list',
          '-R',
          repoSpec,
          '--state',
          'open',
          '--limit',
          String(limit),
          '--json',
          'number,title',
        ],
        { cwd: repoRoot, timeoutMs, execFile },
      );
      stdout = String(result?.stdout ?? '');
    } catch (err) {
      return degradedResult(repoSpec, classifyFailure(err));
    }

    // Step 3 — parse. A CLI that exited 0 with unusable output is degraded,
    // NOT clean.
    let issues;
    try {
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return degradedResult(repoSpec, 'parse-error');
      issues = parsed
        .filter((entry) => entry && typeof entry === 'object' && Number.isFinite(Number(entry.number)))
        .map((entry) => ({ number: Number(entry.number), title: String(entry.title ?? '') }));
    } catch {
      return degradedResult(repoSpec, 'parse-error');
    }

    // Step 4 — measured and clean.
    if (issues.length === 0) return null;

    return {
      severity: 'warn',
      message: formatMessage(repoSpec, issues),
      count: issues.length,
      repoSpec,
      issues,
    };
  } catch {
    // Defensive catch-all: a banner must never break session-start.
    return null;
  }
}

export default checkMirrorIssues;
