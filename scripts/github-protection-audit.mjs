#!/usr/bin/env node
/**
 * scripts/github-protection-audit.mjs — read-only GitHub-mirror branch
 * protection audit (GitLab issue #1079).
 *
 * WHY THIS EXISTS: `.claude/rules/security.md` § "Session Config Command
 * Trust" argues that commit-gated files are trustworthy BECAUSE every change
 * lands in `git log` and passes review — but that argument only holds when
 * the DEPLOYING path is the SAME as the REVIEWING path. This repo's GitHub
 * mirror breaks that: `origin` (GitLab) is reviewed via MR, `github` is
 * pushed directly by `skills/session-end/SKILL.md`'s mirror-push block
 * (`git push github HEAD`, no MR, no review) — and since a Vercel Git
 * integration deploys on every push to that mirror's `main`, a compromised
 * mirror token or an admin bypass IS a deploy with zero review. See
 * `docs/github-mirror-protection.md` for the full runbook.
 *
 * THIS SCRIPT NEVER WRITES. It only reads `gh api`/`gh auth status`/
 * `gh repo view` output and reports findings — no `-X PUT/PATCH/DELETE`, no
 * token mutation, ever. Flipping `enforce_admins` or narrowing the token is
 * an OPERATOR action documented in the runbook, not something this script
 * performs.
 *
 * Three-state contract (mirrors `scripts/lib/mirror-issues-banner.mjs`):
 *   - success  → the full envelope (see {@link auditGithubBranchProtection}'s
 *     doc), always including a `findings` array (possibly empty).
 *   - degraded → `{ degraded: '<reason>' }`. `gh` missing, not authenticated,
 *     a timed-out invocation, or any other query failure. NEVER treat this as
 *     "no findings" — it means "could not measure", not "measured, clean".
 *
 * CLI: prints exactly ONE JSON object on stdout. Exit 0 on a successful
 * measurement (regardless of how many findings it carries — this is a
 * report, not a gate), exit 2 on `degraded`.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveRepoSpec as _resolveRepoSpec, resolveRepoHost as _resolveRepoHost } from './lib/vcs-repo-spec.mjs';

const execFileAsync = promisify(_execFile);

/** Default timeout in ms for a single `gh` invocation. Mirrors `mirror-issues-banner.mjs`. */
export const DEFAULT_TIMEOUT_MS = 8000;

/** The VCS family this audit always queries — the mirror, never the auto-detected platform. */
const AUDIT_VCS = 'github';

/**
 * Closed set of `degraded` reasons. Same shape as
 * `mirror-issues-banner.mjs`'s `DEGRADED_REASONS`: a degraded result means
 * "the mirror was NOT successfully measured" — never "the mirror is clean".
 *
 * @type {readonly ['no-github-remote','cli-missing','timeout','auth-error','parse-error','query-failed']}
 */
export const DEGRADED_REASONS = Object.freeze([
  'no-github-remote',
  'cli-missing',
  'timeout',
  'auth-error',
  'parse-error',
  'query-failed',
]);

/**
 * Classic PAT scopes broader than the fine-grained `contents:write` this
 * repo's mirror push actually needs. `repo` is the specific scope GitLab
 * issue #1079 names ("org-weit und deutlich mehr als der Deploy braucht");
 * the rest are equally-or-more privileged siblings a rotated token could
 * plausibly carry. A classic token has no scope that means EXACTLY
 * `contents:write` — narrowing further requires a fine-grained PAT (see the
 * runbook), so this list is deliberately conservative: it flags scopes that
 * are unambiguously broader, not "any classic scope at all".
 *
 * @type {readonly string[]}
 */
export const UNSAFE_TOKEN_SCOPES = Object.freeze([
  'repo',
  'admin:org',
  'admin:repo_hook',
  'admin:public_key',
  'admin:enterprise',
  'delete_repo',
  'site_admin',
]);

