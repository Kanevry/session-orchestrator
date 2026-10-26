// tests/scripts/release-tail-shield.test.mjs
//
// The publish tail survives SIGTERM after npm's receipt (SO#1753). Incident
// 2026-10-23 (5.13.0): `timeout 580 node scripts/release.mjs --publish` was
// killed after npm had accepted the version; the annotated tag stayed local and
// no GitHub release was made.
//
// Each test runs the real settlePublishReceipt -> tagAndPush -> printPublishOutcome
// path in a child node process that leads its own process group, like a
// command under GNU `timeout`, and signals the WHOLE group, as `timeout` does.
// npm and the live site are stubbed; origin is a local bare repo. No network.
//
// Bugs caught:
//   T1 Without the shield node dies on SIGTERM -> origin never gets the tag (the
//      5.13.0 state). With a handler but without detached children, the
//      `git push` child dies with the group -> again no origin tag.
//   T2 A shield armed before the receipt would make a normal pre-receipt abort
//      impossible; the child must still die by SIGTERM there.
//   T3 T1/T2 hand the callback over themselves; T3 drives the REAL exported
//      publish(), so a dropped or broken `onReceiptConfirmed` line there (the
//      one production wiring of the shield) dies at SIGTERM like 5.13.0.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const RELEASE_MODULE = pathToFileURL(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../scripts/release.mjs')).href;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

// FIX_VIA unset mirrors publish()'s wiring by hand (T1/T2); FIX_VIA=publish runs
// the real publish() with npm stubbed through runImpl (T3). No fallback for a
// missing export: the child fails loudly if armReleaseTailShield or publish goes.
const HARNESS = `
const { spawnSync } = await import('node:child_process');
const { readFileSync, writeFileSync } = await import('node:fs');
const { createHash } = await import('node:crypto');
const mod = await import(process.env.FIX_MODULE);
const repo = process.env.FIX_REPO;
const marks = process.env.FIX_MARKS;
const target = '1.0.0';
if (process.env.FIX_BLOCK_BEFORE_SETTLE === '1') {
  writeFileSync(marks + '/ready', '');
  await new Promise((r) => setTimeout(r, 8000));
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
if (typeof mod.armReleaseTailShield !== 'function' || typeof mod.publish !== 'function') throw new Error('release.mjs lost an export');
const runImpl = (v) => (cmd, args, opts) => cmd !== 'npm'
  ? spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  : args[0] === 'publish'
    ? { status: 0, stdout: '+ session-orchestrator@' + v + '\\n', stderr: '' }
    : { status: 0, stdout: v + '\\n', stderr: '' };
const viaPublish = (root, v) => {
  const tarballPath = process.env.FIX_TARBALL;
  const digest = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  return mod.publish(root, v, { artifact: { tarballPath, digest, integrity: 'sha512-AAAA' }, attempts: 1, runImpl: runImpl(v) });
};
const viaSettle = (root, v) => mod.settlePublishReceipt(root, v, { status: 0, stdout: '+ session-orchestrator@' + v + '\\n', stderr: '' }, {
  artifact: { digest: 'b'.repeat(64), integrity: 'sha512-AAAA' },
  attempts: 1,
  runImpl: runImpl(v),
  onReceiptConfirmed: () => mod.armReleaseTailShield({ target: v }),
});
const outcome = await mod.runPublishRelease(repo, target, {
  expectedHead: head,
  publishImpl: process.env.FIX_VIA === 'publish' ? viaPublish : viaSettle,
  ensureGithubReleaseImpl: () => { writeFileSync(marks + '/release', ''); return { ok: true, created: true, detail: 'stub release' }; },
  verifyLiveSiteImpl: async () => { writeFileSync(marks + '/live', ''); return { ok: true, detail: 'stub live' }; },
});
process.exitCode = mod.printPublishOutcome(outcome, target);
`;

let root;
let child;

beforeEach(() => { root = makeTmpDir('so-tail-shield-'); child = null; });
afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  removeTree(root);
});

