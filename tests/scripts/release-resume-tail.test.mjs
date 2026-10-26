// tests/scripts/release-resume-tail.test.mjs
//
// `release.mjs --resume-tail` finishes an interrupted publish tail (SO#1791),
// and every network child of a tail now runs with a deadline in its own
// process group. Throwaway repos only: origin and github are local bare repos,
// the GitHub release, the live site and the registry are stubbed. No network,
// no npm, no real remote.
//
// Bugs caught:
//   R1 A second run re-tags or re-pushes (`git tag -a` on an existing tag
//      fails; a blind re-push runs the pre-push gate again) — the resume must
//      be idempotent, and it must tag the RECORDED commit even when HEAD moved.
//   R2 A tag that already exists at a DIFFERENT commit (local or on origin) is
//      silently accepted as "done" — a release tag on the wrong commit.
//   R3 A hung `git push` never ends (Security-Review W4): the tail blocks
//      forever and the hook process under the push survives as an orphan.
//   R4 The same hang in the ARMED publish tail (tagAndPush) never ends.
//   R5 Flag combinations: --resume-tail without --target, or beside --publish
//      / --reconcile, must be a usage error before anything runs.
//   F2 The leader of a timed-out tail child exits on SIGTERM, a group member
//      ignoring SIGTERM keeps running: `close` of the leader cancelled the
//      SIGKILL, the member survived as an orphan and nobody reported it.
//   F3 Under `mirror: curated` an EXISTING github tag was accepted as
//      "present" without checking that its snapshot's Source-Commit is the
//      release commit — a release tag on an unrelated public snapshot.
//   F4 A forged proof (registry integrity mismatch) still created and pushed
//      the tag before the registry check ran — mutation before verification.
//   F5 Outside `mirror: curated` the resume pushed the release tag to github
//      without `plainPushGuard`: a checkout whose Session Config predates the
//      curated export (no `mirror` key) while HEAD carries the export policy
//      published the private release commit and its history to the mirror.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { fixtureGit, fixtureGitSpawn, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';
import {
  buildReleaseProof,
  printResumeTailOutcome,
  resumeReleaseTail,
  runPublishRelease,
  runTailChild,
  validateFlags,
  writeReleaseProof,
} from '../../scripts/release.mjs';

const ID_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const GIT_ENV = { ...process.env, ...ID_ENV, ...ISOLATION };
const git = (cwd, args) => fixtureGit(['-C', cwd, ...args], undefined, { env: GIT_ENV, encoding: 'utf8' }).trim();
const tagAt = (repo, ref) => fixtureGitSpawn(['-C', repo, 'rev-parse', '--verify', '-q', ref], undefined, { env: GIT_ENV, encoding: 'utf8' });

let root;
beforeEach(() => {
  root = makeTmpDir('release-resume-tail-');
  // release.mjs spawns git with process.env: pin identity, no host config (no tag signing).
  for (const [k, v] of Object.entries({ ...ID_ENV, ...ISOLATION })) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTree(root);
});

/**
 * A released repo whose tail died right after the npm receipt: main is on
 * origin and github, the proof names the release commit, no tag exists yet.
 * The pre-push hook appends one line per push to `pushes`.
 */
