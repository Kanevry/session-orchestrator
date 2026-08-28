/**
 * tests/scripts/github-protection-audit.test.mjs — GitLab issue #1079.
 *
 * Every case stubs BOTH boundaries (`resolveRepoSpec`/`resolveRepoHost` +
 * `execFile`) so no test spawns `gh`, touches the network, or depends on
 * this repo's live remote/token configuration — matching the DI seam shape
 * of `scripts/lib/mirror-issues-banner.mjs` and its test suite.
 *
 * The `gh api .../protection` fixture is a GOLDEN RECORD: the verbatim
 * stdout `gh api repos/Kanevry/session-orchestrator/branches/main/protection`
 * produced on 2026-08-28 (session W3-P6), per `.claude/rules/testing.md`
 * § "Fixtures Mirror Production Data" — stored as the raw string `gh` emitted,
 * never a hand-built `JSON.stringify(...)` object, so it cannot silently drift
 * from the real API shape (the exact trap named in this session's
 * learnings-index: "ein Paritaets-Test mit handgetippter Liste ... ist ein
 * gruener Haken ohne Deckung").
 */

import { describe, it, expect } from 'vitest';
import {
  auditGithubBranchProtection,
  parseTokenScopes,
  DEGRADED_REASONS,
  UNSAFE_TOKEN_SCOPES,
} from '../../scripts/github-protection-audit.mjs';

const REPO_SPEC = 'github.com/Kanevry/session-orchestrator';
const REPO_HOST = 'github.com';

/** Verbatim `gh repo view <spec> --json nameWithOwner,defaultBranchRef` stdout. */
const REPO_VIEW_STDOUT = '{"nameWithOwner":"Kanevry/session-orchestrator","defaultBranchRef":{"name":"main"}}\n';

/** Verbatim `gh auth status` stdout, captured 2026-08-28 @ 70a1ca9 — this repo's live scope set. */
const AUTH_STATUS_STDOUT =
  'github.com\n' +
  '  ✓ Logged in to github.com account Kanevry (keyring)\n' +
  '  - Active account: true\n' +
  '  - Git operations protocol: https\n' +
  '  - Token: gho_************************************\n' +
  "  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo', 'workflow'\n";

/**
 * Verbatim `gh api repos/Kanevry/session-orchestrator/branches/main/protection`
 * stdout, captured 2026-08-28 @ 70a1ca9 (the exact scenario GitLab #1079
 * describes: enforce_admins false, required_status_checks configured,
 * required_pull_request_reviews key ABSENT — never `{"enabled":false}`).
 */
const PROTECTION_STDOUT =
  '{"url":"https://api.github.com/repos/Kanevry/session-orchestrator/branches/main/protection",' +
  '"required_status_checks":{"url":"https://api.github.com/repos/Kanevry/session-orchestrator/branches/main/protection/required_status_checks",' +
  '"strict":true,"contexts":["test (ubuntu-latest)","test (macos-latest)","security"],' +
  '"contexts_url":"https://api.github.com/repos/Kanevry/session-orchestrator/branches/main/protection/required_status_checks/contexts",' +
  '"checks":[{"context":"test (ubuntu-latest)","app_id":15368},{"context":"test (macos-latest)","app_id":15368},{"context":"security","app_id":15368}]},' +
  '"required_signatures":{"url":"https://api.github.com/repos/Kanevry/session-orchestrator/branches/main/protection/required_signatures","enabled":false},' +
  '"enforce_admins":{"url":"https://api.github.com/repos/Kanevry/session-orchestrator/branches/main/protection/enforce_admins","enabled":false},' +
  '"required_linear_history":{"enabled":true},"allow_force_pushes":{"enabled":false},"allow_deletions":{"enabled":false},' +
  '"block_creations":{"enabled":false},"required_conversation_resolution":{"enabled":false},"lock_branch":{"enabled":false},' +
  '"allow_fork_syncing":{"enabled":false}}';

/** Records every call so tests can assert the NOT-called case. */
function makeExecStub(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  return fn;
}

/** Route `gh repo view` / `gh auth status` / `gh api .../protection` to distinct canned responses. */
function makeGhRouter({ repoView, authStatus, protection }) {
  return makeExecStub(async (cmd, args) => {
    if (cmd !== 'gh') throw new Error(`unexpected command: ${cmd}`);
    const sub = args[0];
    if (sub === 'repo' && args[1] === 'view') return repoView();
    if (sub === 'auth' && args[1] === 'status') return authStatus();
    if (sub === 'api') return protection();
    throw new Error(`unrouted gh invocation: ${args.join(' ')}`);
  });
}