/** Work repo on main (mirror: none) pushed to a bare origin; pre-push hook marks and sleeps 2 s. */
function fixture() {
  const origin = join(root, 'origin.git');
  const dir = join(root, 'work');
  const marks = join(root, 'marks');
  const hooks = join(root, 'hooks');
  mkdirSync(marks);
  mkdirSync(hooks);
  fixtureGit(['init', '-q', '--bare', '-b', 'main', origin], undefined, { env: GIT_ENV });
  fixtureGit(['init', '-q', '-b', 'main', dir], undefined, { env: GIT_ENV });
  writeFileSync(join(dir, 'CLAUDE.md'), '# fixture\n\n## Session Config\n\nvcs: gitlab\nmirror: none\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-24\n\n- fixture release\n');
  // publish() reads NPM_TOKEN from a gitignored .env.local (fake value; npm is stubbed).
  writeFileSync(join(dir, '.gitignore'), '.env.local\n');
  fixtureGit(['add', '-A'], dir, { env: GIT_ENV });
  fixtureGit(['commit', '-q', '-m', 'release 1.0.0'], dir, { env: GIT_ENV });
  fixtureGit(['remote', 'add', 'origin', origin], dir, { env: GIT_ENV });
  fixtureGit(['push', '-q', 'origin', 'main'], dir, { env: GIT_ENV });
  const hook = join(hooks, 'pre-push');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marks}/prepush'\nsleep 2\n`);
  chmodSync(hook, 0o755);
  fixtureGit(['config', 'core.hooksPath', hooks], dir, { env: GIT_ENV });
  writeFileSync(join(dir, '.env.local'), 'NPM_TOKEN=fixture-not-a-token\n');
  const tarball = join(root, 'session-orchestrator-1.0.0.tgz');
  writeFileSync(tarball, 'fixture archive bytes\n');
  return { dir, origin, marks, tarball };
}

function startHarness({ dir, marks, tarball }, extraEnv = {}) {
  const env = { ...process.env, ...GIT_ENV, FIX_MODULE: RELEASE_MODULE, FIX_REPO: dir, FIX_MARKS: marks, FIX_TARBALL: tarball, ...extraEnv };
  child = spawn(process.execPath, ['--input-type=module', '-e', HARNESS], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', () => {});
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal, stderr })));
  return { proc: child, exited };
}

async function waitForFile(path, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const remoteTag = (origin) => fixtureGit(['ls-remote', origin, 'refs/tags/v1.0.0'], undefined, { env: GIT_ENV }).trim();

describe.skipIf(process.platform === 'win32')('release publish tail under a process-group SIGTERM', () => {
  it('T1: a SIGTERM during the git push lets the tail finish — tag on origin, live check ran', { timeout: 25_000 }, async () => {
    const fx = fixture();
    const { proc, exited } = startHarness(fx);
    await waitForFile(join(fx.marks, 'prepush'));
    process.kill(-proc.pid, 'SIGTERM');
    const { code, signal, stderr } = await exited;

    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(remoteTag(fx.origin)).toMatch(/^[0-9a-f]{40}\trefs\/tags\/v1\.0\.0$/);
    expect(existsSync(join(fx.marks, 'live'))).toBe(true);
    expect(stderr).toContain('publish tail running for session-orchestrator@1.0.0 (npm accepted it)');
    expect(stderr).toMatch(/deferred SIGTERM at \d{4}-\d\d-\d\dT[^;]+; the tail ran to its end/);
  });

  it('T2: a SIGTERM before the receipt still aborts — no proof, no tag', { timeout: 25_000 }, async () => {
    const fx = fixture();
    const { proc, exited } = startHarness(fx, { FIX_BLOCK_BEFORE_SETTLE: '1' });
    await waitForFile(join(fx.marks, 'ready'));
    process.kill(-proc.pid, 'SIGTERM');
    const { code, signal } = await exited;

    expect({ code, signal }).toEqual({ code: null, signal: 'SIGTERM' });
    expect(existsSync(join(fx.dir, '.orchestrator', 'runtime', 'release-1.0.0.json'))).toBe(false);
    expect(remoteTag(fx.origin)).toBe('');
  });

  it('T3: the production publish() arms the shield on a confirmed receipt', { timeout: 25_000 }, async () => {
    const fx = fixture();
    const { proc, exited } = startHarness(fx, { FIX_VIA: 'publish' });
    await waitForFile(join(fx.marks, 'prepush'));
    process.kill(-proc.pid, 'SIGTERM');
    const { code, signal, stderr } = await exited;

    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(remoteTag(fx.origin)).toMatch(/^[0-9a-f]{40}\trefs\/tags\/v1\.0\.0$/);
    expect(existsSync(join(fx.marks, 'live'))).toBe(true);
    expect(stderr).toContain('publish tail running for session-orchestrator@1.0.0 (npm accepted it)');
  });
});
