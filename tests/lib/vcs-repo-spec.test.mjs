/**
 * tests/lib/vcs-repo-spec.test.mjs
 *
 * Unit tests for scripts/lib/vcs-repo-spec.mjs (#839, #872, #907, #1039).
 *
 * Pure DI — no `node:child_process` mocking. Every exported function accepts an
 * injectable `gitRun`, so these tests need neither real git nor real glab/gh.
 *
 * #1039 stub-protocol note: the module now reads its remotes from ONE
 * `git remote -v` spawn instead of one `git remote get-url <name>` spawn per
 * preference entry. The stubs below therefore emit real `remote -v` output
 * (`<name>\t<url> (fetch)` — TAB after the name, SPACE before the direction
 * marker, verified against `git remote -v | sed -n l` in this repo) rather than
 * a bare URL. The ASSERTIONS are unchanged; only the fake's protocol moved.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveRepoSpec,
  resolveRepoHost,
  resolveGitlabProjectTarget,
  defaultGlabRepo,
  stripUrlCredentials,
  redactUrlCredentials,
  listRemotes,
  resolvePreferredRemote,
  detectVcsFamily,
  resolveBaselineRange,
  REMOTE_RESOLUTION_REASONS,
  isQueryFailure,
} from '../../scripts/lib/vcs-repo-spec.mjs';

/* ---------------------------------------------------------------- helpers */

/** Render a `{name: url}` map as verbatim `git remote -v` stdout. */
function remoteVOutput(remotes) {
  return Object.entries(remotes)
    .flatMap(([name, url]) => [`${name}\t${url} (fetch)\n`, `${name}\t${url} (push)\n`])
    .join('');
}

/** `gitRun` stub answering every call with the given remote map (exit 0). */
function remotesRun(remotes) {
  const stdout = remoteVOutput(remotes);
  return () => ({ ok: true, stdout, stderr: '' });
}

/** `gitRun` stub answering every call with verbatim stdout (exit 0). */
function rawRun(stdout) {
  return () => ({ ok: true, stdout, stderr: '' });
}

/** `gitRun` stub answering every call with a failure. */
function failRun({ status, code, stderr = 'fatal: boom' } = {}) {
  return () => ({ ok: false, stdout: '', stderr, status, code });
}

/** Wrap a `gitRun` stub so the test can inspect how often / with what it ran. */
function counting(inner) {
  const calls = [];
  return {
    calls,
    fn: (args) => {
      calls.push(args);
      return inner(args);
    },
  };
}

/**
 * `gitRun` stub for `resolveBaselineRange`: answers `remote -v` from `remotes`,
 * `symbolic-ref` from `symbolicHead`, and `rev-parse --verify --quiet <ref>`
 * from the `refs` allowlist (missing refs exit 1 with empty stdout, as real
 * `--quiet` git does). Branching lives HERE, in the fake — never in a test body.
 */
function refsRun({ remotes, symbolicHead = null, refs = [], hasHead = true }) {
  const stdout = remoteVOutput(remotes);
  const miss = { ok: false, stdout: '', stderr: '', status: 1 };
  return (args) => {
    const sub = args[2];
    if (sub === 'remote') return { ok: true, stdout, stderr: '' };
    if (sub === 'symbolic-ref') {
      return symbolicHead === null ? miss : { ok: true, stdout: `${symbolicHead}\n`, stderr: '' };
    }
    if (sub === 'rev-parse') {
      const ref = args[args.length - 1];
      if (ref === 'HEAD') return hasHead ? { ok: true, stdout: 'c0ffee\n', stderr: '' } : miss;
      return refs.includes(ref) ? { ok: true, stdout: 'deadbee\n', stderr: '' } : miss;
    }
    return miss;
  };
}

/* ------------------------------------------ frozen surface: resolveRepoSpec */

