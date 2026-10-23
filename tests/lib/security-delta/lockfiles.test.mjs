import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readLockfileDelta } from '../../../scripts/lib/security-delta/lockfiles.mjs';
import { TRANSLATED_GIT_SUPPORTED, withTranslatedGit } from '../../_helpers/git-faults.mjs';

const FIX = path.join(process.cwd(), 'tests/fixtures/security-delta/lockfiles');
const fixture = (name) => readFileSync(path.join(FIX, name), 'utf8');

let repo = null;

function git(...args) {
  return execFileSync(
    'git',
    ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8' },
  ).trim();
}

/** Two-commit repo: `before` files in commit 1, `after` files in commit 2. Returns { base, head }. */
function makeRepo(before, after) {
  repo = mkdtempSync(path.join(tmpdir(), 'secdelta-lock-'));
  git('init', '-q');
  const write = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      writeFileSync(path.join(repo, rel), text);
    }
  };
  write(before);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  write(after);
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  return { base, head: git('rev-parse', 'HEAD') };
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = null;
});

describe('readLockfileDelta — only introduced packages leave the delta (real git repo)', () => {
  it('package-lock: skips unchanged and link entries, reads nested node_modules/a/node_modules/b as b', async () => {
    const range = makeRepo(
      { 'package-lock.json': fixture('package-lock.base.json'), 'node_modules/x/package-lock.json': '{}' },
      {
        'package-lock.json': fixture('package-lock.head.json'),
        // A lockfile inside node_modules is a dependency's, never the repo's.
        'node_modules/x/package-lock.json': fixture('package-lock.head.json'),
      },
    );
    const delta = await readLockfileDelta({ repoRoot: repo, ...range });
    expect(delta.files).toEqual(['package-lock.json']);
    expect(delta.packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual([
      '@acme-internal/x@3.0.0',
      '@example-private/y@1.2.0',
      'b@2.0.0',
      'left-pad@1.3.0',
      'lodash@4.17.20',
    ]);
    expect(delta.packages.find((p) => p.name === 'lodash')).toEqual({
      ecosystem: 'npm',
      name: 'lodash',
      version: '4.17.20',
      file: 'package-lock.json',
      resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
    });
  });

  it('pnpm, uv.lock and requirements: parses each key form, marks local uv projects, counts new unpinned lines', async () => {
    const pnpmBase = 'lockfileVersion: \'9.0\'\npackages:\n  kept@1.0.0:\n    resolution: {integrity: sha512-x}\n';
    const pnpmHead = [
      "lockfileVersion: '9.0'",
      'packages:',
      '  kept@1.0.0:',
      '    resolution: {integrity: sha512-x}',
      "  '@scope/new@2.1.0':",
      '    resolution: {integrity: sha512-y}',
      '  /old-style@3.0.0(react@18.0.0):',
      '    resolution: {integrity: sha512-z}',
      '  tarred@https://example.test/tarred.tgz:',
      '    resolution: {tarball: https://example.test/tarred.tgz}',
      '',
    ].join('\n');
    const reqHead = [
      '# comment',
      '-r base.txt',
      'pyyaml==6.0.2 ; python_version >= "3.11"',
      'uvicorn[standard]==0.30.1 \\',
      '    --hash=sha256:00',
      'requests>=2',
      'flask',
      '',
    ].join('\n');
    const range = makeRepo(
      { 'pnpm-lock.yaml': pnpmBase, 'py/uv.lock': fixture('uv-base.lock'), 'requirements-dev.txt': 'flask\n' },
      { 'pnpm-lock.yaml': pnpmHead, 'py/uv.lock': fixture('uv-litellm-1.106.2.lock'), 'requirements-dev.txt': reqHead },
    );
    const delta = await readLockfileDelta({ repoRoot: repo, ...range });
    const byName = Object.fromEntries(delta.packages.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual([
      '@scope/new',
      'example-private-app',
      'litellm',
      'old-style',
      'pyyaml',
      'tarred',
      'uvicorn',
    ]);
    expect(byName['old-style'].version).toBe('3.0.0');
    expect(byName.pyyaml.version).toBe('6.0.2'); // env marker after `;` stripped
    expect(byName.tarred.resolved).toBe('https://example.test/tarred.tgz');
    expect(byName.litellm).toEqual({
      ecosystem: 'PyPI',
      name: 'litellm',
      version: '1.106.2',
      file: 'py/uv.lock',
      resolved: 'https://pypi.org/simple',
    });
    // An editable local project must carry a non-registry marker, never null (null reads as public).
    expect(byName['example-private-app'].resolved).toBe('local-source');
    expect(delta.unpinned).toBe(1); // `requests>=2` is new; `flask` was already unpinned at base
  });

  it('pnpm v5 keys with a peer suffix keep the slash form: /react-dom/17.0.2_react@17.0.2 is react-dom 17.0.2', async () => {
    const head = "lockfileVersion: 5.4\npackages:\n  /react-dom/17.0.2_react@17.0.2:\n    resolution: {integrity: sha512-a}\n  /string_decoder/1.3.0_example-peer@1.0.0:\n    resolution: {integrity: sha512-b}\n";
    const runGit = async (args) => {
      if (args[0] === 'diff') return 'pnpm-lock.yaml\0';
      if (args[1].startsWith('base:')) throw new Error("fatal: path 'pnpm-lock.yaml' does not exist in 'base'");
      return head;
    };
    const delta = await readLockfileDelta({ base: 'base', head: 'head', runGit });
    expect(delta.packages.map((p) => `${p.name}@${p.version}`)).toEqual(['react-dom@17.0.2', 'string_decoder@1.3.0']);
  });

  it.skipIf(!TRANSLATED_GIT_SUPPORTED)('a translated git (German locale) still reads a lockfile new in head as absent at base, not unparsed (POSIX only)', async () => {
    const range = makeRepo({ 'README.md': 'x\n' }, { 'requirements.txt': 'example-new==1.0\n' });
    const delta = await withTranslatedGit(() => {
      // Not vacuous: without LC_ALL=C the git on PATH answers in German.
      expect(() => execFileSync('git', ['-C', repo, 'show', `${range.base}:requirements.txt`], { stdio: 'pipe' })).toThrow(/existiert nicht/);
      return readLockfileDelta({ repoRoot: repo, ...range });
    });
    expect(delta.unparsed).toBe(0);
    expect(delta.packages.map((p) => `${p.name}@${p.version}`)).toEqual(['example-new@1.0']);
  });
});
