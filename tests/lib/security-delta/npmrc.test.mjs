import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { filterPublicPackages, readPrivateScopes } from '../../../scripts/lib/security-delta/npmrc.mjs';
import { runLockfileCheck } from '../../../scripts/lib/security-delta/osv.mjs';

const FIX = path.join(process.cwd(), 'tests/fixtures/security-delta/lockfiles');
let dir = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('private package names never leave the host', () => {
  it('a private .npmrc scope, an unscoped private scope and a foreign-registry package never reach the querybatch body', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'secdelta-npmrc-'));
    writeFileSync(
      path.join(dir, '.npmrc'),
      [
        '@acme-internal:registry=https://npm.acme.example/',
        '@example-private:registry = "https://npm.example-private.test/"',
        '@public-mirror:registry=https://registry.npmjs.org/',
        '',
      ].join('\n'),
    );
    const files = {
      base: readFileSync(path.join(FIX, 'package-lock.base.json'), 'utf8'),
      head: readFileSync(path.join(FIX, 'package-lock.head.json'), 'utf8'),
    };
    const runGit = async (args) => (args[0] === 'diff' ? 'package-lock.json\0' : files[args[1].split(':')[0]]);
    const bodies = [];
    const request = async (url, opts) => {
      bodies.push(opts.body);
      return { ok: true, status: 200, json: async () => ({ results: [{}, {}] }), text: async () => '' };
    };

    const result = await runLockfileCheck({ repoRoot: dir, base: 'base', head: 'head', request, runGit });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/acme-internal|example-private|left-pad/);
    expect(JSON.parse(bodies[0]).queries.map((q) => q.package.name)).toEqual(['lodash', 'b']);
    expect(result).toMatchObject({ status: 'ok', checked: 2, unchecked: 0 });
    expect([...readPrivateScopes({ repoRoot: dir })].sort()).toEqual(['@acme-internal', '@example-private']);
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
    dir = mkdtempSync(path.join(tmpdir(), 'secdelta-npmrc-'));
    // The private default registry sits next to the lockfile, not at the repo root.
    mkdirSync(path.join(dir, 'app'));
    writeFileSync(path.join(dir, 'app', '.npmrc'), 'registry=https://npm.internal/\n');
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

    const result = await runLockfileCheck({ repoRoot: dir, base: 'base', head: 'head', request, runGit });

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
