/**
 * tests/lib/git-config-drift.test.mjs
 *
 * Coverage for the runtime half of the 2026-08-19 `.git/config` contamination
 * incident (see the module header for the full narrative).
 *
 * Two bug classes are pinned here, and both need a NEGATIVE twin to mean
 * anything:
 *
 *  1. **Detection.** A fixture identity / fixture remote / local gpgsign in
 *     `.git/config` must produce a finding — and a clean repo must produce
 *     `null`. Without the clean-repo case, a probe that always warns passes.
 *  2. **Fail-open.** A query that could not be answered must be
 *     DISTINGUISHABLE from a clean repo. `null` folding both states is the
 *     defect class the whole incident turned on: the first recovery pass
 *     reported the tree clean because `git status` cannot see `.git/config`.
 *
 * Every case runs against a tmpdir repo with an explicitly-passed `env`, so
 * the suite never reads the operator's real global git config and — pointedly —
 * never writes into the real repository, which is the very failure this module
 * exists to detect.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEGRADED_REASONS,
  FINDING_KINDS,
  checkGitConfigDrift,
  isFixtureHost,
  parseNulConfigList,
  remoteHost,
} from '@lib/git-config-drift.mjs';

const GIT_AVAILABLE = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

/**
 * A deliberately EMPTY environment for the probe under test. Passing `{}`
 * removes HOME, so `git config --global` finds nothing and the "global" side of
 * every comparison is a known-empty constant rather than the operator's real
 * identity — otherwise these assertions would pass or fail per machine.
 */
const NO_ENV = Object.freeze({ PATH: process.env.PATH ?? '' });

/** @type {string[]} */
let tmpDirs = [];

