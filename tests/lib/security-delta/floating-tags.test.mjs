import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { gitEnv, parseImageRefs, runFloatingTagCheck } from '../../../scripts/lib/security-delta/floating-tags.mjs';
import { dropBlob, TRANSLATED_GIT_SUPPORTED, withTranslatedGit } from '../../_helpers/git-faults.mjs';

const fixture = (name) => readFileSync(join(process.cwd(), 'tests/fixtures/security-delta/runtime', name), 'utf8');
const pick = (refs) => refs.map(({ image, tag, digest, measurable }) => ({ image, tag, digest: digest ? 'sha' : null, measurable }));

let repo;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function makeRepo(baseFiles, headFiles) {
  repo = mkdtempSync(join(tmpdir(), 'secdelta-ft-'));
  git('init', '-q');
  git('config', 'user.email', 'dev@example.org');
  git('config', 'user.name', 'Example');
  const commit = (files, msg) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), text);
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const base = commit({ 'README.txt': 'x\n', ...baseFiles }, 'base');
  const head = commit(headFiles, 'head');
  return { repoRoot: repo, base, head };
}

describe('gitEnv', () => {
  // Bug caught (SEC-008, SO#1785): gitEnv returning a plain full env again, so one
  // JSON.stringify/console.log of it prints every host secret. Synthetic env only:
  // even a failing assertion here cannot print a real value.
  it('serializes to key names only while the values and the C locale still reach git', () => {
    const P = 'placeholder-not-a-secret-1785';
    const env = gitEnv({ SO1785_TEST_PLACEHOLDER: P });
    for (const text of [JSON.stringify(env), inspect(env, { depth: Infinity })]) {
      expect(text.includes(P)).toBe(false);
      expect(text.includes('SO1785_TEST_PLACEHOLDER')).toBe(true);
    }
    expect(env.SO1785_TEST_PLACEHOLDER === P).toBe(true);
    expect([env.LC_ALL, env.LANG, env.LANGUAGE]).toEqual(['C', 'C', '']);
  });
});

describe('parseImageRefs', () => {
  it('skips scratch and earlier stage names, strips --platform, keeps digests and flags interpolation', () => {
    // Bugs caught: `FROM build` reported as an image; `--platform=…` read as the ref; registry port read as a tag.
    expect(pick(parseImageRefs(fixture('Dockerfile.sample'), 'Dockerfile'))).toEqual([
      { image: 'node', tag: '22.23.3-alpine', digest: null, measurable: true },
      { image: 'nginx', tag: null, digest: null, measurable: true },
      { image: 'redis', tag: '7.4', digest: 'sha', measurable: true },
      { image: '${BASE_IMAGE}', tag: null, digest: null, measurable: false },
    ]);
    expect(pick(parseImageRefs(fixture('compose.sample.yml'), 'docker-compose.yml'))).toEqual([
      { image: 'node', tag: 'lts-alpine', digest: null, measurable: true },
      { image: 'postgres', tag: '17', digest: null, measurable: true },
      { image: 'registry.example.org:5000/team/redis', tag: null, digest: null, measurable: true },
    ]);
    expect(parseImageRefs(fixture('ci.sample.yml'), '.gitlab-ci.yml').map((r) => [r.ref, r.line])).toEqual([
      ['node:latest', 3],
      ['node:22', 6],
    ]);
  });
});

describe('runFloatingTagCheck', () => {
  it('reports a node:latest added in head as introduced and ignores a floating ref in an untouched file', async () => {
    const range = makeRepo(
      { 'old/Dockerfile': 'FROM nginx:latest\n', '.gitlab-ci.yml': 'test:\n  image: node:22\n' },
      { '.gitlab-ci.yml': 'test:\n  image: node:22\nlint:\n  image: node:latest\n' },
    );
    const r = await runFloatingTagCheck(range);
    expect(r.status).toBe('ok');
    expect(r.checked).toBe(2);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ class: 'floating-tag', severity: 'medium', ecosystem: 'image', package: 'node', version: 'latest', file: '.gitlab-ci.yml', introduced: true });
  });

  it('skips a Dockerfile under a fixture directory but reports the same file at the repo root', async () => {
    // Bug caught: a test fixture read as a real image declaration.
    const fixtureOnly = await runFloatingTagCheck(makeRepo({}, { 'tests/fixtures/img/Dockerfile': 'FROM node:latest\n' }));
    expect(fixtureOnly).toMatchObject({ status: 'skipped', reason: 'no-relevant-change', findings: [] });
    rmSync(repo, { recursive: true, force: true });
    const root = await runFloatingTagCheck(makeRepo({}, { Dockerfile: 'FROM node:latest\n' }));
    expect(root.findings).toHaveLength(1);
    expect(root.findings[0]).toMatchObject({ package: 'node', version: 'latest', file: 'Dockerfile', introduced: true });
  });

  it('skips with no-relevant-change when no image-bearing file changed', async () => {
    const r = await runFloatingTagCheck(makeRepo({ Dockerfile: 'FROM node:latest\n' }, { 'src.txt': 'y\n' }));
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-relevant-change' });
  });

  it('finds a floating tag in a Dockerfile under a non-ASCII directory (#1775)', async () => {
    // Bug caught: `git diff --name-only` without -z quotes the path ("dock\303\251r/Dockerfile"),
    // isDockerfile misses it and the check reads skipped/no-relevant-change.
    const range = makeRepo({}, { 'dockér/Dockerfile': 'FROM node:latest\n' });
    git('config', 'core.quotePath', 'true');
    const r = await runFloatingTagCheck(range);
    expect(r.status).toBe('ok');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ file: 'dockér/Dockerfile', package: 'node', version: 'latest' });
  });

  it('counts a file git cannot read as unchecked and keeps the findings of the readable one (#1774)', async () => {
    // Bug caught: showFile turned every git error into "absent", so an unreadable compose file read as clean.
    const range = makeRepo({}, { Dockerfile: 'FROM node:latest\n', 'compose.yml': 'services:\n  web:\n    image: nginx:latest\n' });
    dropBlob(repo, range.head, 'compose.yml');
    const r = await runFloatingTagCheck(range);
    expect(r).toMatchObject({ status: 'degraded', reason: 'unreadable', checked: 1, unchecked: 1 });
    expect(r.findings.map((f) => f.file)).toEqual(['Dockerfile']);
  });

  it('reports a finding as introduced when the base file cannot be read (#1774)', async () => {
    // Bug caught: an unreadable base read as "ref already there", so a new floating tag counted as pre-existing.
    const range = makeRepo({ Dockerfile: 'FROM node:latest\n' }, { Dockerfile: 'FROM node:latest\nRUN true\n' });
    dropBlob(repo, range.base, 'Dockerfile');
    const r = await runFloatingTagCheck(range);
    expect(r).toMatchObject({ status: 'degraded', reason: 'unreadable', checked: 1, unchecked: 1 });
    expect(r.findings[0]).toMatchObject({ file: 'Dockerfile', introduced: true });
  });

  it.skipIf(!TRANSLATED_GIT_SUPPORTED)('reads a file new in head as absent at base under a German git (#1774, POSIX only)', async () => {
    // Bug caught: git called without LC_ALL=C answers in German, PATH_ABSENT misses it and the check degrades.
    const range = makeRepo({}, { Dockerfile: 'FROM node:latest\n' });
    const r = await withTranslatedGit(() => runFloatingTagCheck(range));
    expect(r.status).toBe('ok');
    expect(r.findings[0]).toMatchObject({ file: 'Dockerfile', introduced: true });
  });
});