/**
 * Run `cmd` with a timeout race. Mirrors `mirror-issues-banner.mjs:80-108`.
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
 * Mirrors `mirror-issues-banner.mjs`'s `classifyFailure`.
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
 * `true` when a failed `gh api .../protection` call means "this branch has
 * no protection configured at all" (HTTP 404) rather than a real query
 * failure. GitHub's API returns 404 (not an empty protection object) for an
 * unprotected branch, so this must be distinguished from `classifyFailure`'s
 * generic `query-failed` — it is a measured, reportable state, not a
 * degraded one.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isUnprotectedBranch404(err) {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const stderr = err && typeof err === 'object' ? String(/** @type {any} */ (err).stderr ?? '') : '';
  const haystack = `${message}\n${stderr}`.toLowerCase();
  return haystack.includes('http 404') || haystack.includes('branch not protected');
}

/**
 * Parse `gh auth status` combined stdout+stderr for the `Token scopes:` line.
 * gh has changed which stream this prints to across versions (measured
 * 2026-08-28 @ this repo: stdout), so both are scanned defensively.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseTokenScopes(text) {
  const match = /token scopes:\s*(.+)/i.exec(text);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0);
}

/**
 * Build a degraded result. Distinct from a success envelope on purpose —
 * `degraded` must never be read as "clean".
 *
 * @param {string} reason
 * @param {string} [detail]
 * @returns {{ degraded: string, message: string }}
 */
function degradedResult(reason, detail) {
  return {
    degraded: reason,
    message: `github-protection-audit: could not measure branch protection (${reason})` + (detail ? ` — ${detail}` : ''),
  };
}

/**
 * Audit the GitHub mirror's default-branch protection, read-only.
 *
 * Never mutates anything — every call is a `gh api`/`gh repo view`/
 * `gh auth status` READ. Never throws; every failure path returns the
 * degraded shape below.
 *
 * @param {{ repoRoot?: string, timeoutMs?: number }} [opts]
 * @param {{ execFile?: Function, resolveRepoSpec?: Function, resolveRepoHost?: Function }} [deps] DI for tests only.
 * @returns {Promise<
 *   | { degraded: string, message: string }
 *   | {
 *       repo: string,
 *       branch: string,
 *       enforce_admins: boolean,
 *       required_status_checks: { strict: boolean, contexts: string[] } | null,
 *       required_pull_request_reviews: boolean,
 *       allow_force_pushes: boolean,
 *       token_scopes: string[],
 *       findings: Array<{ id: string, severity: string, message: string }>,
 *     }
 * >}
 */