/** Create a fresh tmp git repo and return its path. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'so-git-config-drift-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

/** Set a local config key in `dir`. */
function setLocal(dir, key, value) {
  execFileSync('git', ['-C', dir, 'config', key, value]);
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('checkGitConfigDrift — detection', () => {
  it.skipIf(!GIT_AVAILABLE)('returns null for a freshly initialised repo (the negative twin)', () => {
    expect(checkGitConfigDrift({ repoRoot: makeRepo(), env: NO_ENV })).toBeNull();
  });

  it.skipIf(!GIT_AVAILABLE)('flags a fixture user.email that overrides the identity', () => {
    const dir = makeRepo();
    setLocal(dir, 'user.email', 'test@example.com');

    const result = checkGitConfigDrift({ repoRoot: dir, env: NO_ENV });

    expect(result?.severity).toBe('warn');
    expect(result?.degraded).toBeUndefined();
    expect(result?.findings).toEqual([
      {
        kind: 'local-identity',
        key: 'user.email',
        value: 'test@example.com',
        detail: expect.stringContaining('überschreibt die Identität'),
      },
    ]);
  });

  it.skipIf(!GIT_AVAILABLE)('reproduces the incident triple: identity + fixture remote + gpgsign', () => {
    const dir = makeRepo();
    setLocal(dir, 'user.email', 'test@example.com');
    setLocal(dir, 'user.name', 'Test');
    setLocal(dir, 'commit.gpgsign', 'false');
    execFileSync('git', [
      '-C',
      dir,
      'remote',
      'add',
      'gitlab',
      'git@gitlab.example.com:example-group/example-project.git',
    ]);

    const result = checkGitConfigDrift({ repoRoot: dir, env: NO_ENV });

    expect(result?.findings.map((f) => `${f.kind}:${f.key}`)).toEqual([
      'local-identity:user.email',
      'local-identity:user.name',
      'local-gpgsign:commit.gpgsign',
      'fixture-remote:remote.gitlab.url',
    ]);
  });

  it.skipIf(!GIT_AVAILABLE)('does NOT flag a local user.email that merely restates the global one', () => {
    // Discriminates "an override exists" from "a user.* key exists". Without
    // this, the identity rule would fire in every repo whose local config
    // happens to duplicate the global identity.
    const dir = makeRepo();
    const home = mkdtempSync(join(tmpdir(), 'so-git-config-drift-home-'));
    tmpDirs.push(home);
    writeFileSync(join(home, '.gitconfig'), '[user]\n\temail = real@operator.invalid\n', 'utf8');
    setLocal(dir, 'user.email', 'real@operator.invalid');

    const env = { PATH: process.env.PATH ?? '', HOME: home };
    expect(checkGitConfigDrift({ repoRoot: dir, env })).toBeNull();
  });

  it.skipIf(!GIT_AVAILABLE)('does NOT flag a remote on a real host', () => {
    const dir = makeRepo();
    // A self-hosted-looking host that is NOT reserved. Deliberately not this
    // repo's real GitLab host: check-owner-leakage.mjs (CP2/CP7) blocks the
    // commit on it, and it caught exactly that here before this file landed.
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@git.acme-corp.io:g/p.git']);

    expect(checkGitConfigDrift({ repoRoot: dir, env: NO_ENV })).toBeNull();
  });

  it.skipIf(!GIT_AVAILABLE)('flags a core.hooksPath that does not point at .husky/_', () => {
    const dir = makeRepo();
    setLocal(dir, 'core.hooksPath', '/tmp/elsewhere');

    const result = checkGitConfigDrift({ repoRoot: dir, env: NO_ENV });
    expect(result?.findings.map((f) => f.kind)).toEqual(['hooks-path']);
  });

  it.skipIf(!GIT_AVAILABLE)('accepts an ABSOLUTE core.hooksPath ending in .husky/_', () => {
    // The live repo stores the absolute form; a literal equality check against
    // '.husky/_' would warn on every session in the repo that owns this file.
    const dir = makeRepo();
    setLocal(dir, 'core.hooksPath', join(dir, '.husky', '_'));

    expect(checkGitConfigDrift({ repoRoot: dir, env: NO_ENV })).toBeNull();
  });

  it.skipIf(!GIT_AVAILABLE)('accepts a tracked .githooks/ declared via core.hooksPath (#1158)', () => {
    // The bug this catches: a repo that deliberately tracks its hooks under a
    // non-Husky directory (a tracked .githooks/pre-commit, the agents/vault
    // shape from the linked incident) reported a PERMANENT false positive,
    // because only the literal '.husky/_' tail was ever accepted. Reverting
    // the hooksPathIsTracked fix turns this test red — see EVIDENCE.
    const dir = makeRepo();
    mkdirSync(join(dir, '.githooks'), { recursive: true });
    writeFileSync(join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
    execFileSync('git', ['-C', dir, 'add', '.githooks/pre-commit']);
    setLocal(dir, 'core.hooksPath', '.githooks');

    expect(checkGitConfigDrift({ repoRoot: dir, env: NO_ENV })).toBeNull();
  });

  it.skipIf(!GIT_AVAILABLE)('still flags core.hooksPath=.githooks when the directory is untracked', () => {
    // Discriminates "declared" from "merely named .githooks" — an untracked
    // path is exactly the incident shape (a fixture rewrote hooksPath) this
    // probe exists to catch, and the tracked-path acceptance above must not
    // widen into accepting it.
    const dir = makeRepo();
    mkdirSync(join(dir, '.githooks'), { recursive: true });
    writeFileSync(join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
    setLocal(dir, 'core.hooksPath', '.githooks');

    const result = checkGitConfigDrift({ repoRoot: dir, env: NO_ENV });
    expect(result?.findings.map((f) => f.kind)).toEqual(['hooks-path']);
  });

  it.skipIf(!GIT_AVAILABLE)(
    'still flags core.hooksPath=scripts when the tracked files there are ordinary source, not a hook (#1158 review N1 exploit)',
    () => {
      // The bug this catches: `hooksPathIsTracked` used to accept ANY tracked
      // file anywhere under the hooksPath, so `core.hooksPath=scripts` +
      // ordinary tracked source (nothing hook-shaped at all) — or the same
      // directory carrying an UNTRACKED executable literally named
      // `pre-commit` planted alongside it — was silently accepted as
      // "declared". `git ls-files -- scripts` returning 456 tracked files in
      // the real repo, none of them a hook, is exactly this shape at scale.
      // Reverting the hook-name requirement turns this test red — see the
      // agent's EVIDENCE section.
      const dir = makeRepo();
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'ordinary.mjs'), 'export const x = 1;\n', 'utf8');
      execFileSync('git', ['-C', dir, 'add', 'scripts/ordinary.mjs']);
      // Deliberately UNTRACKED — the exploit plants a hook-named file without
      // ever staging it, betting the old check counted tracked SIBLINGS.
      writeFileSync(join(dir, 'scripts', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
      setLocal(dir, 'core.hooksPath', 'scripts');

      const result = checkGitConfigDrift({ repoRoot: dir, env: NO_ENV });
      expect(result?.findings.map((f) => f.kind)).toEqual(['hooks-path']);
    },
  );

  it.skipIf(!GIT_AVAILABLE)(
    'accepts a tracked pre-commit nested only ONE level under the hooksPath, not two',
    () => {
      // Pins the "DIRECTLY under" half of the contract: a tracked hook-named
      // file in a nested subdirectory of the hooksPath is not a hook git will
      // ever invoke from that hooksPath, so it must not count as a
      // declaration either.
      const dir = makeRepo();
      mkdirSync(join(dir, '.githooks', 'nested'), { recursive: true });
      writeFileSync(join(dir, '.githooks', 'nested', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8');
      execFileSync('git', ['-C', dir, 'add', '.githooks/nested/pre-commit']);
      setLocal(dir, 'core.hooksPath', '.githooks');

      const result = checkGitConfigDrift({ repoRoot: dir, env: NO_ENV });
      expect(result?.findings.map((f) => f.kind)).toEqual(['hooks-path']);
    },
  );

  it.skipIf(!GIT_AVAILABLE)(
    'flags an absolute core.hooksPath outside repoRoot without spawning git ls-files (#1158 review N1 qa gap)',
    () => {
      // The bug this catches: an absolute hooksPath pointing outside the repo
      // (e.g. a fixture-rewritten `/etc/passwd`) must be rejected purely from
      // the path comparison — spawning `git ls-files` on it would be both
      // wasted work and, on some pathspecs, a way to leak unrelated
      // filesystem structure into the query.
      const dir = makeRepo();
      setLocal(dir, 'core.hooksPath', '/etc/passwd');

      const lsFilesCalls = [];
      const spy = (cmd, args, opts) => {
        if (Array.isArray(args) && args.includes('ls-files')) lsFilesCalls.push(args);
        return spawnSync(cmd, args, opts);
      };

      const result = checkGitConfigDrift({ repoRoot: dir, env: NO_ENV }, { spawn: spy });
      expect(result?.findings.map((f) => f.kind)).toEqual(['hooks-path']);
      expect(lsFilesCalls).toEqual([]);
    },
  );

  it('flags core.hooksPath when the ls-files exec seam fails — never silently accepted (#1158 review N1)', () => {
    // The bug this catches: hooksPathIsTracked must fall back to "not
    // declared" (never "declared") on any spawn failure — a corrupt .git or a
    // failing exec seam must widen acceptance in exactly ZERO directions.
    // Fully injected: no real git process runs, so this test needs no
    // GIT_AVAILABLE gate.
    const spawn = (_cmd, args) => {
      if (Array.isArray(args) && args.includes('ls-files')) {
        return { error: Object.assign(new Error('spawn git EIO'), { code: 'EIO' }) };
      }
      if (Array.isArray(args) && args.includes('--global')) {
        return { status: 0, stdout: '' };
      }
      if (Array.isArray(args) && args.includes('--local')) {
        return { status: 0, stdout: 'core.hooksPath\nscripts\0' };
      }
      return { status: 0, stdout: '' };
    };

    const result = checkGitConfigDrift({ repoRoot: '/anywhere', env: NO_ENV }, { spawn });
    expect(result?.findings.map((f) => f.kind)).toEqual(['hooks-path']);
  });
});

describe('checkGitConfigDrift — ambient git environment', () => {
  it.skipIf(!GIT_AVAILABLE)('reports a set GIT_DIR and still reads the repo it was asked about', () => {
    // The incident's proximate cause. The second assertion is the load-bearing
    // one: the probe must not be redirected by the very variable it reports,
    // or it would read a foreign repo's config and call this one clean.
    const dir = makeRepo();
    const foreign = makeRepo();
    setLocal(foreign, 'user.email', 'test@example.com');

    const result = checkGitConfigDrift({
      repoRoot: dir,
      env: { PATH: process.env.PATH ?? '', GIT_DIR: join(foreign, '.git') },
    });

    expect(result?.findings.map((f) => f.kind)).toEqual(['ambient-git-env']);
    expect(result?.findings[0].value).toBe(join(foreign, '.git'));
  });
});

describe('checkGitConfigDrift — a failed query is never "clean"', () => {
  it.skipIf(!GIT_AVAILABLE)('returns degraded not-a-git-repo for a directory outside any work tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-git-config-drift-bare-'));
    tmpDirs.push(dir);

    const result = checkGitConfigDrift({ repoRoot: dir, env: NO_ENV });

    expect(result).not.toBeNull();
    expect(result?.degraded).toBe('not-a-git-repo');
    expect(result?.findings).toEqual([]);
  });

  it.skipIf(!GIT_AVAILABLE)('distinguishes a CORRUPT .git/config from a missing repo', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, '.git', 'config'), '[core\nbroken', 'utf8');

    expect(checkGitConfigDrift({ repoRoot: dir, env: NO_ENV })?.degraded).toBe('config-unreadable');
  });

  it('returns degraded git-unavailable when git is not on PATH', () => {
    const spawn = () => ({ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) });

    const result = checkGitConfigDrift({ repoRoot: '/anywhere', env: NO_ENV }, { spawn });

    expect(result?.degraded).toBe('git-unavailable');
    expect(result?.message).toContain('nicht "sauber"');
  });

  it('returns degraded timeout when the child is killed by the timeout signal', () => {
    const spawn = () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' });

    expect(checkGitConfigDrift({ repoRoot: '/anywhere', env: NO_ENV }, { spawn })?.degraded).toBe('timeout');
  });

  it('every degraded reason it can emit is a declared member of DEGRADED_REASONS', () => {
    for (const reason of ['git-unavailable', 'timeout', 'git-error']) {
      expect(DEGRADED_REASONS).toContain(reason);
    }
    expect(FINDING_KINDS).toContain('ambient-git-env');
  });

  it('returns null on bad input rather than throwing', () => {
    expect(checkGitConfigDrift()).toBeNull();
    expect(checkGitConfigDrift({ repoRoot: 42 })).toBeNull();
  });
});

