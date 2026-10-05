/**
 * tests/skills/session-end/github-mirror-push.test.mjs
 *
 * Bug class this locks in (TV-001): session-end Phase 4.4 used to mirror to
 * GitHub with
 *
 *     git remote get-url github 2>/dev/null && git push github HEAD 2>/dev/null \
 *       || echo "GitHub mirror: not configured"
 *
 * which collapsed THREE states into two indistinguishable outcomes: a push that
 * FAILED (unreachable remote, revoked token, protected branch) printed the exact
 * same `GitHub mirror: not configured` and exited 0 as a repo that simply has no
 * `github` remote. git's real error went to /dev/null. A stale mirror was
 * therefore structurally invisible — and once anything is wired to the mirror
 * (a Vercel Git deploy off the GitHub side), a silent push failure means the
 * published artifact never updates and nobody is told.
 * `.claude/rules/bash-harness-pitfalls.md`: "Silence is not success."
 *
 * These tests execute the REAL block extracted from the SKILL.md between the
 * `github-mirror-push:begin/end` markers — no copy of the command lives here
 * that could drift from the doc the coordinator actually runs.
 *
 * Named bugs covered:
 *   1. a FAILED push reports success/no-op    → mirror silently stale (the defect)
 *   2. failure output == missing-remote output → the two states stay conflated
 *   3. git's error text is swallowed           → operator cannot diagnose the failure
 *   4. missing remote treated as an error      → consumer repos get a false alarm
 *   5. success path does not name the SHA      → no evidence WHAT was mirrored
 *   6. block rewritten with bash-5-only syntax → breaks under macOS /bin/sh 3.2
 *   7. `mirror: none` ignored                  → opted-out repo pushes anyway (#1034)
 *   8. absent `mirror` key treated as none     → every keyless repo silently stops mirroring
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureGit, makeTmpDir, removeTree } from '../../_helpers/tmp-fixture.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SKILL_PATH = join(REPO_ROOT, 'skills', 'session-end', 'SKILL.md');

const BEGIN = '# --- github-mirror-push:begin ---';
const END = '# --- github-mirror-push:end ---';

/** Extract the real Phase 4.4 block from the SKILL.md (no duplicated command here). */
function extractMirrorBlock() {
  const body = readFileSync(SKILL_PATH, 'utf8');
  const start = body.indexOf(BEGIN);
  const end = body.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error('github-mirror-push markers missing from skills/session-end/SKILL.md');
  }
  return body.slice(start, end + END.length);
}

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      removeTree(tmpDirs.pop());
    } catch {
      // best-effort cleanup
    }
  }
});

/** Isolate git from host config, credential helpers and interactive prompts. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/true',
};

function git(cwd, args) {
  return fixtureGit(['-C', cwd, ...args], undefined, { env: GIT_ENV, encoding: 'utf8' });
}

/**
 * Throwaway repo with one commit and a CLAUDE.md Session Config.
 * @param {string|null} githubRemote URL for the `github` remote, or null for none.
 * @param {string|null} [mirrorKey] value of the `mirror:` key, or null to omit the key.
 */