export async function auditGithubBranchProtection(opts = {}, deps = {}) {
  const { repoRoot = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS } = opts ?? {};
  const {
    execFile = execFileAsync,
    resolveRepoSpec = _resolveRepoSpec,
    resolveRepoHost = _resolveRepoHost,
  } = deps ?? {};

  try {
    // Step 1 — resolve the mirror spec/host from `git remote`. No remote, no
    // spawn: this is the self-disabling path shared with `mirror-issues-banner.mjs`.
    let repoSpec;
    let repoHost;
    try {
      repoSpec = resolveRepoSpec({ repoRoot, vcs: AUDIT_VCS });
      repoHost = resolveRepoHost({ repoRoot, vcs: AUDIT_VCS });
    } catch {
      return degradedResult('no-github-remote');
    }
    if (!repoSpec || typeof repoSpec !== 'string') return degradedResult('no-github-remote');

    const execDeps = { cwd: repoRoot, timeoutMs, execFile };

    // Step 2 — resolve owner/repo + default branch.
    let nameWithOwner;
    let branch;
    try {
      const result = await execWithTimeout(
        'gh',
        ['repo', 'view', repoSpec, '--json', 'nameWithOwner,defaultBranchRef'],
        execDeps,
      );
      const parsed = JSON.parse(String(result?.stdout ?? ''));
      nameWithOwner = parsed?.nameWithOwner;
      branch = parsed?.defaultBranchRef?.name;
      if (typeof nameWithOwner !== 'string' || typeof branch !== 'string' || !nameWithOwner || !branch) {
        return degradedResult('parse-error', 'gh repo view returned an unusable shape');
      }
    } catch (err) {
      return degradedResult(classifyFailure(err));
    }

    // Step 3 — token scopes via `gh auth status`.
    let tokenScopes;
    try {
      const authArgs = repoHost ? ['auth', 'status', '--hostname', repoHost] : ['auth', 'status'];
      const result = await execWithTimeout('gh', authArgs, execDeps);
      const combined = `${String(result?.stdout ?? '')}\n${String(result?.stderr ?? '')}`;
      tokenScopes = parseTokenScopes(combined);
    } catch (err) {
      return degradedResult(classifyFailure(err));
    }

    // Step 4 — branch protection itself. A 404 means "not protected at all",
    // a measured (not degraded) state — everything else is a real query failure.
    let protection = null;
    try {
      const apiArgs = ['api', `repos/${nameWithOwner}/branches/${branch}/protection`];
      if (repoHost) apiArgs.push('--hostname', repoHost);
      const result = await execWithTimeout('gh', apiArgs, execDeps);
      protection = JSON.parse(String(result?.stdout ?? ''));
    } catch (err) {
      if (!isUnprotectedBranch404(err)) return degradedResult(classifyFailure(err));
      protection = null; // unprotected — fall through with defaults below
    }

    const enforceAdmins = protection?.enforce_admins?.enabled === true;
    const rawStatusChecks = protection?.required_status_checks ?? null;
    const requiredStatusChecks = rawStatusChecks
      ? {
          strict: rawStatusChecks.strict === true,
          contexts: Array.isArray(rawStatusChecks.contexts) ? rawStatusChecks.contexts.map(String) : [],
        }
      : null;
    // `required_pull_request_reviews` is OMITTED from the API response
    // entirely when no review requirement is configured (measured live,
    // 2026-08-28) — it is never `{ enabled: false }`. So presence-of-key,
    // not a nested `.enabled` read, is the correct boolean derivation.
    const requiredPullRequestReviews = protection !== null && 'required_pull_request_reviews' in protection;
    const allowForcePushes = protection === null ? true : protection?.allow_force_pushes?.enabled === true;

    /** @type {Array<{ id: string, severity: string, message: string }>} */
    const findings = [];

    if (protection === null) {
      findings.push({
        id: 'branch-not-protected',
        severity: 'critical',
        message: `${nameWithOwner}@${branch} has NO branch protection configured — any push (including a compromised mirror token) lands directly, unreviewed.`,
      });
    }

    if (!enforceAdmins) {
      findings.push({
        id: 'enforce-admins-disabled',
        severity: 'high',
        message:
          'enforce_admins is false — an admin-scoped push (or token) bypasses required_status_checks entirely. ' +
          'See GitLab #1079: this is the gap that makes the mirror a review-free deploy path.',
      });
    }

    const broadScopes = tokenScopes.filter((s) => UNSAFE_TOKEN_SCOPES.includes(s));
    if (broadScopes.length > 0) {
      findings.push({
        id: 'token-scope-too-broad',
        severity: 'medium',
        message:
          `Token scope(s) ${broadScopes.join(', ')} exceed what a mirror push needs (fine-grained contents:write ` +
          `on this one repo). See docs/github-mirror-protection.md for the narrowing steps.`,
      });
    }

    if (!requiredStatusChecks || requiredStatusChecks.contexts.length === 0) {
      findings.push({
        id: 'no-required-status-checks',
        severity: 'medium',
        message: 'No required status checks are configured on this branch — a push can land with a red or absent CI run.',
      });
    }

    return {
      repo: nameWithOwner,
      branch,
      enforce_admins: enforceAdmins,
      required_status_checks: requiredStatusChecks,
      required_pull_request_reviews: requiredPullRequestReviews,
      allow_force_pushes: allowForcePushes,
      token_scopes: tokenScopes,
      findings,
    };
  } catch (err) {
    // Defensive catch-all: this script must never throw, only degrade.
    return degradedResult('query-failed', err instanceof Error ? err.message : String(err ?? ''));
  }
}

// CLI entry — only when run directly, not when imported (e.g. by tests).
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  auditGithubBranchProtection({ repoRoot: process.cwd() }).then((result) => {
    console.log(JSON.stringify(result));
    process.exit('degraded' in result ? 2 : 0);
  });
}