describe('remoteHost / isFixtureHost', () => {
  it('extracts the host from both the scheme and the scp-like remote form', () => {
    expect(remoteHost('git@gitlab.example.com:group/project.git')).toBe('gitlab.example.com');
    expect(remoteHost('https://github.com/Kanevry/session-orchestrator.git')).toBe('github.com');
    expect(remoteHost('ssh://git@host.example.test:2222/g/p.git')).toBe('host.example.test');
    expect(remoteHost('https://user:tok@gitlab.example.com/g/p.git')).toBe('gitlab.example.com');
  });

  it('returns null for a local-path remote, which can never be a fixture-host finding', () => {
    expect(remoteHost('/srv/mirrors/project.git')).toBeNull();
    expect(remoteHost('../sibling.git')).toBeNull();
    expect(remoteHost('')).toBeNull();
  });

  it('classifies the reserved fixture hosts this repo actually uses, and spares real ones', () => {
    for (const host of ['gitlab.example.com', 'example.com', 'example.test', 'gitlab.example', 'localhost', '127.0.0.1']) {
      expect(isFixtureHost(host)).toBe(true);
    }
    // Self-hosted forms must be spared too — but named neutrally, because the
    // owner-leakage scanner treats this repo's own private host as a leak.
    for (const host of ['github.com', 'git.acme-corp.io', 'gitlab.com', null]) {
      expect(isFixtureHost(host)).toBe(false);
    }
  });
});

