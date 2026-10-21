/**
 * tests/scripts/github-export.test.mjs — curated public mirror snapshot (#1631, #1594).
 *
 * Fixture: a throwaway work repo whose `github` remote is a local bare repository
 * seeded with one public commit. Every test names the bug it catches.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

import { buildGithubExport, createGitRunner, EXPORT_REF } from '../../scripts/lib/github-export.mjs';
import { fixtureGit, fixtureGitSpawn, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const ID_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const policy = (...paths) => JSON.stringify({
  version: 1,
  rationale: 'fixture',
  exclude: paths.map((path) => ({ path, reason: 'fixture', issue: '#1631' })),
});
const POLICY = policy('docs/audits/', '.vault.yaml');

const dirs = [];
afterEach(() => { while (dirs.length) removeTree(dirs.pop()); });

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}
function commitAll(dir, msg) {
  fixtureGit(['add', '-A'], dir);
  fixtureGit(['commit', '-q', '-m', msg], dir, { env: ID_ENV });
  return fixtureGit(['rev-parse', 'HEAD'], dir).trim();
}
/** Publish the export ref the way session-end does (updates refs/remotes/github/main too). */
function publish(work) {
  fixtureGit(['push', '-q', 'github', `${EXPORT_REF}:refs/heads/main`], work);
}

/** Bare `github` seeded with one public commit; work repo cloned from it, remote named github. */
function makeFixture() {
  const root = makeTmpDir('so-gh-export-');
  dirs.push(root);
  const bare = join(root, 'github.git');
  const seed = join(root, 'seed');
  fixtureGit(['init', '-q', '--bare', '-b', 'main', bare]);
  fixtureGit(['init', '-q', '-b', 'main', seed]);
  write(seed, { 'README.md': 'public\n' });
  commitAll(seed, 'public root');
  fixtureGit(['push', '-q', bare, 'main'], seed);
  const work = join(root, 'work');
  fixtureGit(['clone', '-q', '-o', 'github', bare, work]);
  const base = createGitRunner(work);
  /** @type {import('../../scripts/lib/github-export.mjs').GitRunner} */
  const git = (args, o = {}) => base(args, { ...o, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...ID_ENV, ...(o.env ?? {}) } });
  return { root, bare, work, git };
}

/** Objects reachable from the export ref but not from github main, as `<sha> <path>` lines. */
function newObjects(work) {
  return fixtureGit(['rev-list', '--objects', `refs/remotes/github/main..${EXPORT_REF}`], work);
}

const okCheck = () => ({ ok: true });

