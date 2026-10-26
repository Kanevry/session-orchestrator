// tests/scripts/release-curated.test.mjs
//
// `release.mjs --publish` under `mirror: curated` (#1645). Throwaway repos with
// local bare remotes only — nothing here reaches a network remote.
//
// Bugs caught (each red on the pre-#1645 code):
//   1. The publish tail pushed `main` + the tag straight to `github`: under
//      `mirror: curated` that publishes the full private history (or, with a
//      snapshot already on github main, fails non-fast-forward after the npm
//      receipt). It must push only the verified snapshot and tag THAT commit.
//   2. `head-pushed-github` compared github/main's sha with HEAD — impossible to
//      satisfy under curated, so no curated release could pass preflight; and
//      GitHub's CI was asked about HEAD, a commit GitHub never receives.
//   3. A checkout whose Session Config lacks the `mirror` key while the repo has
//      adopted the export policy fell back to the plain push of private history.
//   4. HEAD drifting after preflight (a parallel session switching branch) got
//      tagged and snapshotted onto GitHub main — an unreviewed commit published.
//   5. `mirror: none` was ignored: release pushed main and the tag to github.
//   6. A diverging github push URL was refused only after npm publish (#1693).
//   7. Preflight passed with an export tree no suite had ever run on (#1712).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { evaluateGithubMirrorPreflight, evaluateSnapshotProbePreflight, runPublishRelease, tagAndPush } from '../../scripts/release.mjs';
import { buildGithubExport, createGitRunner, parseSourceCommitTrailer } from '../../scripts/lib/github-export.mjs';
import { RECEIPT_DIR_REL, computeSnapshotTree } from '../../scripts/lib/snapshot-probe.mjs';
import { fixtureGit, fixtureGitSpawn, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const ID_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const GIT_ENV = {
  ...process.env,
  ...ID_ENV,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

let root;
beforeEach(() => {
  root = makeTmpDir('release-curated-');
  // release.mjs spawns git with process.env: pin identity, no host config (no tag signing).
  for (const [k, v] of Object.entries({ ...ID_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' })) {
    vi.stubEnv(k, v);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTree(root);
});

const git = (cwd, args) => fixtureGit(['-C', cwd, ...args], undefined, { env: GIT_ENV, encoding: 'utf8' }).trim();
const hasObject = (repo, sha) => fixtureGitSpawn(['-C', repo, 'cat-file', '-e', sha], undefined, { env: GIT_ENV }).status === 0;
const runner = (dir) => {
  const base = createGitRunner(dir);
  return (args, o = {}) => base(args, { ...o, env: { ...GIT_ENV, ...(o.env ?? {}) } });
};

/**
 * github (bare, seeded public root) and origin (bare) remotes; work clone on main
 * with a private release commit pushed to origin. `mirrorLine` null omits the key.
 */
function fixture({ mirrorLine = 'mirror: curated' } = {}) {
  const github = join(root, 'github.git');
  const seed = join(root, 'seed');
  fixtureGit(['init', '-q', '--bare', '-b', 'main', github], undefined, { env: GIT_ENV });
  fixtureGit(['init', '-q', '-b', 'main', seed], undefined, { env: GIT_ENV });
  writeFileSync(join(seed, 'README.md'), 'public\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'public root']);
  git(seed, ['push', '-q', github, 'main']);
  const seeded = git(github, ['rev-parse', 'main']);

  const dir = join(root, 'work');
  fixtureGit(['clone', '-q', '-o', 'github', github, dir], undefined, { env: GIT_ENV });
  mkdirSync(join(dir, '.orchestrator', 'policy'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'audits'), { recursive: true });
  writeFileSync(join(dir, '.orchestrator', 'policy', 'public-export.json'), JSON.stringify({
    version: 1, exclude: [{ path: 'docs/audits/', reason: 'fixture', issue: '#1645' }],
  }));
  writeFileSync(join(dir, 'docs', 'audits', 'private.md'), 'private\n');
  writeFileSync(join(dir, 'CLAUDE.md'), `# fixture\n\n## Session Config\n\nvcs: gitlab\n${mirrorLine ? `${mirrorLine}\n` : ''}`);
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-16\n\n- fixture release\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'release 1.0.0']);
  const origin = join(root, 'origin.git');
  fixtureGit(['init', '-q', '--bare', '-b', 'main', origin], undefined, { env: GIT_ENV });
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['push', '-q', 'origin', 'main']);
  return { dir, github, origin, seeded, head: git(dir, ['rev-parse', 'HEAD']) };
}

/** What `/close` does under curated: the snapshot of HEAD becomes github main. */
function publishSnapshot(dir, head) {
  const built = buildGithubExport({ git: runner(dir), source: head, snapshotCheck: () => ({ ok: true }) });
  expect(built.status).toBe('created');
  git(dir, ['push', '-q', 'github', `${built.sha}:refs/heads/main`]);
  git(dir, ['fetch', '-q', 'github']);
  return built.sha;
}

const stubTail = {
  publishImpl: () => ({
    receipt: { confirmed: true, target: '1.0.0' },
    propagation: { ok: true, kind: 'verified', detail: 'fixture' },
  }),
  ensureGithubReleaseImpl: () => ({ ok: true, created: true, state: 'created', detail: 'stub' }),
  verifyLiveSiteImpl: async () => ({ ok: true, detail: 'stub' }),
};

describe('release --publish under mirror: curated', () => {
  it('tags the published snapshot on github and never pushes HEAD or main there', async () => {
    const { dir, github, origin, head } = fixture();
    const snapshot = publishSnapshot(dir, head);

    const outcome = await runPublishRelease(dir, '1.0.0', { ...stubTail, expectedHead: head });

    expect(outcome.status).toBe('complete');
    expect(outcome.githubSnapshot).toBe(snapshot);
    expect(git(github, ['rev-parse', 'main'])).toBe(snapshot);
    expect(git(github, ['rev-parse', 'refs/tags/v1.0.0^{commit}'])).toBe(snapshot);
    expect(hasObject(github, head)).toBe(false);
    // GitLab keeps the annotated tag on the release commit itself.
    expect(git(origin, ['rev-parse', 'refs/tags/v1.0.0^{commit}'])).toBe(head);
    expect(git(origin, ['rev-parse', 'main'])).toBe(head);
  });

  it('with no snapshot published yet: pushes a verified fresh snapshot, never HEAD', async () => {
    const { dir, github, head, seeded } = fixture();

    const res = await tagAndPush(dir, '1.0.0', { expectedHead: head, snapshotCheck: () => ({ ok: true }) });

    const published = git(github, ['rev-parse', 'main']);
    expect(res.githubSnapshot).toBe(published);
    expect(git(github, ['rev-parse', `${published}^`])).toBe(seeded);
    expect(parseSourceCommitTrailer(git(github, ['cat-file', 'commit', published]))).toBe(head);
    expect(git(github, ['rev-parse', 'refs/tags/v1.0.0^{commit}'])).toBe(published);
    expect(hasObject(github, head)).toBe(false);
    expect(git(github, ['ls-tree', '-r', '--name-only', 'main']).split('\n')).not.toContain('docs/audits/private.md');
  });
});

describe('HEAD drift between preflight and the publish tail', () => {
  // Security review (MEDIUM): BUG CAUGHT: the tail snapshotted whatever HEAD was at
  // tag time; a branch switch after preflight published an unreviewed commit.
  it('refuses to tag or publish anything when HEAD is no longer the preflight HEAD', async () => {
    const { dir, github, origin, head } = fixture();
    const snapshot = publishSnapshot(dir, head);
    git(dir, ['checkout', '-q', '-b', 'feature/x']);
    writeFileSync(join(dir, 'UNREVIEWED.md'), 'unreviewed\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'unreviewed']);
    const drifted = git(dir, ['rev-parse', 'HEAD']);

    const outcome = await runPublishRelease(dir, '1.0.0', { ...stubTail, expectedHead: head });

    expect(outcome.status).toBe('post-publish-reconciliation');
    expect(outcome.reconciliation[0]).toMatchObject({ phase: 'tag-and-push', detail: expect.stringContaining('HEAD moved since preflight') });
    expect(outcome.tagProgress.localTagCreated).toBe(false);
    expect(git(origin, ['tag', '-l'])).toBe('');
    expect(git(github, ['rev-parse', 'main'])).toBe(snapshot);
    expect(git(github, ['ls-tree', '-r', '--name-only', 'main']).split('\n')).not.toContain('UNREVIEWED.md');
    expect(git(github, ['tag', '-l'])).toBe('');
    expect(hasObject(github, drifted)).toBe(false);
  });
});

describe('mirror: none', () => {
  // BUG CAUGHT (pre-existing): release ignored `mirror: none` and pushed to github.
  it('skips GitHub entirely in the publish tail and in the preflight rows', async () => {
    const { dir, github, head, seeded } = fixture({ mirrorLine: 'mirror: none' });

    expect(evaluateGithubMirrorPreflight(dir, head)).toMatchObject({ skip: true, mode: { ok: true }, parity: { ok: true } });
    expect(await tagAndPush(dir, '1.0.0', { expectedHead: head })).toEqual({ tag: 'v1.0.0', pushed: ['origin'], githubSkipped: true });
    expect(git(github, ['rev-parse', 'main'])).toBe(seeded);
    expect(git(github, ['tag', '-l'])).toBe('');
  });
});

describe('github preflight rows under mirror: curated', () => {
  it('passes when github/main is the snapshot of HEAD and asks GitHub CI about the snapshot', () => {
    const { dir, head } = fixture();
    const snapshot = publishSnapshot(dir, head);

    const rows = evaluateGithubMirrorPreflight(dir, head);

    expect(rows.mode.ok).toBe(true);
    expect(rows.parity).toMatchObject({ ok: true });
    expect(rows.ciSha).toBe(snapshot);
  });

  it('fails when github/main is not a snapshot of HEAD', () => {
    const { dir, head } = fixture();

    const rows = evaluateGithubMirrorPreflight(dir, head);

    expect(rows.parity.ok).toBe(false);
    expect(rows.parity.detail).toContain('no Source-Commit trailer');
  });

  // BUG CAUGHT (#1693): a blocked `remote.github.pushurl` (the #1631 lock) passed
  // the preflight; only the publish tail refused it — after npm publish.
  it('fails github-push-url when the push URL differs from the fetch URL', () => {
    const { dir, head } = fixture();
    publishSnapshot(dir, head);
    git(dir, ['remote', 'set-url', '--push', 'github', 'no_push-blocked-by-lead-see-issue-1631']);

    const rows = evaluateGithubMirrorPreflight(dir, head);

    expect(rows.parity.ok).toBe(true);
    expect(rows.pushUrl.ok).toBe(false);
    expect(rows.pushUrl.detail).toContain('differs from its fetch URL');
    expect(rows.pushUrl.detail).not.toContain('no_push');
  });
});

describe('snapshot-probe preflight row (#1712)', () => {
  // BUG CAUGHT: 5.13.0 passed preflight with an export tree no suite had ever run on.
  it('is required under curated and keyed by HEAD\'s snapshot tree', () => {
    const { dir, head } = fixture();
    const mirror = evaluateGithubMirrorPreflight(dir, head);

    expect(evaluateSnapshotProbePreflight(dir, head, mirror)).toMatchObject({ ok: false, detail: expect.stringContaining('no probe receipt for snapshot tree') });

    const tree = computeSnapshotTree({ repoRoot: dir, source: head, git: runner(dir) });
    expect(tree.ok).toBe(true);
    mkdirSync(join(dir, RECEIPT_DIR_REL), { recursive: true });
    writeFileSync(join(dir, RECEIPT_DIR_REL, `${tree.snapshotTree}.json`), JSON.stringify({
      schema: 1, sourceSha: head, snapshotTree: tree.snapshotTree, ok: true, route: 'local',
      steps: [{ name: 'validate-plugin', status: 'pass', exitCode: 0, durationMs: 1 }, { name: 'test', status: 'pass', exitCode: 0, durationMs: 1 }],
      finishedAt: '2026-10-21T10:00:00.000Z',
    }));
    expect(evaluateSnapshotProbePreflight(dir, head, mirror).ok).toBe(true);
  });

  it('is skipped under mirror: none', () => {
    const { dir, head } = fixture({ mirrorLine: 'mirror: none' });
    expect(evaluateSnapshotProbePreflight(dir, head, evaluateGithubMirrorPreflight(dir, head)))
      .toEqual({ ok: true, detail: 'skipped — not mirror: curated' });
  });
});

describe('keyless Session Config in a repo that adopted the export policy', () => {
  it('fails preflight and pushes nothing to github', async () => {
    const { dir, github, head, seeded } = fixture({ mirrorLine: null });

    expect(evaluateGithubMirrorPreflight(dir, head).mode).toMatchObject({ ok: false });
    await expect(tagAndPush(dir, '1.0.0', { expectedHead: head })).rejects.toThrow(/plain push to github refused/);
    expect(git(github, ['rev-parse', 'main'])).toBe(seeded);
    expect(hasObject(github, head)).toBe(false);
    expect(fixtureGitSpawn(['-C', github, 'rev-parse', '--verify', '-q', 'refs/tags/v1.0.0'], undefined, { env: GIT_ENV }).status).not.toBe(0);
  });

  it('plain repo without a policy anywhere keeps the plain push (unchanged)', async () => {
    const { dir, github, head } = fixture({ mirrorLine: null });
    git(dir, ['rm', '-q', '-r', '.orchestrator', 'docs']);
    git(dir, ['commit', '-q', '-m', 'drop policy']);
    git(dir, ['push', '-q', 'origin', 'main']);
    const newHead = git(dir, ['rev-parse', 'HEAD']);
    expect(newHead).not.toBe(head);

    expect(await tagAndPush(dir, '1.0.0', { expectedHead: newHead })).toEqual({ tag: 'v1.0.0', pushed: ['origin', 'github'] });
    expect(git(github, ['rev-parse', 'main'])).toBe(newHead);
  });
});
