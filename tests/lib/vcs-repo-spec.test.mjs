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
import { resolveRepoSpec, defaultGlabRepo } from '../../scripts/lib/vcs-repo-spec.mjs';

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

describe('resolveRepoSpec — github', () => {
  it('prefers the github remote URL over origin', () => {
    const fn = (args) => {
      if (args.includes('github')) return { ok: true, stdout: 'https://github.com/org/repo.git\n', stderr: '' };
      return { ok: true, stdout: 'https://github.com/org/other.git\n', stderr: '' };
    };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'https://github.com/org/repo.git',
    );
  });

  it('falls back to origin when github remote is absent', () => {
    const fn = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'git@github.com:org/repo.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such remote' };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'git@github.com:org/repo.git',
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

  it('still resolves the correct-family public host normally (github.com under vcs:github)', () => {
    const fn = (args) =>
      args.includes('origin')
        ? { ok: true, stdout: 'https://github.com/example-group/example-project.git\n', stderr: '' }
        : { ok: false, stdout: '', stderr: 'no such remote' };
    expect(resolveRepoSpec({ repoRoot: '/repo', vcs: 'github', gitRun: fn })).toBe(
      'https://github.com/example-group/example-project.git',
    );
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