describe('parseNulConfigList', () => {
  it('parses a valueless boolean key and a multi-line value', () => {
    // The `-z` form exists precisely so a multi-line value cannot be mis-split;
    // the plain `--list` form would report `remote.x.url=first` and drop the rest.
    expect(parseNulConfigList('core.bare\0remote.x.url\nfirst\nsecond\0')).toEqual([
      { key: 'core.bare', value: '' },
      { key: 'remote.x.url', value: 'first\nsecond' },
    ]);
  });

  it('returns an empty list for empty or absent output', () => {
    expect(parseNulConfigList('')).toEqual([]);
    expect(parseNulConfigList(undefined)).toEqual([]);
  });
});

describe('checkGitConfigDrift — against the repository that owns this file', () => {
  it.skipIf(!GIT_AVAILABLE)('reports no drift in the live repo', () => {
    // A live-tree assertion, deliberately: this probe's whole purpose is to be
    // true of THIS checkout. A failure here is a real finding, not a test bug —
    // read the message and inspect `git config --local --list`.
    const result = checkGitConfigDrift({ repoRoot: process.cwd() });
    expect(result).toBeNull();
  });
});

describe('checkGitConfigDrift — repository resolution', () => {
  it.skipIf(!GIT_AVAILABLE)('resolves the enclosing repo from a nested subdirectory', () => {
    // Pins that the config is read THROUGH git rather than by opening
    // `<repoRoot>/.git/config` directly — the shortcut reads nothing here, and
    // reading nothing would be reported as a clean repo.
    const parent = makeRepo();
    const nested = join(parent, 'nested');
    mkdirSync(nested, { recursive: true });
    setLocal(parent, 'user.email', 'test@example.com');

    const result = checkGitConfigDrift({ repoRoot: nested, env: NO_ENV });
    expect(result?.findings.map((f) => f.kind)).toEqual(['local-identity']);
  });
});