function fixture({ hookBody = '', mirror = 'github' } = {}) {
  const origin = join(root, 'origin.git');
  const github = join(root, 'github.git');
  const dir = join(root, 'work');
  const hooks = join(root, 'hooks');
  const pushes = join(root, 'pushes');
  mkdirSync(hooks);
  for (const bare of [origin, github]) fixtureGit(['init', '-q', '--bare', '-b', 'main', bare], undefined, { env: GIT_ENV });
  fixtureGit(['init', '-q', '-b', 'main', dir], undefined, { env: GIT_ENV });
  writeFileSync(join(dir, 'CLAUDE.md'), `# fixture\n\n## Session Config\n\nvcs: gitlab\n${mirror === null ? '' : `mirror: ${mirror}\n`}`);
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-24\n\n- fixture release\n');
  writeFileSync(join(dir, '.gitignore'), '.orchestrator/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'release 1.0.0']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['remote', 'add', 'github', github]);
  git(dir, ['push', '-q', 'origin', 'main']);
  git(dir, ['push', '-q', 'github', 'main']);
  const proof = writeReleaseProof(dir, buildReleaseProof({
    target: '1.0.0',
    artifact: { digest: 'a'.repeat(64), integrity: `sha512-${'A'.repeat(86)}==` },
    commit: head,
    receiptAt: '2026-10-24T10:00:00.000Z',
  }));
  expect(proof.ok).toBe(true);
  const hook = join(hooks, 'pre-push');
  writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${pushes}'\n${hookBody}\n`);
  chmodSync(hook, 0o755);
  git(dir, ['config', 'core.hooksPath', hooks]);
  return { dir, origin, github, head, pushes };
}

const pushCount = (pushes) => (existsSync(pushes) ? readFileSync(pushes, 'utf8').split('\n').filter(Boolean).length : 0);

function stubs() {
  const calls = { release: 0, live: 0, registry: 0 };
  let released = false;
  return {
    calls,
    deps: {
      log: () => {},
      ensureGithubReleaseImpl: () => {
        calls.release += 1;
        const created = !released;
        released = true;
        return { ok: true, created, detail: created ? 'stub release created' : 'stub release exists — no-op' };
      },
      verifyLiveSiteImpl: async () => { calls.live += 1; return { ok: true, detail: 'stub live' }; },
      reconcileReleaseImpl: () => { calls.registry += 1; return { ok: true, state: 'installable', detail: 'stub installable' }; },
    },
  };
}

describe('--resume-tail', () => {
  it('R1: finishes the tail in one run on the recorded commit, and a second run changes nothing', async () => {
    const { dir, origin, github, head, pushes } = fixture();
    // A later commit on the local checkout: the resume must ignore HEAD.
    writeFileSync(join(dir, 'later.txt'), 'later\n');
    git(dir, ['add', 'later.txt']);
    git(dir, ['commit', '-q', '-m', 'later work']);
    const { calls, deps } = stubs();

    const first = await resumeReleaseTail(dir, '1.0.0', deps);
    expect(first.status).toBe('complete');
    expect(git(origin, ['rev-parse', 'refs/tags/v1.0.0^{commit}'])).toBe(head);
    expect(git(github, ['rev-parse', 'refs/tags/v1.0.0^{commit}'])).toBe(head);
    expect(pushCount(pushes)).toBe(2);

    const second = await resumeReleaseTail(dir, '1.0.0', deps);
    expect(second.status).toBe('complete');
    expect(second.steps.filter((s) => /-tag$/.test(s.phase)).map((s) => `${s.phase}:${s.state}`))
      .toEqual(['local-tag:present', 'origin-tag:present', 'github-tag:present']);
    expect(pushCount(pushes)).toBe(2);
    expect(calls).toEqual({ release: 2, live: 2, registry: 2 });
    expect(printResumeTailOutcome(second, { log: () => {}, error: () => {} })).toBe(0);
  });

  it('R2: refuses a local tag at a foreign commit and pushes nothing', async () => {
    const { dir, origin, pushes } = fixture();
    writeFileSync(join(dir, 'other.txt'), 'other\n');
    git(dir, ['add', 'other.txt']);
    git(dir, ['commit', '-q', '-m', 'other']);
    git(dir, ['tag', '-a', 'v1.0.0', '-m', 'wrong commit']);
    const { calls, deps } = stubs();

    const outcome = await resumeReleaseTail(dir, '1.0.0', deps);

    expect(outcome.status).toBe('refused');
    expect(outcome.steps.at(-1)).toMatchObject({ phase: 'local-tag', state: 'refused' });
    expect(tagAt(origin, 'refs/tags/v1.0.0').status).not.toBe(0);
    expect(pushCount(pushes)).toBe(0);
    // The read-only registry check runs first (F4); nothing after the refusal.
    expect(calls).toEqual({ release: 0, live: 0, registry: 1 });
  });

  it('R2: refuses an origin tag at a foreign commit and leaves github untouched', async () => {
    const { dir, github, pushes } = fixture();
    // Someone pushed v1.0.0 on a different commit to origin (bypassing the hook counter).
    const work2 = join(root, 'work2');
    fixtureGit(['clone', '-q', join(root, 'origin.git'), work2], undefined, { env: GIT_ENV });
    writeFileSync(join(work2, 'x.txt'), 'x\n');
    git(work2, ['add', 'x.txt']);
    git(work2, ['commit', '-q', '-m', 'foreign']);
    git(work2, ['tag', 'v1.0.0']);
    git(work2, ['push', '-q', 'origin', 'refs/tags/v1.0.0']);
    const { deps } = stubs();

    const outcome = await resumeReleaseTail(dir, '1.0.0', deps);

    expect(outcome.status).toBe('refused');
    expect(outcome.steps.at(-1)).toMatchObject({ phase: 'origin-tag', state: 'refused' });
    expect(tagAt(github, 'refs/tags/v1.0.0').status).not.toBe(0);
    expect(pushCount(pushes)).toBe(0);
  });

  it('R3: a hung push ends at its deadline, kills its process group and says to resume again', { timeout: 30_000 }, async () => {
    const pidFile = join(root, 'hook.pid');
    const { dir, origin } = fixture({ hookBody: `echo $$ > '${pidFile}'\nsleep 60` });
    const logged = [];
    const { calls, deps } = stubs();
    const started = Date.now();

    const outcome = await resumeReleaseTail(dir, '1.0.0', { ...deps, tailTimeoutMs: 1000, log: (s) => logged.push(s) });

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(outcome.status).toBe('incomplete');
    const step = outcome.steps.find((s) => s.phase === 'origin-tag');
    expect(step.state).toBe('failed');
    expect(step.detail).toMatch(/timed out after 1 s; process group \d+ was sent SIGTERM/);
    expect(outcome.steps.find((s) => s.phase === 'github-release').state).toBe('skipped');
    expect(calls.release).toBe(0);
    expect(logged.join('')).toMatch(/tail child pid \d+ \(process group \d+\): git push origin/);
    expect(tagAt(origin, 'refs/tags/v1.0.0').status).not.toBe(0);
    // The hook shell under the push is gone, not orphaned.
    const hookPid = Number(readFileSync(pidFile, 'utf8').trim());
    await vi.waitFor(() => expect(() => process.kill(hookPid, 0)).toThrow(), { timeout: 5_000 });
    const errors = [];
    expect(printResumeTailOutcome(outcome, { log: () => {}, error: (s) => errors.push(s) })).toBe(1);
    expect(errors.join('\n')).toContain('node scripts/release.mjs --resume-tail --target 1.0.0');
  });

  it('refuses when the proof records no commit', async () => {
    const { dir } = fixture();
    writeReleaseProof(dir, buildReleaseProof({
      target: '1.0.0',
      artifact: { digest: 'a'.repeat(64), integrity: `sha512-${'A'.repeat(86)}==` },
      commit: null,
      receiptAt: '2026-10-24T10:00:00.000Z',
    }));
    const { deps } = stubs();

    const outcome = await resumeReleaseTail(dir, '1.0.0', deps);

    expect(outcome).toMatchObject({ status: 'refused', commit: null });
    expect(outcome.steps).toEqual([expect.objectContaining({ phase: 'proof', state: 'refused' })]);
    expect(tagAt(dir, 'refs/tags/v1.0.0').status).not.toBe(0);
  });
});

/** Push a commit carrying `Source-Commit: <source>` to github as the lightweight tag v1.0.0. */
function githubSnapshotTag(github, source) {
  const snap = join(root, 'snap');
  fixtureGit(['init', '-q', '-b', 'main', snap], undefined, { env: GIT_ENV });
  writeFileSync(join(snap, 'public.txt'), 'public snapshot\n');
  git(snap, ['add', 'public.txt']);
  git(snap, ['commit', '-q', '-m', 'snapshot', '-m', `Source-Commit: ${source}`]);
  git(snap, ['push', '-q', github, 'HEAD:refs/tags/v1.0.0']);
  return git(snap, ['rev-parse', 'HEAD']);
}

describe('--resume-tail verification order and curated tags', () => {
  it('F4: a registry integrity mismatch refuses before any tag is created or pushed', async () => {
    const { dir, origin, pushes } = fixture();
    const { calls, deps } = stubs();
    deps.reconcileReleaseImpl = () => {
      calls.registry += 1;
      return { ok: false, state: 'failed', reason: 'integrity-mismatch', detail: 'registry dist.integrity differs from the checked archive' };
    };

    const outcome = await resumeReleaseTail(dir, '1.0.0', deps);

    expect(outcome.status).toBe('refused');
    expect(outcome.steps.at(-1)).toMatchObject({ phase: 'registry', state: 'refused' });
    expect(pushCount(pushes)).toBe(0);
    expect(tagAt(dir, 'refs/tags/v1.0.0').status).not.toBe(0);
    expect(tagAt(origin, 'refs/tags/v1.0.0').status).not.toBe(0);
    expect(calls).toEqual({ release: 0, live: 0, registry: 1 });
  });

  it('F5: no mirror key while HEAD carries the export policy — refused before any github push', async () => {
    const { dir, origin, github, head, pushes } = fixture({ mirror: null });
    mkdirSync(join(dir, '.orchestrator', 'policy'), { recursive: true });
    writeFileSync(join(dir, '.orchestrator', 'policy', 'public-export.json'), '{}\n');
    git(dir, ['add', '-f', '.orchestrator/policy/public-export.json']);
    git(dir, ['commit', '-q', '-m', 'adopt curated export']);
    const { calls, deps } = stubs();

    const outcome = await resumeReleaseTail(dir, '1.0.0', deps);

    expect(outcome.status).toBe('refused');
    expect(outcome.steps.at(-1)).toMatchObject({ phase: 'github-tag', state: 'refused' });
    expect(outcome.steps.at(-1).detail).toContain('plain push to github refused — HEAD carries .orchestrator/policy/public-export.json');
    expect(tagAt(github, 'refs/tags/v1.0.0').status).not.toBe(0);
    // The origin tag keeps its behaviour: pushed before the github step.
    expect(git(origin, ['rev-parse', 'refs/tags/v1.0.0^{commit}'])).toBe(head);
    expect(readFileSync(pushes, 'utf8').split('\n').filter(Boolean)).toEqual(['origin']);
    expect(calls.release).toBe(0);
  });

  it('F3: curated — an existing github tag on a snapshot of another commit is refused, not "present"', async () => {
    const { dir, github } = fixture({ mirror: 'curated' });
    githubSnapshotTag(github, 'd'.repeat(40));
    const { calls, deps } = stubs();

    const outcome = await resumeReleaseTail(dir, '1.0.0', deps);

    expect(outcome.status).toBe('refused');
    expect(outcome.steps.at(-1)).toMatchObject({ phase: 'github-tag', state: 'refused' });
    expect(outcome.steps.at(-1).detail).toContain(`Source-Commit: ${'d'.repeat(40)}`);
    expect(calls.release).toBe(0);
  });

  it('F3: curated — an existing github tag on the snapshot of the release commit is accepted', async () => {
    const { dir, github, head } = fixture({ mirror: 'curated' });
    const snapshot = githubSnapshotTag(github, head);
    const { deps } = stubs();

    const outcome = await resumeReleaseTail(dir, '1.0.0', deps);

    expect(outcome.status).toBe('complete');
    expect(outcome.steps.find((s) => s.phase === 'github-tag')).toMatchObject({ state: 'present' });
    expect(git(github, ['rev-parse', 'refs/tags/v1.0.0^{commit}'])).toBe(snapshot);
    // The check fetch leaves no tracking ref behind in the release checkout.
    expect(tagAt(dir, 'refs/remotes/github/tags/v1.0.0').status).not.toBe(0);
  });
});

describe('runTailChild deadline (F2)', () => {
  it.skipIf(process.platform === 'win32')('a group member that ignores SIGTERM is SIGKILLed after the leader exits', { timeout: 20_000 }, async () => {
    const pidFile = join(root, 'member.pid');
    const readyFile = join(root, 'member.ready');
    // The member ignores SIGTERM and drops the inherited pipes, so the leader's
    // `close` arrives while the member is still running. It writes the ready
    // file only AFTER its trap is installed, and the leader waits for that file
    // before it sleeps: the deadline (generous, so a loaded host still reaches
    // the ready state first) can only fire on a member that already ignores TERM.
    const script = `(trap "" TERM; : > '${readyFile}'; exec >/dev/null 2>&1; sleep 30) & echo $! > '${pidFile}'; ` +
      `while [ ! -f '${readyFile}' ]; do sleep 0.05; done; exec sleep 30`;
    let member = 0;
    try {
      const res = await runTailChild('sh', ['-c', script], { timeoutMs: 3_000, graceMs: 150, log: () => {} });
      member = Number(readFileSync(pidFile, 'utf8').trim());
      expect(existsSync(readyFile)).toBe(true);
      expect(res.timedOut).toBe(true);
      expect(res.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(res.survivors).toEqual([]);
      await vi.waitFor(() => expect(() => process.kill(member, 0)).toThrow(), { timeout: 2_000 });
    } finally {
      if (member) try { process.kill(member, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  // Above every platform's pid_max: should a real process.kill ever see it
  // (the pre-fix code ignores killImpl), it can only answer ESRCH.
  const FAKE_PID = 99_999_999;

  /** A fake leader: exits on SIGTERM; its process group answers the probe as told. */
  function fakeChild(groupAlive) {
    const calls = [];
    let child;
    const spawnImpl = () => {
      child = Object.assign(new EventEmitter(), { pid: FAKE_PID, stdout: null, stderr: null });
      return child;
    };
    const killImpl = (pid, sig) => {
      calls.push([pid, sig]);
      if (sig === 'SIGTERM') setImmediate(() => child.emit('close', null));
      if (sig === 0 && !groupAlive()) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    };
    return { calls, spawnImpl, killImpl, child: () => child };
  }

  it.skipIf(process.platform === 'win32')('reports the group as survivor only when it is still alive after SIGKILL', { timeout: 15_000 }, async () => {
    const fake = fakeChild(() => true);
    const res = await runTailChild('git', ['push'], { timeoutMs: 50, graceMs: 50, log: () => {}, spawnImpl: fake.spawnImpl, killImpl: fake.killImpl });
    expect(res.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(res.survivors).toEqual([`process group ${FAKE_PID}`]);
  });

  it.skipIf(process.platform === 'win32')('a child that exits before its deadline is never probed or signalled', async () => {
    const fake = fakeChild(() => false);
    const pending = runTailChild('git', ['push'], { timeoutMs: 5_000, log: () => {}, spawnImpl: fake.spawnImpl, killImpl: fake.killImpl });
    fake.child().emit('close', 0);
    const res = await pending;
    expect(res).toMatchObject({ status: 0, timedOut: false, killSignals: [] });
    expect(fake.calls).toEqual([]);
  });
});

describe('armed publish tail deadline', () => {
  it('R4: a hung push inside tagAndPush ends as a tag-and-push reconciliation item', { timeout: 30_000 }, async () => {
    const { dir, head } = fixture({ hookBody: 'sleep 60' });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const outcome = await runPublishRelease(dir, '1.0.0', {
        expectedHead: head,
        tailTimeoutMs: 1000,
        publishImpl: () => ({ receipt: { confirmed: true, target: '1.0.0', detail: 'stub' }, propagation: { ok: true, detail: 'stub' }, proof: { ok: true, detail: 'stub' } }),
        ensureGithubReleaseImpl: () => { throw new Error('must not run after a failed push'); },
        verifyLiveSiteImpl: async () => { throw new Error('must not run after a failed push'); },
      });
      expect(outcome.status).toBe('post-publish-reconciliation');
      expect(outcome.reconciliation[0].phase).toBe('tag-and-push');
      expect(outcome.reconciliation[0].detail).toMatch(/git push origin main timed out after 1 s; process group \d+ was sent SIGTERM/);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('validateFlags --resume-tail (R5)', () => {
  it('requires --target', () => {
    expect(validateFlags({ 'resume-tail': true })).toMatchObject({ ok: false, code: 2, message: expect.stringContaining('requires --target') });
  });
  it.each([['publish'], ['check'], ['reconcile'], ['skip-ci']])('refuses --%s beside it', (flag) => {
    expect(validateFlags({ 'resume-tail': true, target: '1.0.0', [flag]: true })).toMatchObject({ ok: false, code: 2 });
  });
  it('accepts --resume-tail --target X.Y.Z', () => {
    expect(validateFlags({ 'resume-tail': true, target: '1.0.0' })).toEqual({ ok: true });
  });
});