describe('resolveRepoSpec — gitlab (default vcs)', () => {
  it('prefers the gitlab remote URL over origin', () => {
    const fn = remotesRun({
      gitlab: 'https://host/g/repo.git',
      origin: 'https://host/g/other.git',
    });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'https://host/g/repo.git',
    );
  });

  it('falls back to origin when gitlab remote is absent', () => {
    const fn = remotesRun({ origin: 'git@host:g/repo.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'git@host:g/repo.git',
    );
  });

  it('returns undefined when neither gitlab nor origin resolves (missing-remote case)', () => {
    const fn = failRun({ stderr: 'no such remote' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('returns undefined when a remote resolves but the URL is blank/whitespace-only', () => {
    const fn = rawRun('   \n');
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  // Bug: a preference reordering silently switches the `-R` target of all 13
  // production importers in any repo that has BOTH remotes. Asserted on the
  // resolved VALUE rather than on spawn order — since #1039 there is only one
  // spawn, so a call-order assertion has no subject left to observe.
  it('resolves gitlab, not origin, when BOTH remotes exist (preference order)', () => {
    const fn = remotesRun({
      github: 'https://github.com/o/r.git',
      gitlab: 'https://gitlab.example.com/g/wanted.git',
      origin: 'https://gitlab.example.com/g/other.git',
    });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'https://gitlab.example.com/g/wanted.git',
    );
  });

  it('defaults vcs to gitlab when omitted', () => {
    const fn = remotesRun({ gitlab: 'https://host/g/repo.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', gitRun: fn })).toBe('https://host/g/repo.git');
  });
});

describe('resolveRepoSpec — github (normalized HOST/OWNER/REPO, #872)', () => {
  it('prefers the github remote URL over origin, normalized to HOST/OWNER/REPO', () => {
    const fn = remotesRun({
      github: 'https://github.example.com/owner/repo.git',
      origin: 'https://github.example.com/owner/other.git',
    });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/owner/repo',
    );
  });

  it('falls back to origin when github remote is absent, normalized to HOST/OWNER/REPO', () => {
    const fn = remotesRun({ origin: 'git@github.example.com:owner/repo.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/owner/repo',
    );
  });

  // Bug: a gitlab-named remote leaking into the github preference list points
  // `gh -R` at a GitLab project. Asserted on the resolved VALUE (see the
  // preference-order note above).
  it('never resolves a gitlab-named remote when vcs is github', () => {
    const fn = remotesRun({
      gitlab: 'https://gitlab.example.com/g/wrong.git',
      origin: 'https://github.example.com/owner/right.git',
    });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/owner/right',
    );
  });

  it('normalizes an HTTPS github URL to host/owner/repo, stripping the .git suffix', () => {
    const fn = remotesRun({ origin: 'https://github.example.com/owner/repo.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/owner/repo',
    );
  });

  it('normalizes an SSH github URL to host/owner/repo, stripping the .git suffix', () => {
    const fn = remotesRun({ origin: 'git@github.example.com:owner/repo.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/owner/repo',
    );
  });

  it('lowercases the host but preserves owner/repo casing during normalization', () => {
    const fn = remotesRun({ origin: 'https://GitHub.Example.Com/Owner/Repo.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/Owner/Repo',
    );
  });
});

describe('resolveRepoSpec — repoRoot plumbing', () => {
  it('passes repoRoot through to gitRun as -C <repoRoot> on a single `remote -v` call', () => {
    const { fn, calls } = counting(remotesRun({ gitlab: 'https://host/g/repo.git' }));
    resolveRepoSpec({ repoRoot: '/some/repo/root', vcs: 'gitlab', gitRun: fn });
    expect(calls).toEqual([['-C', '/some/repo/root', 'remote', '-v']]);
  });

  it('defaults repoRoot to process.cwd() when omitted', () => {
    const { fn, calls } = counting(failRun({ stderr: 'no such remote' }));
    resolveRepoSpec({ vcs: 'gitlab', gitRun: fn });
    expect(calls[0][1]).toBe(process.cwd());
  });
});

describe('resolveRepoSpec — cross-VCS-family fallback guard (#839 follow-up)', () => {
  // A repo with vcs:'gitlab' and no gitlab-named remote falls back to origin
  // verbatim — even when origin resolves to the OTHER platform's well-known
  // public host. Passing that spec to `glab -R` is a guaranteed hard failure
  // (host doesn't correspond to any GitLab instance), which is strictly worse
  // than the pre-#839 ambient-resolution behaviour this module replaced.
  it('does NOT fall back to an origin remote whose host is the public github.com, when vcs is gitlab', () => {
    const fn = remotesRun({ origin: 'https://github.com/example-group/example-project.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('does NOT fall back to an origin remote whose host is the public gitlab.com, when vcs is github', () => {
    const fn = remotesRun({ origin: 'git@gitlab.com:example-group/example-project.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBeUndefined();
  });

  it('rejects a github.com ssh URL when vcs is gitlab', () => {
    const fn = remotesRun({ gitlab: 'ssh://git@github.com/example-group/example-project.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('rejects a wrong-family host even on the FIRST-preference remote name, not only the origin fallback', () => {
    const fn = remotesRun({ gitlab: 'https://github.com/example-group/example-project.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('still resolves a same-family self-hosted origin URL normally (no false-positive rejection)', () => {
    const fn = remotesRun({ origin: 'https://gitlab.example.com/example-group/example-project.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'https://gitlab.example.com/example-group/example-project.git',
    );
  });

  it('still resolves the correct-family public host normally (github.com under vcs:github), normalized', () => {
    const fn = remotesRun({ origin: 'https://github.com/example-group/example-project.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.com/example-group/example-project',
    );
  });

  // #1039: the sole-remote fallback must NOT become a hole in the cross-family
  // guard. Bug it catches: a fork whose only remote is a github.com URL would
  // otherwise resolve under vcs:'gitlab' and hand `glab -R` a spec it is
  // guaranteed to reject — the exact regression the guard above prevents on the
  // preference path.
  it('does NOT let the sole-remote fallback bypass the cross-family guard', () => {
    const fn = remotesRun({ upstream: 'https://github.com/example-group/example-project.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });
});

describe('resolveRepoSpec — github normalization malformed-input fallback', () => {
  it('falls back to the raw URL when the remote does not match a two-segment owner/repo shape', () => {
    const fn = remotesRun({ origin: 'https://github.example.com/just-one-segment' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'https://github.example.com/just-one-segment',
    );
  });

  // Q2-MED test-gap fix pass (#872 follow-up): pins the ACTUAL, already-shipped
  // normalizeGithubSpec fallback behaviour for two under-tested edge cases —
  // read the implementation FIRST, do not assume a "should" behaviour.

  it('falls back to the raw URL for an SSH remote with an explicit port (sshMatch has no port slot)', () => {
    // sshMatch's regex is `user@host:owner/repo(.git)?` — a `:2222` port
    // segment before `owner/repo` breaks that shape (the regex captures
    // "2222" as the would-be owner slot, then cannot also match the
    // remaining "/owner/repo.git" as the repo slot — anchored end fails).
    // normalizeGithubSpec's documented fallback ("returns url unchanged when
    // it does not match the expected host/owner/repo shape") fires here.
    const fn = remotesRun({ origin: 'ssh://git@github.example.com:2222/owner/repo.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'ssh://git@github.example.com:2222/owner/repo.git',
    );
  });

  it('falls back to the raw URL for a 3+ path-segment HTTPS remote (no owner/sub/repo support)', () => {
    // httpsMatch's regex captures exactly host/owner/repo (two path segments
    // after the host) — a third segment ("org/sub/repo") does not match the
    // anchored `([^/]+)\/([^/]+?)(?:\.git)?\/?$` tail, so normalizeGithubSpec
    // falls back to the raw URL, same documented behaviour as the
    // one-segment case above.
    const fn = remotesRun({ origin: 'https://github.example.com/org/sub/repo.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'https://github.example.com/org/sub/repo.git',
    );
  });
});

describe('resolveRepoSpec / resolveRepoHost — argv-boundary guard (#872 follow-up, Q3-LOW)', () => {
  // A well-formed remote URL/host never legitimately contains whitespace or a
  // control character. These tests plant one via the gitRun DI seam (a
  // corrupted/malicious .git/config is the realistic source) and assert the
  // guard degrades to `undefined` rather than forwarding an unsafe token.

  it('resolveRepoSpec (gitlab) returns undefined when the raw remote URL has an embedded space', () => {
    const fn = remotesRun({ origin: 'https://host/g/re po.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('resolveRepoSpec (gitlab) returns undefined when the raw remote URL has an embedded TAB', () => {
    // Pre-#1039 this case was written with an embedded NEWLINE. A newline can
    // no longer reach the guard: it splits the `remote -v` record in two, and
    // neither half matches the line shape, so the URL never becomes a
    // candidate at all (covered separately in the listRemotes block below).
    // A TAB is the character that still travels INSIDE one record — it is
    // whitespace and C0, so the guard is what must reject it, and this test
    // still goes red if the guard is removed.
    const fn = remotesRun({ origin: 'https://host/g/re\tpo.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('resolveRepoSpec (github) returns undefined when the normalized HOST/OWNER/REPO spec has an embedded space', () => {
    const fn = remotesRun({ origin: 'https://github.example.com/owner/re po.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBeUndefined();
  });

  it('resolveRepoHost returns undefined when the extracted host has an embedded space', () => {
    const fn = remotesRun({ origin: 'https://ho st/owner/repo.git' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('resolvePreferredRemote reports the unsafe value as `unsafe-value`, not as an absence', () => {
    // Bug: folding an unsafe value into `no-matching-remote` tells the caller
    // "this repo has no suitable remote" when the truth is "this repo's config
    // is corrupt" — an operator chasing the wrong problem.
    const fn = remotesRun({ origin: 'https://host/g/re po.git' });
    const res = resolvePreferredRemote({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(res).toEqual({
      ok: false,
      reason: 'unsafe-value',
      remotes: [{ name: 'origin', url: 'https://host/g/re po.git' }],
    });
  });
});

describe('resolveRepoSpec / resolveRepoHost — embedded-credential stripping (#907, CWE-214)', () => {
  // A GitLab-CI checkout produces a remote of the form
  // `https://gitlab-ci-token:<MASKED>@host/group/project.git`. That userinfo
  // credential must never reach a `-R`/`--repo` argv position (ps /
  // /proc/<pid>/cmdline visible) nor a verbose log line. resolveRepoSpec strips
  // it AT THE SOURCE. Per testing.md § "Security Tests Must Not Encode the
  // Vulnerability", the assertions pin the REDACTED (safe) output as correct —
  // never the credential-bearing form as expected.

  it('strips user:token@ userinfo from an HTTPS gitlab remote (source strip)', () => {
    const fn = remotesRun({
      origin: 'https://gitlab-ci-token:glpat-SECRET123@gitlab.example.com/group/project.git',
    });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(spec).toBe('https://gitlab.example.com/group/project.git');
    expect(spec).not.toContain('glpat-SECRET123');
    expect(spec).not.toContain('gitlab-ci-token');
    expect(spec).not.toContain('@');
  });

  it('strips a bare token userinfo (https://token@host) from an HTTPS remote', () => {
    const fn = remotesRun({ origin: 'https://glpat-BARE456@gitlab.example.com/group/project.git' });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(spec).toBe('https://gitlab.example.com/group/project.git');
    expect(spec).not.toContain('glpat-BARE456');
  });

  it('strips user:pass@ from an ssh:// URL (password-bearing SSH)', () => {
    const fn = remotesRun({ origin: 'ssh://git:SECRETPW@gitlab.example.com/group/project.git' });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(spec).toBe('ssh://gitlab.example.com/group/project.git');
    expect(spec).not.toContain('SECRETPW');
  });

  it('leaves scp-like SSH user (git@host:path) UNCHANGED — a bare SSH login is not a credential', () => {
    const fn = remotesRun({ origin: 'git@gitlab.example.com:group/project.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'git@gitlab.example.com:group/project.git',
    );
  });

  it('leaves a bare ssh:// login (ssh://git@host/path, no password) UNCHANGED', () => {
    const fn = remotesRun({ origin: 'ssh://git@gitlab.example.com/group/project.git' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'ssh://git@gitlab.example.com/group/project.git',
    );
  });

  it('leaves a credential-free HTTPS URL BYTE-IDENTICAL (normal-case regression guard)', () => {
    const url = 'https://gitlab.example.com/group/project.git';
    const fn = remotesRun({ origin: url });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(spec).toBe(url);
    expect(spec.length).toBe(url.length); // byte-for-byte, no truncation/rewrite
  });

  it('strips credentials from a github remote too, before HOST/OWNER/REPO normalization', () => {
    const fn = remotesRun({
      origin: 'https://x-access-token:ghp_SECRET@github.example.com/owner/repo.git',
    });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn });
    expect(spec).toBe('github.example.com/owner/repo');
    expect(spec).not.toContain('ghp_SECRET');
  });

  it('resolveRepoHost strips credentials before extracting the host', () => {
    const fn = remotesRun({
      origin: 'https://gitlab-ci-token:glpat-SECRET@gitlab.example.com/group/project.git',
    });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe('gitlab.example.com');
  });

  it('preserves an @ that appears in the PATH (not userinfo) of a credential-free URL', () => {
    // The `[^/@]+@` userinfo class stops at the first `/`, so a path-embedded
    // `@` (e.g. a ref) is never mistaken for a credential and is preserved.
    const fn = remotesRun({ origin: 'https://gitlab.example.com/group/project.git@ref' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'https://gitlab.example.com/group/project.git@ref',
    );
  });

  it('stripUrlCredentials strips the userinfo but preserves a path-embedded @', () => {
    expect(stripUrlCredentials('https://user:tok@gitlab.example.com/group/project.git@ref')).toBe(
      'https://gitlab.example.com/group/project.git@ref',
    );
  });

  it('redactUrlCredentials replaces embedded userinfo with *** in a log line (defense-in-depth)', () => {
    const line =
      'glab issue view 305 -R https://gitlab-ci-token:glpat-SECRET@gitlab.example.com/group/project.git';
    const redacted = redactUrlCredentials(line);
    expect(redacted).not.toContain('glpat-SECRET');
    expect(redacted).not.toContain('gitlab-ci-token');
    expect(redacted).toContain('https://***@gitlab.example.com/group/project.git');
  });

  it('redactUrlCredentials leaves a credential-free log line byte-identical', () => {
    const line = 'glab issue view 305 -R https://gitlab.example.com/group/project.git';
    expect(redactUrlCredentials(line)).toBe(line);
  });

  it('redactUrlCredentials leaves a scp-like SSH remote in a log line unchanged', () => {
    const line = 'push to git@gitlab.example.com:group/project.git';
    expect(redactUrlCredentials(line)).toBe(line);
  });

  // #907 MED-1 (W4 panel): a raw `@` INSIDE the token/password left a partial
  // credential behind when the userinfo class stopped at the first `@`. The
  // greedy match must bind `@` to the LAST `@` before the authority ends.
  it('strips the WHOLE userinfo when the token itself contains a raw @ (no partial-secret residual)', () => {
    const out = stripUrlCredentials('https://gitlab-ci-token:gl@pat-SECRET@gitlab.example.com/g/p.git');
    // The panel exploit: a first-@-only match left "pat-SECRET@" in the -R argv.
    expect(out).toBe('https://gitlab.example.com/g/p.git');
    expect(out).not.toContain('pat-SECRET');
    expect(out).not.toContain('gitlab-ci-token');
  });

  it('strips a nested user:pass@user:pass@host userinfo entirely', () => {
    expect(stripUrlCredentials('https://a:b@c:d@host/owner/repo.git')).toBe('https://host/owner/repo.git');
  });

  it('redacts a raw-@ token in a log line without leaving a partial secret', () => {
    const redacted = redactUrlCredentials(
      'glab -R https://gitlab-ci-token:gl@pat-SECRET@gitlab.example.com/g/p.git',
    );
    expect(redacted).not.toContain('pat-SECRET');
    expect(redacted).toContain('https://***@gitlab.example.com/g/p.git');
  });
});

describe('resolveRepoHost (#872)', () => {
  it('extracts the host from an HTTPS gitlab remote', () => {
    const fn = remotesRun({ origin: 'https://gitlab.example.com/example-group/example-project.git' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe('gitlab.example.com');
  });

  it('extracts the host from an SSH github remote', () => {
    const fn = remotesRun({ origin: 'git@github.example.com:owner/repo.git' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe('github.example.com');
  });

  it('extracts the host from an HTTPS github remote', () => {
    const fn = remotesRun({ origin: 'https://github.example.com/owner/repo.git' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe('github.example.com');
  });

  it('returns undefined when no remote resolves', () => {
    const fn = failRun({ stderr: 'no such remote' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('returns undefined when the resolved URL has no extractable host', () => {
    const fn = remotesRun({ origin: 'not-a-url' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('defaults vcs to gitlab when omitted, matching resolveRepoSpec default', () => {
    const fn = remotesRun({ gitlab: 'https://gitlab.example.com/example-group/example-project.git' });
    expect(resolveRepoHost({ repoRoot: '/repo', gitRun: fn })).toBe('gitlab.example.com');
  });
});

describe('resolveGitlabProjectTarget (#1065)', () => {
  // Bug: numeric project-ID resolution goes through `glab repo view`, which can
  // target ambient GITLAB_HOST rather than the sanitized remote selected here.
  it('derives host and a once-encoded nested path from an HTTPS GitLab remote', () => {
    const fn = remotesRun({
      gitlab: 'https://ci-token:glpat-SECRET@gitlab.example.com/group/subgroup/project.git',
    });

    const target = resolveGitlabProjectTarget({ repoRoot: '/repo', gitRun: fn });

    expect(target).toEqual({
      host: 'gitlab.example.com',
      encodedProjectPath: 'group%2Fsubgroup%2Fproject',
    });
    expect(JSON.stringify(target)).not.toContain('ci-token');
    expect(JSON.stringify(target)).not.toContain('glpat-SECRET');
  });

  // Bug: treating `user@host:path` as a URL loses the project namespace and
  // restores the ambient fallback that the API target must eliminate.
  it('derives host and a once-encoded nested path from a scp-style SSH remote', () => {
    const fn = remotesRun({ gitlab: 'git@gitlab.example.com:team/area/service.git' });

    expect(resolveGitlabProjectTarget({ repoRoot: '/repo', gitRun: fn })).toEqual({
      host: 'gitlab.example.com',
      encodedProjectPath: 'team%2Farea%2Fservice',
    });
  });

  // Bug: `ssh://` uses a slash-delimited path unlike scp-style SSH; rejecting
  // it makes legitimate nested GitLab projects silently unqueryable.
  it('derives host and a once-encoded nested path from an ssh URL remote', () => {
    const fn = remotesRun({ gitlab: 'ssh://git@gitlab.example.com/team/area/service.git' });

    expect(resolveGitlabProjectTarget({ repoRoot: '/repo', gitRun: fn })).toEqual({
      host: 'gitlab.example.com',
      encodedProjectPath: 'team%2Farea%2Fservice',
    });
  });

  it('rejects a github.com ssh URL instead of deriving a GitLab API target', () => {
    const fn = remotesRun({ gitlab: 'ssh://git@github.com/example-group/example-project.git' });
    expect(resolveGitlabProjectTarget({ repoRoot: '/repo', gitRun: fn })).toBeUndefined();
  });

  it('rejects a public GitHub HTTPS remote with an explicit port instead of deriving a GitLab target', () => {
    const fn = remotesRun({ gitlab: 'https://github.com:443/example-group/example-project.git' });
    expect(resolveGitlabProjectTarget({ repoRoot: '/repo', gitRun: fn })).toBeUndefined();
  });

  it('rejects a scp-style SSH project path containing traversal', () => {
    const fn = remotesRun({ gitlab: 'git@gitlab.example.com:group/../project.git' });
    expect(resolveGitlabProjectTarget({ repoRoot: '/repo', gitRun: fn })).toBeUndefined();
  });

  it.each([
    ['HTTPS', 'https://gitlab.example.com/group/%252e%252e/project.git'],
    ['ssh URI', 'ssh://git@gitlab.example.com/group/%252e%252e/project.git'],
  ])('rejects double-encoded traversal in a %s project path', (_transport, remote) => {
    const fn = remotesRun({ gitlab: remote });
    expect(resolveGitlabProjectTarget({ repoRoot: '/repo', gitRun: fn })).toBeUndefined();
  });

  it('preserves a non-default self-hosted GitLab port in the API target', () => {
    const fn = remotesRun({ gitlab: 'https://gitlab.example.com:8443/group/project.git' });
    expect(resolveGitlabProjectTarget({ repoRoot: '/repo', gitRun: fn })).toEqual({
      host: 'gitlab.example.com:8443',
      encodedProjectPath: 'group%2Fproject',
    });
  });

  // Bug: passing a malformed remote onward leaves glab to guess an ambient
  // project; target derivation must withhold an unprovable host/path pair.
  it('returns undefined when the selected remote has no project path', () => {
    const fn = remotesRun({ gitlab: 'https://gitlab.example.com/' });

    expect(resolveGitlabProjectTarget({ repoRoot: '/repo', gitRun: fn })).toBeUndefined();
  });
});

describe('defaultGlabRepo — back-compat positional alias', () => {
  it('delegates to resolveRepoSpec with vcs=gitlab, preserving the (repoRoot, gitRunFn) signature', () => {
    const fn = remotesRun({ gitlab: 'https://host/g/repo.git' });
    expect(defaultGlabRepo('/repo', fn)).toBe('https://host/g/repo.git');
  });

  it('falls back to origin, then undefined, matching resolveRepoSpec gitlab behaviour', () => {
    const originOnly = remotesRun({ origin: 'git@host:g/repo.git' });
    expect(defaultGlabRepo('/repo', originOnly)).toBe('git@host:g/repo.git');
    expect(defaultGlabRepo('/repo', failRun({ stderr: 'no remote' }))).toBeUndefined();
  });
});

/* ------------------------------------------------- #1039: listRemotes (T1-T3) */

describe('listRemotes — absence vs query failure (#1039)', () => {
  // T1. Bug: `harness-audit/categories/category6.mjs:145-155` awards 2/2 points
  // with "no github mirror remote configured — skipped" whenever its `git
  // remote` call returns null — which it also does OUTSIDE a git repo. A
  // fail-open scoring 100%. `ok:false` + `not-a-git-repo` is what makes that
  // state distinguishable from a genuine absence.
  it('reports exit 128 as {ok:false, reason:"not-a-git-repo"} — NOT as an empty remote list', () => {
    const res = listRemotes({ repoRoot: '/not/a/repo', gitRun: failRun({ status: 128, stderr: 'fatal: not a git repository' }) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not-a-git-repo');
    expect(res).not.toHaveProperty('remotes');
  });

  // T2. Bug: reporting a fresh `git init` as a tool failure trains operators to
  // ignore the warning, which then also hides the real failures.
  it('reports exit 0 with empty stdout as {ok:true, remotes:[]} — a valid, benign answer', () => {
    const res = listRemotes({ repoRoot: '/fresh/init', gitRun: rawRun('') });
    expect(res).toEqual({ ok: true, remotes: [] });
  });

  // T3. Bug: "git is not on PATH" landing in the same bucket as "no remote
  // configured" means a broken toolchain reads as a clean repo.
  it('reports a spawn ENOENT as {ok:false, reason:"git-unavailable"}', () => {
    const res = listRemotes({ repoRoot: '/repo', gitRun: failRun({ code: 'ENOENT', stderr: 'spawn git ENOENT' }) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('git-unavailable');
  });

  it('reports any other non-zero exit as the generic {ok:false, reason:"git-error"}', () => {
    const res = listRemotes({ repoRoot: '/repo', gitRun: failRun({ status: 1, stderr: 'fatal: whatever' }) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('git-error');
    expect(res.stderr).toBe('fatal: whatever');
  });

  it('classifies an injected stub that reports failure WITHOUT an exit code as git-error', () => {
    // Bug: the DI contract must stay back-compatible — a stub returning only
    // {ok,stdout,stderr} (every pre-#1039 test double) must not crash or be
    // mis-classified as "not a git repo".
    const res = listRemotes({ repoRoot: '/repo', gitRun: () => ({ ok: false, stdout: '', stderr: 'x' }) });
    expect(res.reason).toBe('git-error');
  });
});

describe('listRemotes — parsing (#1039)', () => {
  it('returns fetch URLs only, one entry per remote, in git output order', () => {
    // Bug: emitting both the fetch and the push line doubles every remote, so a
    // "sole remote" repo looks like it has two and loses the sole-remote path.
    const fn = remotesRun({
      github: 'https://github.com/o/r.git',
      origin: 'git@gitlab.example.com:g/p.git',
    });
    expect(listRemotes({ repoRoot: '/repo', gitRun: fn })).toEqual({
      ok: true,
      remotes: [
        { name: 'github', url: 'https://github.com/o/r.git' },
        { name: 'origin', url: 'git@gitlab.example.com:g/p.git' },
      ],
    });
  });

  // T13. #907 regression over the NEW code path: the credential strip moved
  // into listRemotes, so a leak here reaches every consumer at once.
  it('strips a gitlab-ci-token credential from every URL it reports', () => {
    const fn = remotesRun({
      origin: 'https://gitlab-ci-token:glpat-SECRET789@gitlab.example.com/group/project.git',
    });
    const res = listRemotes({ repoRoot: '/repo', gitRun: fn });
    expect(res.remotes).toEqual([
      { name: 'origin', url: 'https://gitlab.example.com/group/project.git' },
    ]);
    expect(JSON.stringify(res)).not.toContain('glpat-SECRET789');
  });

  it('captures a URL containing a space whole, rather than truncating at the space', () => {
    // Bug: splitting the record on whitespace turns a corrupt URL into a
    // TRUNCATED but argv-SAFE one, which then sails past the argv guard and is
    // handed to glab as a plausible-looking wrong target.
    const fn = rawRun('origin\thttps://host/g/re po.git (fetch)\n');
    expect(listRemotes({ repoRoot: '/repo', gitRun: fn }).remotes).toEqual([
      { name: 'origin', url: 'https://host/g/re po.git' },
    ]);
  });

  it('drops a record split by an embedded newline instead of inventing a remote from the tail', () => {
    // Bug: the second half of a newline-split record parses as a remote named
    // after the URL fragment ("po.git"), which then becomes a resolution
    // candidate. Dropping unparseable lines is the only safe reading.
    const fn = rawRun('origin\thttps://host/g/re\npo.git (fetch)\n');
    expect(listRemotes({ repoRoot: '/repo', gitRun: fn })).toEqual({ ok: true, remotes: [] });
  });

  it('tolerates CRLF line endings', () => {
    const fn = rawRun('origin\thttps://gitlab.example.com/g/p.git (fetch)\r\norigin\thttps://gitlab.example.com/g/p.git (push)\r\n');
    expect(listRemotes({ repoRoot: '/repo', gitRun: fn }).remotes).toEqual([
      { name: 'origin', url: 'https://gitlab.example.com/g/p.git' },
    ]);
  });

  // T14. Bug: one `git remote get-url` spawn PER preference entry on the
  // session-start hot path — O(N) process spawns for a question git answers in
  // one call.
  it('runs EXACTLY ONE git call regardless of how many remotes exist', () => {
    const { fn, calls } = counting(
      remotesRun({
        a: 'https://gitlab.example.com/g/a.git',
        b: 'https://gitlab.example.com/g/b.git',
        gitlab: 'https://gitlab.example.com/g/c.git',
        origin: 'https://gitlab.example.com/g/d.git',
      }),
    );
    listRemotes({ repoRoot: '/repo', gitRun: fn });
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['-C', '/repo', 'remote', '-v']);
  });

  it('resolveRepoSpec also costs exactly one git call (hot-path regression guard)', () => {
    const { fn, calls } = counting(
      remotesRun({
        github: 'https://github.com/o/r.git',
        gitlab: 'https://gitlab.example.com/g/p.git',
        origin: 'https://gitlab.example.com/g/o.git',
      }),
    );
    resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(calls.length).toBe(1);
  });
});

/* --------------------------------- #1039: resolvePreferredRemote (T4-T6, T12) */

describe('resolvePreferredRemote — the #1039 blind spot (T4)', () => {
  // T4. Bug: four probes resolved their remote as the hard-coded literal
  // `origin` and were therefore blind in any repo whose remotes are named
  // `gitlab`/`github` — silently measuring nothing.
  it('resolves the gitlab remote in a repo with NO origin, under vcs:gitlab', () => {
    const fn = remotesRun({
      github: 'https://github.com/o/r.git',
      gitlab: 'https://gitlab.example.com/g/p.git',
    });
    expect(resolvePreferredRemote({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toEqual({
      ok: true,
      name: 'gitlab',
      url: 'https://gitlab.example.com/g/p.git',
      via: 'preference',
    });
  });

  it('resolves the github remote in a repo with NO origin, under vcs:github', () => {
    const fn = remotesRun({
      github: 'https://github.com/o/r.git',
      gitlab: 'https://gitlab.example.com/g/p.git',
    });
    expect(resolvePreferredRemote({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toEqual({
      ok: true,
      name: 'github',
      url: 'https://github.com/o/r.git',
      via: 'preference',
    });
  });
});

describe('resolvePreferredRemote — sole-remote fallback (T5)', () => {
  // T5. Bug: a fork or a hand-named clone (`upstream`, `gl`) resolves NOTHING
  // even with the pre-#1039 helper, because the only remote it has is not in
  // any preference list.
  it('uses the only configured remote when it matches no preference name', () => {
    const fn = remotesRun({ upstream: 'https://gitlab.example.com/g/fork.git' });
    expect(resolvePreferredRemote({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toEqual({
      ok: true,
      name: 'upstream',
      url: 'https://gitlab.example.com/g/fork.git',
      via: 'sole-remote',
    });
  });

  it('uses the only configured remote in the vcs-less form too', () => {
    const fn = remotesRun({ upstream: 'https://gitlab.example.com/g/fork.git' });
    const res = resolvePreferredRemote({ repoRoot: '/repo', gitRun: fn });
    expect(res).toEqual({
      ok: true,
      name: 'upstream',
      url: 'https://gitlab.example.com/g/fork.git',
      via: 'sole-remote',
    });
  });

  it('marks a preference hit as via:"preference", never as via:"sole-remote"', () => {
    // Bug: reporting every single-remote repo as `sole-remote` erases the
    // distinction the `via` field exists to carry — the caller can no longer
    // tell a deliberate `origin` from a guessed fallback.
    const fn = remotesRun({ origin: 'https://gitlab.example.com/g/p.git' });
    expect(resolvePreferredRemote({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn }).via).toBe('preference');
  });
});

describe('resolvePreferredRemote — refuses to guess (T6) and reports absence (T12)', () => {
  // T6. Bug: picking arbitrarily among unmatched remotes means the probe
  // SUCCEEDS against the wrong project — a silent wrong answer, not an error.
  it('returns no-matching-remote (with the full list) for >=2 unmatched remotes', () => {
    const fn = remotesRun({
      fork: 'https://gitlab.example.com/g/fork.git',
      mirror: 'https://gitlab.example.com/g/mirror.git',
    });
    expect(resolvePreferredRemote({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toEqual({
      ok: false,
      reason: 'no-matching-remote',
      remotes: [
        { name: 'fork', url: 'https://gitlab.example.com/g/fork.git' },
        { name: 'mirror', url: 'https://gitlab.example.com/g/mirror.git' },
      ],
    });
  });

  // T12. Bug: "no remotes" and "not a git repo" collapsing into one silent
  // bucket is the category6.mjs fail-open. They must be separable BY VALUE.
  it('reports zero remotes as no-remotes, distinguishable from not-a-git-repo', () => {
    const noRemotes = resolvePreferredRemote({ repoRoot: '/repo', vcs: 'gitlab', gitRun: rawRun('') });
    const noRepo = resolvePreferredRemote({
      repoRoot: '/repo',
      vcs: 'gitlab',
      gitRun: failRun({ status: 128 }),
    });
    expect(noRemotes.reason).toBe('no-remotes');
    expect(noRepo.reason).toBe('not-a-git-repo');
    expect(noRemotes.reason).not.toBe(noRepo.reason);
    expect(isQueryFailure(noRemotes.reason)).toBe(false);
    expect(isQueryFailure(noRepo.reason)).toBe(true);
  });

  it('propagates a query failure verbatim instead of degrading it to an absence', () => {
    const res = resolvePreferredRemote({
      repoRoot: '/repo',
      vcs: 'gitlab',
      gitRun: failRun({ code: 'ENOENT', stderr: 'spawn git ENOENT' }),
    });
    expect(res).toEqual({ ok: false, reason: 'git-unavailable', stderr: 'spawn git ENOENT' });
  });

  it('uses origin-first ordering when vcs is omitted (operator decision, not a bug)', () => {
    // Bug this ordering PREVENTS: a gitlab-first vcs-less order would resolve
    // this repo's identity to the GitHub mirror namespace and silently rename
    // every existing vault note from infrastructure/… to Kanevry/….
    const fn = remotesRun({
      github: 'https://github.com/Kanevry/session-orchestrator.git',
      gitlab: 'https://gitlab.example.com/infrastructure/session-orchestrator.git',
      origin: 'git@gitlab.example.com:infrastructure/session-orchestrator.git',
    });
    expect(resolvePreferredRemote({ repoRoot: '/repo', gitRun: fn }).name).toBe('origin');
  });

  it('applies no cross-family guard in the vcs-less form', () => {
    // Bug: applying a gitlab-flavoured guard to a vcs-LESS query would make a
    // pure-GitHub repo unresolvable for baseline/family callers that have no
    // vcs opinion at all.
    const fn = remotesRun({ origin: 'https://github.com/o/r.git' });
    expect(resolvePreferredRemote({ repoRoot: '/repo', gitRun: fn })).toEqual({
      ok: true,
      name: 'origin',
      url: 'https://github.com/o/r.git',
      via: 'preference',
    });
  });
});

/* ------------------------------------------ #1039: detectVcsFamily (T8, T9) */

describe('detectVcsFamily (#1039)', () => {
  // T8. Bug: a substring test like url.includes('github.com') classifies GitHub
  // Enterprise (github.example.com) as gitlab and points `glab` at a GitHub
  // instance — a guaranteed hard failure with a confusing error.
  it('classifies a GitHub Enterprise host (github.example.com) as github, not gitlab', () => {
    const fn = remotesRun({ origin: 'git@github.example.com:o/r.git' });
    const res = detectVcsFamily({ repoRoot: '/repo', gitRun: fn });
    expect(res.vcs).toBe('github');
    expect(res.via).toBe('host-match');
  });

  it('classifies a self-hosted gitlab host (gitlab.example.com) as gitlab', () => {
    const fn = remotesRun({ origin: 'https://gitlab.example.com/g/p.git' });
    expect(detectVcsFamily({ repoRoot: '/repo', gitRun: fn }).vcs).toBe('gitlab');
  });

  // T9. This repo's own shape: origin → GitLab primary, github → GitHub mirror.
  // Bug: silently answering "github" (git lists it FIRST, alphabetically) would
  // point every family-derived decision at the mirror.
  it('answers gitlab via origin and flags the github mirror as an alternative', () => {
    const fn = remotesRun({
      github: 'https://github.com/Kanevry/session-orchestrator.git',
      origin: 'git@gitlab.example.com:infrastructure/session-orchestrator.git',
    });
    expect(detectVcsFamily({ repoRoot: '/repo', gitRun: fn })).toEqual({
      ok: true,
      vcs: 'gitlab',
      name: 'origin',
      url: 'git@gitlab.example.com:infrastructure/session-orchestrator.git',
      via: 'host-match',
      ambiguous: true,
      alternatives: ['github'],
    });
  });

  it('is NOT ambiguous when every remote classifies into the same family', () => {
    const fn = remotesRun({
      backup: 'https://gitlab.example.com/g/backup.git',
      origin: 'https://gitlab.example.com/g/p.git',
    });
    const res = detectVcsFamily({ repoRoot: '/repo', gitRun: fn });
    expect(res.ambiguous).toBe(false);
    expect(res.alternatives).toEqual([]);
  });

  it('falls back to the remote NAME when the host carries no family signal', () => {
    // Bug: a self-hosted instance behind a vanity domain (git.example.com) has
    // no host signal at all; ignoring the remote name throws away the only
    // remaining evidence and defaults a GitHub mirror to gitlab.
    const fn = remotesRun({ github: 'https://git.example.com/o/r.git' });
    const res = detectVcsFamily({ repoRoot: '/repo', gitRun: fn });
    expect(res.vcs).toBe('github');
    expect(res.via).toBe('remote-name');
  });

  it('defaults to gitlab with via:"default" when nothing classifies (preserves today\'s behaviour)', () => {
    const fn = remotesRun({ origin: 'https://git.example.com/o/r.git' });
    expect(detectVcsFamily({ repoRoot: '/repo', gitRun: fn })).toEqual({
      ok: true,
      vcs: 'gitlab',
      name: 'origin',
      url: 'https://git.example.com/o/r.git',
      via: 'default',
      ambiguous: false,
      alternatives: [],
    });
  });

  it('refuses to name a representative among >=2 unclassifiable remotes', () => {
    // Bug: defaulting to gitlab is fine; naming an ARBITRARY remote as the
    // evidence for it is the #1039 error class in a new costume.
    const fn = remotesRun({
      fork: 'https://git.example.com/o/fork.git',
      mirror: 'https://git.example.com/o/mirror.git',
    });
    expect(detectVcsFamily({ repoRoot: '/repo', gitRun: fn }).reason).toBe('no-matching-remote');
  });

  it('propagates not-a-git-repo rather than defaulting to gitlab outside a repo', () => {
    const res = detectVcsFamily({ repoRoot: '/tmp', gitRun: failRun({ status: 128 }) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not-a-git-repo');
  });
});

/* ------------------------------------ #1039: resolveBaselineRange (T10, T11) */

describe('resolveBaselineRange (#1039)', () => {
  it('uses the remote HEAD symbolic ref when it is set', () => {
    const fn = refsRun({
      remotes: { origin: 'https://gitlab.example.com/g/p.git' },
      symbolicHead: 'origin/develop',
    });
    expect(resolveBaselineRange({ repoRoot: '/repo', gitRun: fn })).toEqual({
      ok: true,
      range: 'origin/develop...HEAD',
      base: 'origin/develop',
      remote: 'origin',
      via: 'remote-head',
    });
  });

  // T10. Bug: `refs/remotes/<R>/HEAD` is only populated by an explicit
  // `git remote set-head -a`. A freshly pushed repo never has it, so a
  // HEAD-only implementation resolves nothing there — the measurement is
  // silently skipped in exactly the repos that are newest.
  it('falls back to <remote>/main when the remote HEAD symbolic ref is missing', () => {
    const fn = refsRun({
      remotes: { origin: 'https://gitlab.example.com/g/p.git' },
      symbolicHead: null,
      refs: ['refs/remotes/origin/main'],
    });
    expect(resolveBaselineRange({ repoRoot: '/repo', gitRun: fn })).toEqual({
      ok: true,
      range: 'origin/main...HEAD',
      base: 'origin/main',
      remote: 'origin',
      via: 'remote-default-branch',
    });
  });

  // T11. Bug: hardcoding `main` makes the whole drift tripwire inert in every
  // `master` repo — it never fires and never says why.
  it('falls back to <remote>/master when only master exists', () => {
    const fn = refsRun({
      remotes: { origin: 'https://gitlab.example.com/g/p.git' },
      refs: ['refs/remotes/origin/master'],
    });
    const res = resolveBaselineRange({ repoRoot: '/repo', gitRun: fn });
    expect(res.range).toBe('origin/master...HEAD');
    expect(res.via).toBe('remote-default-branch');
  });

  it('resolves against a non-origin remote name (the #1039 blind spot, applied to ranges)', () => {
    const fn = refsRun({
      remotes: { gitlab: 'https://gitlab.example.com/g/p.git' },
      refs: ['refs/remotes/gitlab/main'],
    });
    const res = resolveBaselineRange({ repoRoot: '/repo', gitRun: fn });
    expect(res.range).toBe('gitlab/main...HEAD');
    expect(res.remote).toBe('gitlab');
  });

  it('falls back to a LOCAL default branch when no tracking ref exists', () => {
    const fn = refsRun({
      remotes: { origin: 'https://gitlab.example.com/g/p.git' },
      refs: ['refs/heads/main'],
    });
    expect(resolveBaselineRange({ repoRoot: '/repo', gitRun: fn })).toEqual({
      ok: true,
      range: 'main...HEAD',
      base: 'main',
      remote: 'origin',
      via: 'local-default-branch',
    });
  });

  it('withholds the local fallback when allowLocalFallback is false', () => {
    // Bug: a caller that needs a REMOTE-anchored baseline silently receiving a
    // local-branch one measures drift against a ref that knows nothing about
    // the remote — a number that looks like a measurement.
    const fn = refsRun({
      remotes: { origin: 'https://gitlab.example.com/g/p.git' },
      refs: ['refs/heads/main'],
    });
    expect(resolveBaselineRange({ repoRoot: '/repo', gitRun: fn, allowLocalFallback: false })).toEqual({
      ok: false,
      reason: 'no-tracking-ref',
    });
  });

  it('reports no-tracking-ref (never a root-commit range) when nothing resolves', () => {
    // Bug: a root-commit fallback yields a ratio against the ENTIRE history and
    // presents it as session drift. Operator decision: refuse instead.
    const fn = refsRun({ remotes: { origin: 'https://gitlab.example.com/g/p.git' }, refs: [] });
    const res = resolveBaselineRange({ repoRoot: '/repo', gitRun: fn });
    expect(res).toEqual({ ok: false, reason: 'no-tracking-ref' });
    expect(JSON.stringify(res)).not.toContain('...');
  });

  it('reports unborn-head when the repo has no commit at all', () => {
    const fn = refsRun({
      remotes: { origin: 'https://gitlab.example.com/g/p.git' },
      refs: [],
      hasHead: false,
    });
    expect(resolveBaselineRange({ repoRoot: '/repo', gitRun: fn }).reason).toBe('unborn-head');
  });

  it('propagates a remote-resolution failure instead of falling back to origin/main', () => {
    // Bug: the literal this function replaces (`origin/main...HEAD` at
    // scope-baseline.mjs:519) is precisely a hardcoded fallback — reintroducing
    // one here would restore the blind spot.
    const res = resolveBaselineRange({ repoRoot: '/repo', gitRun: failRun({ status: 128 }) });
    expect(res).toEqual({ ok: false, reason: 'not-a-git-repo', stderr: 'fatal: boom' });
  });

  it('always produces a THREE-dot range, matching the semantics of the literal it replaces', () => {
    const fn = refsRun({
      remotes: { origin: 'https://gitlab.example.com/g/p.git' },
      refs: ['refs/remotes/origin/main'],
    });
    expect(resolveBaselineRange({ repoRoot: '/repo', gitRun: fn }).range).toMatch(/\.\.\.HEAD$/);
  });
});

/* ------------------------------------- #1039: reason enum + isQueryFailure */

describe('REMOTE_RESOLUTION_REASONS / isQueryFailure (#1039)', () => {
  it('splits query failures from absences exactly as documented', () => {
    // Bug: an absence mis-classified as a query failure makes a benign fresh
    // repo look broken; a query failure mis-classified as an absence is the
    // category6.mjs fail-open (2/2 points outside a git repo).
    const split = Object.fromEntries(REMOTE_RESOLUTION_REASONS.map((r) => [r, isQueryFailure(r)]));
    expect(split).toEqual({
      'not-a-git-repo': true,
      'git-unavailable': true,
      'git-error': true,
      'no-remotes': false,
      'no-matching-remote': false,
      'unsafe-value': false,
    });
  });

  it('treats an unknown or absent reason as NOT a query failure (fail-safe direction)', () => {
    expect(isQueryFailure(undefined)).toBe(false);
    expect(isQueryFailure('something-new')).toBe(false);
  });
});

/* ------------------------------------------------- T7: the freeze guarantee */

describe('resolveRepoSpec — frozen contract across the #1039 rewrite (T7)', () => {
  // T7. Bug: 13 production modules import resolveRepoSpec and pass its result
  // straight into `-R`/`--repo`. A preference reorder, a normalization change,
  // or a credential-strip regression retargets ALL of them at once, silently.
  // Every expected value below is a hardcoded literal — never derived.
  const SCENARIOS = [
    ['gitlab preferred over origin', { gitlab: 'https://host/g/repo.git', origin: 'https://host/g/other.git' }, 'gitlab', 'https://host/g/repo.git'],
    ['origin fallback (scp SSH)', { origin: 'git@host:g/repo.git' }, 'gitlab', 'git@host:g/repo.git'],
    ['github preferred over origin, normalized', { github: 'https://github.example.com/owner/repo.git', origin: 'https://github.example.com/owner/other.git' }, 'github', 'github.example.com/owner/repo'],
    ['github origin fallback, normalized from SSH', { origin: 'git@github.example.com:owner/repo.git' }, 'github', 'github.example.com/owner/repo'],
    ['cross-family: github.com under vcs gitlab', { origin: 'https://github.com/g/p.git' }, 'gitlab', undefined],
    ['cross-family: gitlab.com under vcs github', { origin: 'git@gitlab.com:g/p.git' }, 'github', undefined],
    ['credential stripped at the source', { origin: 'https://gitlab-ci-token:glpat-X@gitlab.example.com/g/p.git' }, 'gitlab', 'https://gitlab.example.com/g/p.git'],
    ['self-hosted gitlab origin, verbatim', { origin: 'https://gitlab.example.com/group/project.git' }, 'gitlab', 'https://gitlab.example.com/group/project.git'],
  ];

  it.each(SCENARIOS)('%s', (_label, remotes, vcs, expected) => {
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs, gitRun: remotesRun(remotes) })).toBe(expected);
  });

  it('returns undefined (never null, never a throw) when the repo is not a git repo', () => {
    expect(resolveRepoSpec({ repoRoot: '/tmp', vcs: 'gitlab', gitRun: failRun({ status: 128 }) })).toBeUndefined();
  });
});
