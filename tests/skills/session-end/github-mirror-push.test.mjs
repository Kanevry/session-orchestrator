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
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
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
  return execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' });
}

/**
 * Throwaway repo with one commit.
 * @param {string|null} githubRemote URL for the `github` remote, or null for none.
 */
function makeRepo(githubRemote) {
  const root = mkdtempSync(join(tmpdir(), 'so-mirror-'));
  tmpDirs.push(root);
  const dir = join(root, 'work');
  execFileSync('git', ['init', '-q', dir], { env: GIT_ENV });
  git(dir, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  if (githubRemote) git(dir, ['remote', 'add', 'github', githubRemote]);
  return { root, dir };
}

/** Run the extracted block in `dir`, capturing stdout and stderr SEPARATELY. */
function runBlock(dir) {
  const res = spawnSync('bash', ['-c', extractMirrorBlock()], {
    cwd: dir,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('session-end Phase 4.4 GitHub mirror push — the three states are distinguishable', () => {
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
    const bareRoot = mkdtempSync(join(tmpdir(), 'so-mirror-bare-'));
    tmpDirs.push(bareRoot);
    const bare = join(bareRoot, 'bare.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { env: GIT_ENV });

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
  const d = mkdtempSync(join(tmpdir(), 'so-mirror-void-'));
  tmpDirs.push(d);
  return d;
}