describe('auditGithubBranchProtection — the #1079 live scenario', () => {
  it('surfaces enforce-admins-disabled AND token-scope-too-broad for the measured live shape', async () => {
    const execFile = makeGhRouter({
      repoView: async () => ({ stdout: REPO_VIEW_STDOUT, stderr: '' }),
      authStatus: async () => ({ stdout: AUTH_STATUS_STDOUT, stderr: '' }),
      protection: async () => ({ stdout: PROTECTION_STDOUT, stderr: '' }),
    });

    const result = await auditGithubBranchProtection(
      { repoRoot: '/tmp/irrelevant' },
      { execFile, resolveRepoSpec: () => REPO_SPEC, resolveRepoHost: () => REPO_HOST },
    );

    expect(result.degraded).toBeUndefined();
    expect(result.repo).toBe('Kanevry/session-orchestrator');
    expect(result.branch).toBe('main');
    expect(result.enforce_admins).toBe(false);
    expect(result.required_status_checks).toEqual({
      strict: true,
      contexts: ['test (ubuntu-latest)', 'test (macos-latest)', 'security'],
    });
    expect(result.allow_force_pushes).toBe(false);
    expect(result.token_scopes).toEqual(['admin:public_key', 'gist', 'read:org', 'repo', 'workflow']);

    const ids = result.findings.map((f) => f.id);
    expect(ids).toContain('enforce-admins-disabled');
    expect(ids).toContain('token-scope-too-broad');
    // required_status_checks IS configured with contexts, so this finding must NOT fire —
    // a bug that always emits it would make every repo look mis-audited.
    expect(ids).not.toContain('no-required-status-checks');
  });

  it('derives required_pull_request_reviews from KEY PRESENCE, not a nested .enabled field', async () => {
    // The real API OMITS this key entirely when no review is required (see
    // PROTECTION_STDOUT above) and, when a review IS required, returns a nested
    // object with review-count/dismissal fields — NEVER an `.enabled` boolean.
    // A naive `protection?.required_pull_request_reviews?.enabled === true`
    // implementation would read `undefined` in BOTH cases and silently report
    // "no review required" even on a fully-protected branch. This test pins
    // the presence-based derivation against that regression.
    const protectedStdout = JSON.stringify({
      enforce_admins: { enabled: true },
      required_status_checks: { strict: true, contexts: ['ci'] },
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
      allow_force_pushes: { enabled: false },
    });
    const execFile = makeGhRouter({
      repoView: async () => ({ stdout: REPO_VIEW_STDOUT, stderr: '' }),
      authStatus: async () => ({ stdout: AUTH_STATUS_STDOUT, stderr: '' }),
      protection: async () => ({ stdout: protectedStdout, stderr: '' }),
    });

    const result = await auditGithubBranchProtection(
      { repoRoot: '/tmp/irrelevant' },
      { execFile, resolveRepoSpec: () => REPO_SPEC, resolveRepoHost: () => REPO_HOST },
    );

    expect(result.required_pull_request_reviews).toBe(true);
  });

  it('reports required_pull_request_reviews false when the key is genuinely absent (the measured live case)', async () => {
    const execFile = makeGhRouter({
      repoView: async () => ({ stdout: REPO_VIEW_STDOUT, stderr: '' }),
      authStatus: async () => ({ stdout: AUTH_STATUS_STDOUT, stderr: '' }),
      protection: async () => ({ stdout: PROTECTION_STDOUT, stderr: '' }),
    });

    const result = await auditGithubBranchProtection(
      { repoRoot: '/tmp/irrelevant' },
      { execFile, resolveRepoSpec: () => REPO_SPEC, resolveRepoHost: () => REPO_HOST },
    );

    expect(result.required_pull_request_reviews).toBe(false);
  });
});

describe('auditGithubBranchProtection — no-required-status-checks, asserted PRESENT', () => {
  it('fires no-required-status-checks when the protection response omits required_status_checks entirely', async () => {
    // Bug caught: the #1079 live-scenario test above asserts this finding is
    // ABSENT when checks ARE configured (`.not.toContain`) — but nothing
    // asserted the POSITIVE case, so an inverted `.length === 0` (or the
    // branch simply deleted) would ship silently: the finding would never
    // fire for ANY repo, and the whole audit would go quietly blind to the
    // one gap GitLab #1079 names ("a push can land with a red or absent CI
    // run").
    const noStatusChecksStdout = JSON.stringify({
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
    });
    const execFile = makeGhRouter({
      repoView: async () => ({ stdout: REPO_VIEW_STDOUT, stderr: '' }),
      authStatus: async () => ({ stdout: "github.com\n  - Token scopes: 'gist'\n", stderr: '' }),
      protection: async () => ({ stdout: noStatusChecksStdout, stderr: '' }),
    });

    const result = await auditGithubBranchProtection(
      { repoRoot: '/tmp/irrelevant' },
      { execFile, resolveRepoSpec: () => REPO_SPEC, resolveRepoHost: () => REPO_HOST },
    );

    expect(result.degraded).toBeUndefined();
    expect(result.required_status_checks).toBeNull();
    expect(result.findings.map((f) => f.id)).toContain('no-required-status-checks');
  });
});

