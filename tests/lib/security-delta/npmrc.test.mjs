import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { filterPublicPackages } from '../../../scripts/lib/security-delta/npmrc.mjs';
import { runLockfileCheck } from '../../../scripts/lib/security-delta/osv.mjs';

const FIX = path.join(process.cwd(), 'tests/fixtures/security-delta/lockfiles');
let dir = null;
let fakeHome = null;

// Host npm config is part of the policy: isolate it (an empty fake HOME, no npm_config_* vars).
beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), 'secdelta-home-'));
  vi.stubEnv('HOME', fakeHome);
  for (const key of Object.keys(process.env)) if (/^npm_config_/i.test(key)) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fakeHome, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('private package names never leave the host', () => {
  it('a private .npmrc scope, an unscoped private scope and a foreign-registry package never reach the querybatch body', async () => {
    const npmrc = [
      '@acme-internal:registry=https://npm.acme.example/',
      '@example-private:registry = "https://npm.example-private.test/"',
      '@public-mirror:registry=https://registry.npmjs.org/',
      '',
    ].join('\n');
    const files = {
      base: readFileSync(path.join(FIX, 'package-lock.base.json'), 'utf8'),
      head: readFileSync(path.join(FIX, 'package-lock.head.json'), 'utf8'),
    };
    // The root .npmrc is committed at head: ls-tree lists it, cat-file returns it.
    const runGit = async (args) => {
      if (args[0] === 'diff') return 'package-lock.json\0';
      if (args[0] === 'ls-tree') return args[2] === 'head:' ? '100644 blob 0123abcd\t.npmrc\0' : '';
      if (args[0] === 'cat-file') return npmrc;
      return files[args[1].split(':')[0]];
    };
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      return { ok: true, status: 200, json: async () => ({ results: [{}, {}] }), text: async () => '' };
    };

    const result = await runLockfileCheck({ repoRoot: tmpdir(), base: 'base', head: 'head', request, runGit });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/acme-internal|example-private|left-pad/);
    expect(JSON.parse(bodies[0]).queries.map((q) => q.package.name)).toEqual(['lodash', 'b']);
    expect(result).toMatchObject({ status: 'ok', checked: 2, unchecked: 0 });
  });

  it('the .npmrc committed at head governs even when the lockfile directory is gone from the working tree (#1788)', async () => {
    // Bug caught: the policy was read from <repoRoot>/<dir>/.npmrc on disk; with app/ absent
    // there it read as "no .npmrc" and the private names went to the public OSV API.
    dir = mkdtempSync(path.join(tmpdir(), 'secdelta-npmrc-'));
    const git = (...args) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(path.join(dir, 'README.md'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    mkdirSync(path.join(dir, 'app'));
    writeFileSync(path.join(dir, 'app', '.npmrc'), '@acme-int:registry=https://npm.internal.example/\nregistry=https://npm.internal.example/\n');
    const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/@acme-int/secret': { version: '1.0.0' }, 'node_modules/plainpriv': { version: '2.0.0' } } };
    writeFileSync(path.join(dir, 'app', 'package-lock.json'), JSON.stringify(lock));
    git('add', '-A');
    git('commit', '-q', '-m', 'head');
    const head = git('rev-parse', 'HEAD');
    rmSync(path.join(dir, 'app'), { recursive: true, force: true });
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' };
    };

    const result = await runLockfileCheck({ repoRoot: dir, base, head, request });

    expect(bodies).toEqual([]);
    expect(result).toMatchObject({ status: 'ok', checked: 0, unchecked: 0 });
  });

  it('a registry set only in the environment or the user ~/.npmrc counts as private (#1788)', async () => {
    // Bug caught: host-level npm config was never read, so a registry-less package of a
    // privately configured host read as public.
    writeFileSync(path.join(process.env.HOME, '.npmrc'), '@acme-user:registry=https://npm.internal.example/\n');
    vi.stubEnv('NPM_CONFIG_REGISTRY', 'https://npm.internal.example/');
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@acme-user/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/@acme-user/a/-/a-1.0.0.tgz' }, 'node_modules/envpriv': { version: '1.0.0' } } });
    const runGit = async (args) => {
      if (args[0] === 'diff') return 'package-lock.json\0';
      if (args[0] === 'ls-tree') return '';
      if (args[1].startsWith('base:')) throw new Error("fatal: path 'package-lock.json' does not exist in 'base'");
      return lock;
    };
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' };
    };
    const result = await runLockfileCheck({ repoRoot: tmpdir(), base: 'base', head: 'head', request, runGit });
    expect(bodies).toEqual([]);
    expect(result).toMatchObject({ status: 'ok', checked: 0, unchecked: 0 });
  });

  it('a quoted "@scope:registry" key in a committed .npmrc keeps the scope private (#1788 review)', async () => {
    // Bug caught: npm's ini parser unquotes keys, the policy parser did not — `@secret/internal`
    // (no resolved URL, so only the scope rule can stop it) reached the OSV querybatch body.
    const npmrc = '"@secret:registry"=https://private.invalid/\n';
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@secret/internal': { version: '1.0.0' } } });
    const runGit = async (args) => {
      if (args[0] === 'diff') return 'package-lock.json\0';
      if (args[0] === 'ls-tree') return args[2] === 'head:' ? '100644 blob 0123abcd\t.npmrc\0' : '';
      if (args[0] === 'cat-file') return npmrc;
      if (args[1].startsWith('base:')) throw new Error("fatal: path 'package-lock.json' does not exist in 'base'");
      return lock;
    };
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      return { ok: true, status: 200, json: async () => ({ results: [{}] }), text: async () => '' };
    };
    const result = await runLockfileCheck({ repoRoot: tmpdir(), base: 'base', head: 'head', request, runGit });
    expect(bodies).toEqual([]);
    expect(result).toMatchObject({ status: 'ok', checked: 0, unchecked: 0 });
  });

  it.skipIf(process.platform === 'win32')('a user ~/.npmrc symlinked to a regular file (dotfile manager) is read: its private scope holds, not degraded', async () => {
    // Bug caught: refusing every symlinked user config would degrade every run on dotfile-managed hosts
    // (HR-101), and following it without reading would let `@dot-private/a` reach OSV.
    const target = path.join(fakeHome, 'dotfiles-npmrc');
    writeFileSync(target, '@dot-private:registry=https://npm.internal.example/\n');
    symlinkSync(target, path.join(fakeHome, '.npmrc'));
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@dot-private/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/@dot-private/a/-/a-1.0.0.tgz' } } });
    const runGit = async (args) => {
      if (args[0] === 'diff') return 'package-lock.json\0';
      if (args[0] === 'ls-tree') return '';
      if (args[1].startsWith('base:')) throw new Error("fatal: path 'package-lock.json' does not exist in 'base'");
      return lock;
    };
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      return { ok: true, status: 200, json: async () => ({ results: [{}] }), text: async () => '' };
    };
    const result = await runLockfileCheck({ repoRoot: tmpdir(), base: 'base', head: 'head', request, runGit });
    expect(bodies).toEqual([]);
    expect(result).toMatchObject({ status: 'ok', checked: 0, unchecked: 0 });
  });

  // Bug caught: the user config was read without a type check — a character device (/dev/null)
  // read as an empty, PUBLIC policy, and a FIFO blocked the synchronous read forever.
  // win32 has neither /dev/null as a path nor mkfifo.
  it.skipIf(process.platform === 'win32').each([
    ['a character device', () => '/dev/null'],
    ['a FIFO', () => {
      const fifo = path.join(fakeHome, 'npmrc.fifo');
      execFileSync('mkfifo', [fifo]);
      return fifo;
    }],
  ])('a user config that is %s is degraded npmrc-unreadable, never read as public (#1788 review)', async (_label, make) => {
    vi.stubEnv('npm_config_userconfig', make());
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/plain': { version: '1.0.0' } } });
    const runGit = async (args) => {
      if (args[0] === 'diff') return 'package-lock.json\0';
      if (args[0] === 'ls-tree') return '';
      if (args[1].startsWith('base:')) throw new Error("fatal: path 'package-lock.json' does not exist in 'base'");
      return lock;
    };
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      return { ok: true, status: 200, json: async () => ({ results: [{}] }), text: async () => '' };
    };
    const result = await runLockfileCheck({ repoRoot: tmpdir(), base: 'base', head: 'head', request, runGit });
    expect(bodies).toEqual([]);
    expect(result).toMatchObject({ status: 'degraded', reason: 'npmrc-unreadable', checked: 0, unchecked: 1 });
    expect(JSON.stringify(result)).not.toContain(fakeHome);
  });

  it('fails closed: an unparseable resolved URL, a non-PyPI host and an unknown ecosystem are excluded', () => {
    const out = filterPublicPackages([
      { ecosystem: 'npm', name: 'ok-npm', version: '1.0.0', resolved: null },
      { ecosystem: 'npm', name: 'garbled', version: '1.0.0', resolved: 'not a url' },
      { ecosystem: 'PyPI', name: 'ok-py', version: '1.0.0', resolved: 'https://pypi.org/simple' },
      { ecosystem: 'PyPI', name: 'internal-py', version: '1.0.0', resolved: 'https://pypi.example-private.test/simple' },
      { ecosystem: 'PyPI', name: 'example-private-app', version: '0.1.0', resolved: 'local-source' },
      { ecosystem: 'cargo', name: 'crate', version: '1.0.0', resolved: null },
    ]);
    expect(out.public.map((p) => p.name)).toEqual(['ok-npm', 'ok-py']);
    expect(out.excluded).toBe(4);
  });

  it('a private requirements index, a private bare registry= next to a pnpm lock and pnpm file:/directory/git sources are never queried', async () => {
    // The private default registry sits next to the lockfile (committed at head), not at the repo root.
    const appNpmrc = 'registry=https://npm.internal/\n';
    const head = {
      'requirements.txt': '--index-url https://pypi.internal.acme/simple\nacme-secret-billing==1.2.3\n',
      // v9: integrity only, no tarball → resolved null.
      'app/pnpm-lock.yaml': "lockfileVersion: '9.0'\npackages:\n  acme-internal-sdk@3.1.0:\n    resolution: {integrity: sha512-a}\n",
      'legacy/pnpm-lock.yaml': [
        'lockfileVersion: 5.4',
        'packages:',
        '  file:../acme-local-lib:',
        '    resolution: {directory: ../acme-local-lib, type: directory}',
        '  /acme-dir-pkg/1.0.0:',
        '    resolution: {directory: ../acme-dir-pkg}',
        '  github.com/acme/acme-git-pkg/0123abc:',
        '    resolution: {commit: 0123abc, repo: git@github.com:acme/acme-git-pkg.git, type: git}',
        '  /example-public/1.0.0:',
        '    resolution: {integrity: sha512-b}',
        '',
      ].join('\n'),
    };
    const runGit = async (args) => {
      if (args[0] === 'diff') return `${Object.keys(head).join('\0')}\0`;
      if (args[0] === 'ls-tree') return args[2] === 'head:app' ? '100644 blob 0123abcd\t.npmrc\0' : '';
      if (args[0] === 'cat-file') return appNpmrc;
      const [ref, file] = args[1].split(/:(.*)/s);
      if (ref === 'base') throw new Error(`fatal: path '${file}' exists on disk, but not in 'base'`);
      return head[file];
    };
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      const n = JSON.parse(opts.body).queries.length;
      return { ok: true, status: 200, json: async () => ({ results: Array.from({ length: n }, () => ({})) }), text: async () => '' };
    };

    const result = await runLockfileCheck({ repoRoot: tmpdir(), base: 'base', head: 'head', request, runGit });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/acme|file:/);
    expect(JSON.parse(bodies[0]).queries.map((q) => q.package.name)).toEqual(['example-public']);
    expect(result).toMatchObject({ status: 'ok', checked: 1, unchecked: 0 });
  });

  it('a backslash-continued --index-url still marks the file private: secretpkg never reaches the querybatch body', async () => {
    const text = '--index-url \\\n    https://pypi.internal.example/simple\nsecretpkg==1.0\n';
    const runGit = async (args) => {
      if (args[0] === 'diff') return 'requirements.txt\0';
      if (args[1].startsWith('base:')) throw new Error("fatal: path 'requirements.txt' does not exist in 'base'");
      return text;
    };
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      return { ok: true, status: 200, json: async () => ({ results: [{}] }), text: async () => '' };
    };
    const result = await runLockfileCheck({ repoRoot: tmpdir(), base: 'base', head: 'head', request, runGit });
    expect(bodies).toEqual([]);
    expect(result).toMatchObject({ status: 'ok', checked: 0, unchecked: 0 });
  });

  it('the public npm package `git` (git@0.1.5) is queried; only the scp form git@github.com:org/x is a non-registry key', async () => {
    const text = [
      "lockfileVersion: '9.0'",
      'packages:',
      '  git@0.1.5:',
      '    resolution: {integrity: sha512-a}',
      '  git@github.com:org/x:',
      '    resolution: {integrity: sha512-b}',
      '',
    ].join('\n');
    const runGit = async (args) => {
      if (args[0] === 'diff') return 'pnpm-lock.yaml\0';
      if (args[1].startsWith('base:')) throw new Error("fatal: path 'pnpm-lock.yaml' does not exist in 'base'");
      return text;
    };
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      const n = JSON.parse(opts.body).queries.length;
      return { ok: true, status: 200, json: async () => ({ results: Array.from({ length: n }, () => ({})) }), text: async () => '' };
    };
    const result = await runLockfileCheck({ repoRoot: tmpdir(), base: 'base', head: 'head', request, runGit });
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]).queries).toEqual([{ package: { name: 'git', ecosystem: 'npm' }, version: '0.1.5' }]);
    expect(result).toMatchObject({ status: 'ok', checked: 1, unchecked: 0 });
  });
});