describe('buildGithubExport', () => {
  it('a blob that only exists under an excluded path in the private history is unreachable from the public ref', () => {
    // BUG CAUGHT: parenting the snapshot on the SOURCE commit (or pushing HEAD)
    // publishes the private history — the excluded blob stays reachable even
    // though the snapshot tree omits it.
    const { bare, work, git } = makeFixture();
    write(work, { '.orchestrator/policy/public-export.json': POLICY, 'docs/audits/private.md': 'employer data\n', 'src/a.mjs': 'a\n' });
    commitAll(work, 'private audit');
    const blob = fixtureGit(['rev-parse', 'HEAD:docs/audits/private.md'], work).trim();
    write(work, { 'docs/audits/private.md': 'employer data v2\n' });
    commitAll(work, 'second private commit');

    const res = buildGithubExport({ git, snapshotCheck: okCheck });
    expect(res.status).toBe('created');

    publish(work);
    expect(fixtureGitSpawn(['cat-file', '-e', blob], bare).status).not.toBe(0);
    expect(fixtureGit(['ls-tree', '-r', '--name-only', 'main'], bare).trim().split('\n').sort()).toEqual([
      '.orchestrator/policy/public-export.json', 'README.md', 'src/a.mjs',
    ]);
    expect(fixtureGit(['log', '-1', '--format=%(trailers:key=Source-Commit,valueonly)', 'main'], bare).trim())
      .toBe(fixtureGit(['rev-parse', 'HEAD'], work).trim());
  });

  it('a source change that only touches excluded paths has nothing to publish', () => {
    // BUG CAUGHT: every /close stacking an empty duplicate snapshot on the mirror.
    const { work, git } = makeFixture();
    write(work, { '.orchestrator/policy/public-export.json': POLICY, 'src/a.mjs': 'a\n' });
    commitAll(work, 'one');
    const first = buildGithubExport({ git, snapshotCheck: okCheck });
    expect(first.status).toBe('created');
    publish(work);

    write(work, { 'docs/audits/x.md': 'private\n' });
    commitAll(work, 'private only');
    const second = buildGithubExport({ git, snapshotCheck: okCheck });
    expect({ status: second.status, sha: second.sha }).toEqual({ status: 'unchanged', sha: first.sha });
    expect(fixtureGit(['rev-parse', EXPORT_REF], work).trim()).toBe(first.sha);
  });

  it('a policy that grows between two unpublished runs leaves exactly one commit and no newly excluded blob above github main', () => {
    // BUG CAUGHT: chaining on the previous (never published) snapshot — it was built
    // under the OLD policy, so it still carries the path the NEW policy excludes,
    // and the push would publish it as an intermediate commit nobody scanned again.
    const { work, git } = makeFixture();
    write(work, { '.orchestrator/policy/public-export.json': policy('docs/audits/'), 'marketing/plan.md': 'campaign\n', 'src/a.mjs': 'a\n' });
    commitAll(work, 'one');
    const blob = fixtureGit(['rev-parse', 'HEAD:marketing/plan.md'], work).trim();
    expect(buildGithubExport({ git, snapshotCheck: okCheck }).status).toBe('created');

    write(work, { '.orchestrator/policy/public-export.json': policy('docs/audits/', 'marketing/') });
    commitAll(work, 'policy grows');
    expect(buildGithubExport({ git, snapshotCheck: okCheck }).status).toBe('created');

    expect(fixtureGit(['rev-list', '--count', `refs/remotes/github/main..${EXPORT_REF}`], work).trim()).toBe('1');
    expect(newObjects(work)).not.toContain(blob);
  });

  it('an existing (forged or stale) export ref is never in the pushed range', () => {
    // BUG CAUGHT: reading refs/heads/github-export as the parent — pointing it at a
    // private commit put that commit (and its history) under the public ref.
    const { work, git } = makeFixture();
    write(work, { '.orchestrator/policy/public-export.json': POLICY, 'src/a.mjs': 'a\n' });
    const priv = commitAll(work, 'private commit');
    write(work, { 'src/b.mjs': 'b\n' });
    commitAll(work, 'two');
    fixtureGit(['update-ref', EXPORT_REF, priv], work);

    expect(buildGithubExport({ git, snapshotCheck: okCheck }).status).toBe('created');
    const range = fixtureGit(['rev-list', `refs/remotes/github/main..${EXPORT_REF}`], work).trim().split('\n');
    expect(range).toHaveLength(1);
    expect(range).not.toContain(priv);
  });

  it('refuses when a replace ref exists', () => {
    // BUG CAUGHT: `git replace` makes every check read a clean object while
    // `git push` sends the real (private) one.
    const { work, git } = makeFixture();
    write(work, { '.orchestrator/policy/public-export.json': POLICY, 'src/a.mjs': 'a\n' });
    const one = commitAll(work, 'one');
    write(work, { 'src/b.mjs': 'b\n' });
    const two = commitAll(work, 'two');
    fixtureGit(['replace', two, one], work);

    const res = buildGithubExport({ git, snapshotCheck: okCheck });
    expect(res.status).toBe('refused');
    expect(res.reason).toContain('refs/replace');
  });

  it('refuses when the tracking ref disagrees with the real remote main', () => {
    // BUG CAUGHT: trusting refs/remotes/github/main — stale, rolled back, or moved
    // by hand with update-ref — as the public base.
    const { root, bare, work, git } = makeFixture();
    write(work, { '.orchestrator/policy/public-export.json': POLICY, 'src/a.mjs': 'a\n' });
    commitAll(work, 'one');
    const other = join(root, 'other');
    fixtureGit(['clone', '-q', bare, other]);
    write(other, { 'hotfix.md': 'direct\n' });
    commitAll(other, 'direct github commit');
    fixtureGit(['push', '-q', 'origin', 'main'], other);

    const res = buildGithubExport({ git, snapshotCheck: okCheck });
    expect(res.status).toBe('refused');
    expect(res.reason).toContain('fetch github first');
    expect(fixtureGitSpawn(['rev-parse', '--verify', '--quiet', EXPORT_REF], work).status).not.toBe(0);
  });

  it.each([
    ['remote.github.pushurl points elsewhere', (work, bare, other) => fixtureGit(['remote', 'set-url', '--push', 'github', other], work)],
    ['url.*.pushInsteadOf rewrites the push target', (work, bare, other) => fixtureGit(['config', `url.${other}.pushInsteadOf`, bare], work)],
  ])('refuses when the push URL differs from the fetch URL (%s); a dry-run only warns', (_label, divert) => {
    // BUG CAUGHT: the anchor is read through the FETCH URL while `git push github` goes
    // to the push URL — the verified main would describe a different repository.
    const { root, bare, work, git } = makeFixture();
    const other = join(root, 'elsewhere.git');
    fixtureGit(['init', '-q', '--bare', '-b', 'main', other]);
    write(work, { '.orchestrator/policy/public-export.json': POLICY, 'src/a.mjs': 'a\n' });
    commitAll(work, 'one');
    divert(work, bare, other);

    const res = buildGithubExport({ git, snapshotCheck: okCheck });
    expect(res.status).toBe('refused');
    expect(res.reason).toContain('push URL');
    expect(fixtureGitSpawn(['rev-parse', '--verify', '--quiet', EXPORT_REF], work).status).not.toBe(0);

    const dry = buildGithubExport({ git, snapshotCheck: okCheck, dryRun: true });
    expect(dry.status).toBe('dry-run');
    expect(dry.warnings?.[0]).toContain('push URL');
  });

  it('refuses when the mirror ref does not resolve', () => {
    // BUG CAUGHT: a missing github/main skipping the parent anchor.
    const { work, git } = makeFixture();
    write(work, { '.orchestrator/policy/public-export.json': POLICY, 'src/a.mjs': 'a\n' });
    commitAll(work, 'one');
    fixtureGit(['update-ref', '-d', 'refs/remotes/github/main'], work);

    const res = buildGithubExport({ git, snapshotCheck: okCheck });
    expect(res.status).toBe('refused');
    expect(res.reason).toContain('refs/remotes/github/main');
  });

  it('a directory exclude does not swallow a sibling that merely shares the prefix', () => {
    // BUG CAUGHT: string-prefix matching without the boundary drops `docs/auditsX.md`.
    const { work, git } = makeFixture();
    write(work, {
      '.orchestrator/policy/public-export.json': POLICY,
      'docs/audits/a.md': 'private\n',
      'docs/auditsX.md': 'public sibling\n',
      '.vault.yaml.example': 'public sibling of an exact-file exclude\n',
      '.vault.yaml': 'private\n',
    });
    commitAll(work, 'siblings');
    const res = buildGithubExport({ git, snapshotCheck: okCheck });
    expect(res.status).toBe('created');
    const files = fixtureGit(['ls-tree', '-r', '--name-only', EXPORT_REF], work).trim().split('\n');
    expect(files).toContain('docs/auditsX.md');
    expect(files).toContain('.vault.yaml.example');
    expect(files).not.toContain('docs/audits/a.md');
    expect(files).not.toContain('.vault.yaml');
  });

  it('a failed snapshot check refuses and never moves the export ref', () => {
    // BUG CAUGHT: the check verdict computed but not gating the ref update.
    const { work, git } = makeFixture();
    write(work, { '.orchestrator/policy/public-export.json': POLICY, 'src/a.mjs': 'a\n' });
    commitAll(work, 'one');
    const res = buildGithubExport({ git, snapshotCheck: () => ({ ok: false, reason: 'leakage scan failed (1 finding(s))' }) });
    expect(res.status).toBe('refused');
    expect(fixtureGitSpawn(['rev-parse', '--verify', '--quiet', EXPORT_REF], work).status).not.toBe(0);
  });

  it('the default snapshot check refuses a public doc that cites an excluded path, and passes once it does not', () => {
    // BUG CAUGHT: the curated tree drops docs/audits/ while a public doc still cites
    // it — validate-plugin is green on GitLab (the file exists there) and red on the
    // GitHub snapshot. Runs the REAL default check (leakage scan + citation guard).
    const cfg = makeTmpDir('so-gh-export-owner-');
    dirs.push(cfg);
    chmodSync(cfg, 0o700);
    const ownerFile = join(cfg, 'owner-patterns.json');
    writeFileSync(ownerFile, JSON.stringify({ version: 1, usernamePrefixes: ['zzfixture'] }), { mode: 0o600 });
    vi.stubEnv('SO_CONFIG_HOME', cfg);
    vi.stubEnv('SO_OWNER_PATTERNS_FILE', ownerFile);
    vi.stubEnv('SO_CONFIDENTIAL_NAMES_FILE', '');
    try {
      const { work, git } = makeFixture();
      write(work, {
        '.orchestrator/policy/public-export.json': POLICY,
        'docs/audits/a.md': 'private\n',
        'docs/guide.md': 'Evidence: `docs/audits/a.md` and [the report](./audits/a.md).\n',
      });
      commitAll(work, 'public doc cites a private audit');

      const refused = buildGithubExport({ git });
      expect(refused.status).toBe('refused');
      expect(refused.reason).toContain('point into excluded paths');
      expect(refused.findings).toEqual(['docs/guide.md:1 → docs/audits/a.md', 'docs/guide.md:1 → ./audits/a.md']);
      expect(fixtureGitSpawn(['rev-parse', '--verify', '--quiet', EXPORT_REF], work).status).not.toBe(0);

      write(work, { 'docs/guide.md': 'Evidence: the internal audit (not in the public mirror).\n' });
      commitAll(work, 'reword');
      expect(buildGithubExport({ git }).status).toBe('created');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the CLI offers no parent override', () => {
    // BUG CAUGHT: `--parent-ref main` → the export parented on private main.
    const { work } = makeFixture();
    write(work, { '.orchestrator/policy/public-export.json': POLICY, 'src/a.mjs': 'a\n' });
    commitAll(work, 'private commit');

    const cli = resolve(import.meta.dirname, '..', '..', 'scripts', 'github-export.mjs');
    const res = spawnSync(process.execPath, [cli, '--parent-ref', 'main'], {
      cwd: work, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...ID_ENV },
    });
    expect(res.status).toBe(1);
    expect(fixtureGitSpawn(['rev-parse', '--verify', '--quiet', EXPORT_REF], work).status).not.toBe(0);
  });
});