function makeRepo(githubRemote, mirrorKey = null) {
  const root = makeTmpDir('so-mirror-');
  tmpDirs.push(root);
  const dir = join(root, 'work');
  fixtureGit(['init', '-q', dir], undefined, { env: GIT_ENV });
  git(dir, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  if (githubRemote) git(dir, ['remote', 'add', 'github', githubRemote]);
  const mirrorLine = mirrorKey === null ? '' : `mirror: ${mirrorKey}\n`;
  writeFileSync(join(dir, 'CLAUDE.md'), `# fixture\n\n## Session Config\n\nvcs: gitlab\n${mirrorLine}`);
  return { root, dir };
}

/** Every variable the block may resolve the plugin root from — stripped so the host's own session cannot leak in. */
const ROOT_VARS = ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT'];

/**
 * Run the extracted block in `dir`, capturing stdout and stderr SEPARATELY.
 * @param {string} dir
 * @param {{ pluginRoot?: string|null }} [opts] `null` = no root variable at all (fresh shell).
 */
function runBlock(dir, { pluginRoot = REPO_ROOT } = {}) {
  const env = { ...GIT_ENV };
  for (const k of ROOT_VARS) delete env[k];
  if (pluginRoot !== null) env.PLUGIN_ROOT = pluginRoot;
  const res = spawnSync('bash', ['-c', extractMirrorBlock()], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('session-end Phase 4.4 GitHub mirror push — the four states are distinguishable', () => {
  it('State 3 (remote configured, push FAILS): exits non-zero and never claims "not configured"', () => {
    const { dir } = makeRepo(join(root_unreachable(), 'does-not-exist.git'));
    const res = runBlock(dir);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('PUSH FAILED');
    // The defect verbatim: a broken push must NOT be reported as an absent remote.
    expect(res.stdout).not.toContain('not configured');
    expect(res.stderr).not.toContain("no 'github' remote configured");
  });

  it("State 3 surfaces git's REAL error text instead of discarding it to /dev/null", () => {
    const { dir } = makeRepo(join(root_unreachable(), 'does-not-exist.git'));
    const res = runBlock(dir);

    expect(res.stderr).toContain('does not appear to be a git repository');
    expect(res.stderr).toContain('Could not read from remote repository');
  });

  it('State 1 (no github remote): exits 0 and says so — a legitimate consumer-repo state', () => {
    const { dir } = makeRepo(null);
    const res = runBlock(dir);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("no 'github' remote configured");
    expect(res.stdout).not.toContain('PUSH FAILED');
  });

  it('State 2 (push succeeds): exits 0, names the pushed SHA, and the remote really has it', () => {
    const bareRoot = makeTmpDir('so-mirror-bare-');
    tmpDirs.push(bareRoot);
    const bare = join(bareRoot, 'bare.git');
    fixtureGit(['init', '-q', '--bare', bare], undefined, { env: GIT_ENV });

    const { dir } = makeRepo(bare);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    const res = runBlock(dir);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain(head);
    expect(res.stdout).toContain(bare);
    // Substance, not prose: the mirror actually received this commit.
    expect(git(dir, ['ls-remote', 'github', 'HEAD']).trim()).toContain(head);
  });

  it('the failure verdict and the missing-remote verdict are NOT the same output (the collapse)', () => {
    const failed = runBlock(makeRepo(join(root_unreachable(), 'does-not-exist.git')).dir);
    const absent = runBlock(makeRepo(null).dir);

    expect(failed.code).not.toBe(absent.code);
    expect(failed.stdout + failed.stderr).not.toBe(absent.stdout + absent.stderr);
  });

  it('the block parses under BOTH bash 5 and macOS /bin/sh (bash 3.2)', () => {
    const block = extractMirrorBlock();
    for (const shell of ['bash', 'sh']) {
      const res = spawnSync(shell, ['-n'], { input: block, encoding: 'utf8' });
      expect({ shell, status: res.status, stderr: res.stderr }).toEqual({
        shell,
        status: 0,
        stderr: '',
      });
    }
  });
});

/** A directory that exists but holds no git repository — a reachable path, unreachable remote. */
function root_unreachable() {
  const d = makeTmpDir('so-mirror-void-');
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// State 0 — not a git repository at all.
//
// This state was MISSED in the first version of the fix and was found by an
// adversarial reviewer, not by the author. Outside a repository,
// `git remote get-url github` fails with "fatal: not a git repository", which
// by exit code alone is indistinguishable from "no such remote". The block
// therefore announced "no 'github' remote configured — skipping (not an
// error)" and exited 0: a broken environment reported as a healthy one, in the
// very fix written to close a fail-open.
//
// The bug this test catches: a future edit that drops the `git rev-parse
// --git-dir` probe and restores the collapse. Nothing else would notice —
// the three tests above all run INSIDE a repository and stay green.
// ---------------------------------------------------------------------------

describe('state 0 — not a git repository', () => {
  it('fails closed and says why, instead of claiming no mirror is configured', () => {
    const root = makeTmpDir('so-mirror-norepo-');
    tmpDirs.push(root);
    const res = runBlock(root);

    expect(res.status, 'must not exit 0 — a broken environment is not a healthy one').not.toBe(0);
    expect(res.stderr).toMatch(/not a git repository/i);
    // The precise regression: the old wording must NOT appear. It is the
    // sentence that made a missing repository look like a deliberate opt-out.
    expect(res.stdout).not.toMatch(/no 'github' remote configured/);
    expect(res.stdout).not.toMatch(/not an error/);
  });
});

// ---------------------------------------------------------------------------
// The Session Config `mirror` key (#1034). The block's comment used to claim
// "Only attempt if 'mirror: github' is in Session Config" while the code only
// asked git for a 'github' remote — a repo with `mirror: none` and a github
// remote pushed anyway. The opposite mistake is just as quiet: reading an
// ABSENT key as `none` would stop every keyless repo (this one included) from
// mirroring without a word.
// ---------------------------------------------------------------------------

describe('Session Config mirror key', () => {
  function bareRemote() {
    const bareRoot = makeTmpDir('so-mirror-bare-');
    tmpDirs.push(bareRoot);
    const bare = join(bareRoot, 'bare.git');
    fixtureGit(['init', '-q', '--bare', bare], undefined, { env: GIT_ENV });
    return bare;
  }

  it('`mirror: none` with a reachable github remote does NOT push', () => {
    const bare = bareRemote();
    const { dir } = makeRepo(bare, 'none');
    const res = runBlock(dir);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("'mirror: none'");
    expect(git(dir, ['ls-remote', 'github']).trim()).toBe('');
  });

  it('an absent mirror key keeps the remote-based push (no silent behaviour change)', () => {
    const bare = bareRemote();
    const { dir } = makeRepo(bare, null);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    const res = runBlock(dir);

    expect(res.code).toBe(0);
    expect(git(dir, ['ls-remote', 'github', 'HEAD']).trim()).toContain(head);
  });

  it('an unknown mirror value fails loud and pushes nothing', () => {
    const bare = bareRemote();
    const { dir } = makeRepo(bare, 'gitlab');
    const res = runBlock(dir);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("unknown 'mirror: gitlab'");
    expect(git(dir, ['ls-remote', 'github']).trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Plugin root absent in the shell (review of 5907b22c). `/close` runs this block
// in a fresh Bash shell where PLUGIN_ROOT is often unset. The first version
// aborted on `${PLUGIN_ROOT:?}` — exit 1, nothing pushed, and the message blamed
// an unreadable Session Config. The Vercel deploy hangs off this push.
// ---------------------------------------------------------------------------

describe('plugin root not exported in the shell', () => {
  function bareRemote() {
    const bareRoot = makeTmpDir('so-mirror-bare-');
    tmpDirs.push(bareRoot);
    const bare = join(bareRoot, 'bare.git');
    fixtureGit(['init', '-q', '--bare', bare], undefined, { env: GIT_ENV });
    return bare;
  }

  it('falls back to the repo toplevel when it carries scripts/parse-config.mjs, and pushes', () => {
    const bare = bareRemote();
    const { dir } = makeRepo(bare, null);
    // The session runs inside the plugin repo itself: toplevel holds parse-config.mjs.
    mkdirSync(join(dir, 'scripts'));
    const real = pathToFileURL(join(REPO_ROOT, 'scripts', 'parse-config.mjs')).href;
    writeFileSync(join(dir, 'scripts', 'parse-config.mjs'), `await import(${JSON.stringify(real)});\n`);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();

    const res = runBlock(dir, { pluginRoot: null });

    expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: '' });
    expect(git(dir, ['ls-remote', 'github', 'HEAD']).trim()).toContain(head);
  });

  it('no github remote and no Session Config: skips with exit 0 before any root lookup', () => {
    const root = makeTmpDir('so-mirror-bare-repo-');
    tmpDirs.push(root);
    const dir = join(root, 'work');
    fixtureGit(['init', '-q', dir], undefined, { env: GIT_ENV });

    const res = runBlock(dir, { pluginRoot: null });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("no 'github' remote configured");
  });

  it('root unresolvable with a github remote: names the real cause, not the Session Config', () => {
    const bare = bareRemote();
    const { dir } = makeRepo(bare, null);

    const res = runBlock(dir, { pluginRoot: null });

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('plugin root not resolvable');
    expect(res.stderr).not.toContain('Session Config unreadable');
    expect(git(dir, ['ls-remote', 'github']).trim()).toBe('');
  });
});