describe('auditGithubBranchProtection — degraded reasons for a broken `gh repo view` (2 of 6 DEGRADED_REASONS)', () => {
  it.each([
    ['{}', 'parse-error'],
    ['not json', 'query-failed'],
  ])('gh repo view returning %j degrades to %j', async (repoViewStdout, expectedReason) => {
    // Bug caught: `parse-error` (valid JSON, unusable shape — missing
    // nameWithOwner/defaultBranchRef) and `query-failed` (JSON.parse THROWS on
    // genuinely invalid JSON, caught by the outer classifyFailure) are two of
    // the six DEGRADED_REASONS with no test reaching them at all — a swapped
    // or dropped return in either branch would ship unnoticed.
    const execFile = makeGhRouter({
      repoView: async () => ({ stdout: repoViewStdout, stderr: '' }),
      authStatus: async () => { throw new Error('auth status must not run when repo view already failed'); },
      protection: async () => { throw new Error('protection must not run when repo view already failed'); },
    });

    const result = await auditGithubBranchProtection(
      { repoRoot: '/tmp/irrelevant' },
      { execFile, resolveRepoSpec: () => REPO_SPEC, resolveRepoHost: () => REPO_HOST },
    );

    expect(result.degraded).toBe(expectedReason);
  });
});

describe('auditGithubBranchProtection — degraded (query could not be answered)', () => {
  it('a thrown gh invocation (ENOENT) degrades to cli-missing, never crashes or reports clean', async () => {
    const execFile = makeExecStub(async () => {
      const err = new Error('spawn gh ENOENT');
      err.code = 'ENOENT';
      throw err;
    });

    const result = await auditGithubBranchProtection(
      { repoRoot: '/tmp/irrelevant' },
      { execFile, resolveRepoSpec: () => REPO_SPEC, resolveRepoHost: () => REPO_HOST },
    );

    expect(result.degraded).toBe('cli-missing');
    expect(DEGRADED_REASONS).toContain(result.degraded);
    // A degraded result carries no findings/repo/branch keys a caller could
    // mistake for a real (clean) measurement.
    expect(result.findings).toBeUndefined();
    expect(result.repo).toBeUndefined();
  });

  it('an auth error (not logged in) degrades to auth-error, distinct from cli-missing', async () => {
    const execFile = makeExecStub(async () => {
      const err = new Error('failed to run gh: exit status 1');
      err.stderr = 'You are not logged into any GitHub hosts. Run gh auth login';
      throw err;
    });

    const result = await auditGithubBranchProtection(
      { repoRoot: '/tmp/irrelevant' },
      { execFile, resolveRepoSpec: () => REPO_SPEC, resolveRepoHost: () => REPO_HOST },
    );

    expect(result.degraded).toBe('auth-error');
  });

  it('returns no-github-remote and spawns NOTHING when the mirror remote does not resolve', async () => {
    const execFile = makeExecStub(async () => {
      throw new Error('execFile must not run when there is no github remote');
    });

    const result = await auditGithubBranchProtection(
      { repoRoot: '/tmp/irrelevant' },
      { execFile, resolveRepoSpec: () => undefined, resolveRepoHost: () => undefined },
    );

    expect(result.degraded).toBe('no-github-remote');
    expect(execFile.calls).toHaveLength(0);
  });
});

describe('auditGithubBranchProtection — branch not protected at all (404)', () => {
  it('treats a 404 from the protection endpoint as a measured, critical finding — not a degraded state', async () => {
    const execFile = makeGhRouter({
      repoView: async () => ({ stdout: REPO_VIEW_STDOUT, stderr: '' }),
      authStatus: async () => ({ stdout: AUTH_STATUS_STDOUT, stderr: '' }),
      protection: async () => {
        const err = new Error('gh: Branch not protected (HTTP 404)');
        err.stderr = 'gh: Branch not protected (HTTP 404)';
        throw err;
      },
    });

    const result = await auditGithubBranchProtection(
      { repoRoot: '/tmp/irrelevant' },
      { execFile, resolveRepoSpec: () => REPO_SPEC, resolveRepoHost: () => REPO_HOST },
    );

    expect(result.degraded).toBeUndefined();
    expect(result.enforce_admins).toBe(false);
    expect(result.findings.map((f) => f.id)).toContain('branch-not-protected');
    expect(result.findings.find((f) => f.id === 'branch-not-protected').severity).toBe('critical');
  });
});

describe('parseTokenScopes — gh auth status text parsing', () => {
  it('extracts and unquotes the comma-separated scope list', () => {
    expect(parseTokenScopes(AUTH_STATUS_STDOUT)).toEqual([
      'admin:public_key',
      'gist',
      'read:org',
      'repo',
      'workflow',
    ]);
  });

  it('returns an empty array when no Token scopes line is present', () => {
    expect(parseTokenScopes('github.com\n  ✓ Logged in\n')).toEqual([]);
  });
});

describe('UNSAFE_TOKEN_SCOPES', () => {
  it('includes the specific scope GitLab #1079 names as too broad', () => {
    expect(UNSAFE_TOKEN_SCOPES).toContain('repo');
  });
});
