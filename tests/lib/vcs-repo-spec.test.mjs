/**
 * tests/lib/vcs-repo-spec.test.mjs
 *
 * Unit tests for scripts/lib/vcs-repo-spec.mjs (#839).
 *
 * Pure DI — no `node:child_process` mocking. `resolveRepoSpec` accepts an
 * injectable `gitRun` function, so these tests need neither real git nor
 * real glab/gh.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveRepoSpec,
  resolveRepoHost,
  defaultGlabRepo,
  stripUrlCredentials,
  redactUrlCredentials,
} from '../../scripts/lib/vcs-repo-spec.mjs';

describe('resolveRepoSpec — gitlab (default vcs)', () => {
  it('prefers the gitlab remote URL over origin', () => {
    const fn = (args) => {
      if (args.includes('gitlab')) return { ok: true, stdout: 'https://host/g/repo.git\n', stderr: '' };
      return { ok: true, stdout: 'https://host/g/other.git\n', stderr: '' };
    };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'https://host/g/repo.git',
    );
  });

  it('falls back to origin when gitlab remote is absent', () => {
    const fn = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'git@host:g/repo.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such remote' };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'git@host:g/repo.git',
    );
  });

  it('returns undefined when neither gitlab nor origin resolves (missing-remote case)', () => {
    const fn = () => ({ ok: false, stdout: '', stderr: 'no such remote' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('returns undefined when a remote resolves but the URL is blank/whitespace-only', () => {
    const fn = () => ({ ok: true, stdout: '   \n', stderr: '' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('tries gitlab THEN origin, in that exact order (call-order assertion)', () => {
    const seen = [];
    const fn = (args) => {
      seen.push(args[args.length - 1]);
      return { ok: false, stdout: '', stderr: 'no such remote' };
    };
    resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(seen).toEqual(['gitlab', 'origin']);
  });

  it('defaults vcs to gitlab when omitted', () => {
    const fn = (args) =>
      args.includes('gitlab') ? { ok: true, stdout: 'https://host/g/repo.git\n', stderr: '' } : { ok: false, stdout: '', stderr: '' };
    expect(resolveRepoSpec({ repoRoot: '/repo', gitRun: fn })).toBe('https://host/g/repo.git');
  });
});

describe('resolveRepoSpec — github (normalized HOST/OWNER/REPO, #872)', () => {
  it('prefers the github remote URL over origin, normalized to HOST/OWNER/REPO', () => {
    const fn = (args) => {
      if (args.includes('github')) return { ok: true, stdout: 'https://github.example.com/owner/repo.git\n', stderr: '' };
      return { ok: true, stdout: 'https://github.example.com/owner/other.git\n', stderr: '' };
    };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/owner/repo',
    );
  });

  it('falls back to origin when github remote is absent, normalized to HOST/OWNER/REPO', () => {
    const fn = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'git@github.example.com:owner/repo.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such remote' };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/owner/repo',
    );
  });

  it('never tries a gitlab-named remote when vcs is github', () => {
    const seen = [];
    const fn = (args) => {
      seen.push(args[args.length - 1]);
      return { ok: false, stdout: '', stderr: 'no such remote' };
    };
    resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn });
    expect(seen).toEqual(['github', 'origin']);
    expect(seen).not.toContain('gitlab');
  });

  it('normalizes an HTTPS github URL to host/owner/repo, stripping the .git suffix', () => {
    const fn = () => ({ ok: true, stdout: 'https://github.example.com/owner/repo.git\n', stderr: '' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/owner/repo',
    );
  });

  it('normalizes an SSH github URL to host/owner/repo, stripping the .git suffix', () => {
    const fn = () => ({ ok: true, stdout: 'git@github.example.com:owner/repo.git\n', stderr: '' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/owner/repo',
    );
  });

  it('lowercases the host but preserves owner/repo casing during normalization', () => {
    const fn = () => ({ ok: true, stdout: 'https://GitHub.Example.Com/Owner/Repo.git\n', stderr: '' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.example.com/Owner/Repo',
    );
  });
});

describe('resolveRepoSpec — repoRoot plumbing', () => {
  it('passes repoRoot through to gitRun as -C <repoRoot>', () => {
    let seenArgs;
    const fn = (args) => {
      seenArgs = args;
      return { ok: true, stdout: 'https://host/g/repo.git\n', stderr: '' };
    };
    resolveRepoSpec({ repoRoot: '/some/repo/root', vcs: 'gitlab', gitRun: fn });
    expect(seenArgs).toEqual(['-C', '/some/repo/root', 'remote', 'get-url', 'gitlab']);
  });

  it('defaults repoRoot to process.cwd() when omitted', () => {
    let seenArgs;
    const fn = (args) => {
      seenArgs = args;
      return { ok: false, stdout: '', stderr: 'no such remote' };
    };
    resolveRepoSpec({ vcs: 'gitlab', gitRun: fn });
    expect(seenArgs[1]).toBe(process.cwd());
  });
});

describe('resolveRepoSpec — cross-VCS-family fallback guard (#839 follow-up)', () => {
  // A repo with vcs:'gitlab' and no gitlab-named remote falls back to origin
  // verbatim — even when origin resolves to the OTHER platform's well-known
  // public host. Passing that spec to `glab -R` is a guaranteed hard failure
  // (host doesn't correspond to any GitLab instance), which is strictly worse
  // than the pre-#839 ambient-resolution behaviour this module replaced.
  it('does NOT fall back to an origin remote whose host is the public github.com, when vcs is gitlab', () => {
    const fn = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'https://github.com/example-group/example-project.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such remote' };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('does NOT fall back to an origin remote whose host is the public gitlab.com, when vcs is github', () => {
    const fn = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'git@gitlab.com:example-group/example-project.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such remote' };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBeUndefined();
  });

  it('rejects a wrong-family host even on the FIRST-preference remote name, not only the origin fallback', () => {
    const fn = (args) =>
      args.includes('gitlab')
        ? { ok: true, stdout: 'https://github.com/example-group/example-project.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such remote' };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('still resolves a same-family self-hosted origin URL normally (no false-positive rejection)', () => {
    const fn = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'https://gitlab.example.com/example-group/example-project.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such remote' };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'https://gitlab.example.com/example-group/example-project.git',
    );
  });

  it('still resolves the correct-family public host normally (github.com under vcs:github), normalized', () => {
    const fn = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'https://github.com/example-group/example-project.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such remote' };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'github.com/example-group/example-project',
    );
  });
});

describe('resolveRepoSpec — github normalization malformed-input fallback', () => {
  it('falls back to the raw URL when the remote does not match a two-segment owner/repo shape', () => {
    const fn = () => ({ ok: true, stdout: 'https://github.example.com/just-one-segment\n', stderr: '' });
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
    const fn = () => ({ ok: true, stdout: 'ssh://git@github.example.com:2222/owner/repo.git\n', stderr: '' });
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
    const fn = () => ({ ok: true, stdout: 'https://github.example.com/org/sub/repo.git\n', stderr: '' });
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
    const fn = () => ({ ok: true, stdout: 'https://host/g/re po.git\n', stderr: '' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('resolveRepoSpec (gitlab) returns undefined when the raw remote URL has an embedded newline', () => {
    const fn = () => ({ ok: true, stdout: 'https://host/g/re\npo.git\n', stderr: '' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('resolveRepoSpec (github) returns undefined when the normalized HOST/OWNER/REPO spec has an embedded space', () => {
    const fn = () => ({ ok: true, stdout: 'https://github.example.com/owner/re po.git\n', stderr: '' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBeUndefined();
  });

  it('resolveRepoHost returns undefined when the extracted host has an embedded space', () => {
    const fn = () => ({ ok: true, stdout: 'https://ho st/owner/repo.git\n', stderr: '' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
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
    const fn = () => ({
      ok: true,
      stdout: 'https://gitlab-ci-token:glpat-SECRET123@gitlab.example.com/group/project.git\n',
      stderr: '',
    });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(spec).toBe('https://gitlab.example.com/group/project.git');
    expect(spec).not.toContain('glpat-SECRET123');
    expect(spec).not.toContain('gitlab-ci-token');
    expect(spec).not.toContain('@');
  });

  it('strips a bare token userinfo (https://token@host) from an HTTPS remote', () => {
    const fn = () => ({
      ok: true,
      stdout: 'https://glpat-BARE456@gitlab.example.com/group/project.git\n',
      stderr: '',
    });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(spec).toBe('https://gitlab.example.com/group/project.git');
    expect(spec).not.toContain('glpat-BARE456');
  });

  it('strips user:pass@ from an ssh:// URL (password-bearing SSH)', () => {
    const fn = () => ({
      ok: true,
      stdout: 'ssh://git:SECRETPW@gitlab.example.com/group/project.git\n',
      stderr: '',
    });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(spec).toBe('ssh://gitlab.example.com/group/project.git');
    expect(spec).not.toContain('SECRETPW');
  });

  it('leaves scp-like SSH user (git@host:path) UNCHANGED — a bare SSH login is not a credential', () => {
    const fn = () => ({ ok: true, stdout: 'git@gitlab.example.com:group/project.git\n', stderr: '' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'git@gitlab.example.com:group/project.git',
    );
  });

  it('leaves a bare ssh:// login (ssh://git@host/path, no password) UNCHANGED', () => {
    const fn = () => ({ ok: true, stdout: 'ssh://git@gitlab.example.com/group/project.git\n', stderr: '' });
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe(
      'ssh://git@gitlab.example.com/group/project.git',
    );
  });

  it('leaves a credential-free HTTPS URL BYTE-IDENTICAL (normal-case regression guard)', () => {
    const url = 'https://gitlab.example.com/group/project.git';
    const fn = () => ({ ok: true, stdout: `${url}\n`, stderr: '' });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn });
    expect(spec).toBe(url);
    expect(spec.length).toBe(url.length); // byte-for-byte, no truncation/rewrite
  });

  it('strips credentials from a github remote too, before HOST/OWNER/REPO normalization', () => {
    const fn = () => ({
      ok: true,
      stdout: 'https://x-access-token:ghp_SECRET@github.example.com/owner/repo.git\n',
      stderr: '',
    });
    const spec = resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn });
    expect(spec).toBe('github.example.com/owner/repo');
    expect(spec).not.toContain('ghp_SECRET');
  });

  it('resolveRepoHost strips credentials before extracting the host', () => {
    const fn = () => ({
      ok: true,
      stdout: 'https://gitlab-ci-token:glpat-SECRET@gitlab.example.com/group/project.git\n',
      stderr: '',
    });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe('gitlab.example.com');
  });

  it('preserves an @ that appears in the PATH (not userinfo) of a credential-free URL', () => {
    // The `[^/@]+@` userinfo class stops at the first `/`, so a path-embedded
    // `@` (e.g. a ref) is never mistaken for a credential and is preserved.
    const fn = () => ({ ok: true, stdout: 'https://gitlab.example.com/group/project.git@ref\n', stderr: '' });
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
});

describe('resolveRepoHost (#872)', () => {
  it('extracts the host from an HTTPS gitlab remote', () => {
    const fn = () => ({ ok: true, stdout: 'https://gitlab.example.com/example-group/example-project.git\n', stderr: '' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBe('gitlab.example.com');
  });

  it('extracts the host from an SSH github remote', () => {
    const fn = () => ({ ok: true, stdout: 'git@github.example.com:owner/repo.git\n', stderr: '' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe('github.example.com');
  });

  it('extracts the host from an HTTPS github remote', () => {
    const fn = () => ({ ok: true, stdout: 'https://github.example.com/owner/repo.git\n', stderr: '' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe('github.example.com');
  });

  it('returns undefined when no remote resolves', () => {
    const fn = () => ({ ok: false, stdout: '', stderr: 'no such remote' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('returns undefined when the resolved URL has no extractable host', () => {
    const fn = () => ({ ok: true, stdout: 'not-a-url\n', stderr: '' });
    expect(resolveRepoHost({ repoRoot: '/repo', vcs: 'gitlab', gitRun: fn })).toBeUndefined();
  });

  it('defaults vcs to gitlab when omitted, matching resolveRepoSpec default', () => {
    const fn = (args) =>
      args.includes('gitlab')
        ? { ok: true, stdout: 'https://gitlab.example.com/example-group/example-project.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: '' };
    expect(resolveRepoHost({ repoRoot: '/repo', gitRun: fn })).toBe('gitlab.example.com');
  });
});

describe('defaultGlabRepo — back-compat positional alias', () => {
  it('delegates to resolveRepoSpec with vcs=gitlab, preserving the (repoRoot, gitRunFn) signature', () => {
    const fn = (args) =>
      args.includes('gitlab') ? { ok: true, stdout: 'https://host/g/repo.git\n', stderr: '' } : { ok: false, stdout: '', stderr: '' };
    expect(defaultGlabRepo('/repo', fn)).toBe('https://host/g/repo.git');
  });

  it('falls back to origin, then undefined, matching resolveRepoSpec gitlab behaviour', () => {
    const originOnly = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'git@host:g/repo.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no remote' };
    expect(defaultGlabRepo('/repo', originOnly)).toBe('git@host:g/repo.git');
    expect(defaultGlabRepo('/repo', () => ({ ok: false, stdout: '', stderr: 'x' }))).toBeUndefined();
  });
});
