/**
 * tests/husky/pre-push-tracked-tree.test.mjs
 *
 * Tests for the tracked-tree rebuild of .husky/pre-push.
 *
 * The bug class (TV-001): the hook used to run the full gate against the WORKING
 * tree while CI runs it against the TRACKED tree. Everything that exists locally
 * but is not committed — an untracked module a test imports, a gitignored data
 * file a test reads — is present for the local gate and absent for CI, so the
 * local gate reports green on a tree CI cannot build. That divergence is live in
 * this repo today: at 6f6bf58 the local suite is green while pipeline #7288
 * `test 1/2` fails on `tests/scripts/site-numbers.test.mjs` reading the
 * gitignored `.orchestrator/metrics/*.jsonl`.
 *
 * The rebuilt hook materialises the sha being pushed with `git clone
 * --no-hardlinks` into a temp dir and runs the gate THERE. These tests drive the
 * REAL hook file against tmp git repos whose `quality-gate` npm script is a
 * committed probe: it records what the gate could see (cwd, file presence, file
 * CONTENT, the repo-root env vars) into an out-of-tree JSON file and exits with a
 * controllable code. Behaviour is measured, never inferred from the hook text.
 *
 * Complements tests/husky/pre-push-gate.test.mjs rather than duplicating it: that
 * file drives the hook from NON-git tmp dirs, which now exercise the working-tree
 * FALLBACK path. Every test here runs inside a real git repo, which is the only
 * place the materialisation path is reachable at all.
 *
 * Named bugs covered:
 *   1. the rebuild does nothing — an untracked file is still visible to the gate,
 *      i.e. the whole tracked/working divergence survives the rewrite
 *   2. delete-only push pays for a clone (or worse, runs the gate) — latency with
 *      no signal, which is what breeds reflex `--no-verify`
 *   3. SKIP_QUALITY_GATE stops working, stops announcing itself, or starts
 *      materialising before it bails — a silent bypass is worse than none
 *   4. the ~1600-file temp tree survives a FAILING gate — disk garbage per push
 *   5. the gate starts in the temp tree but resolves its files back to the
 *      working copy (via CLAUDE_PROJECT_DIR, which findProjectRoot() checks
 *      BEFORE walking up from cwd) — green while proving nothing
 *   6. the not-a-git-repo fallback degrades SILENTLY — a gate that proves nothing
 *      and says nothing
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK_PATH = join(REPO_ROOT, '.husky', 'pre-push');

const ZERO_SHA = '0'.repeat(40);

/**
 * The committed `quality-gate` npm script of every fixture repo. It reports what
 * the gate could actually SEE from wherever the hook started it, then exits with
 * PROBE_EXIT. Written to an absolute PROBE_OUT outside the fixture so it survives
 * the hook's temp-tree cleanup.
 */
const PROBE_SRC = `import { writeFileSync, existsSync, readFileSync } from 'node:fs';
writeFileSync(process.env.PROBE_OUT, JSON.stringify({
  cwd: process.cwd(),
  helperPresent: existsSync('helper.mjs'),
  probeTxt: existsSync('probe.txt') ? readFileSync('probe.txt', 'utf8').trim() : null,
  claudeProjectDir: process.env.CLAUDE_PROJECT_DIR ?? null,
  claudePluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null,
}));
process.exit(Number(process.env.PROBE_EXIT ?? '0'));
`;

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

function mkTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  // macOS $TMPDIR is /var/... which is a symlink to /private/var/..., so a child
  // process reports the resolved form. Comparing unresolved paths would make
  // every "did it run here?" assertion accidentally false.
  return realpathSync(dir);
}

/**
 * A fixture git repo with a committed probe gate.
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.tracked]  extra files committed into HEAD
 * @param {Record<string,string>} [opts.worktree] files written AFTER the commit —
 *   untracked, or tracked-but-modified when the path is also in `tracked`
 * @returns {{ dir: string, sha: string }}
 */
function makeRepo({ tracked = {}, worktree = {} } = {}) {
  const dir = mkTmp('so-pre-push-tracked-');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);

  // The hook only probes this path's EXISTENCE before deciding to run at all.
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'run-quality-gate.mjs'), '// stub\n');
  writeFileSync(join(dir, 'probe.mjs'), PROBE_SRC);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'pre-push-tracked-fixture',
      version: '0.0.0',
      private: true,
      scripts: { 'quality-gate': 'node probe.mjs' },
    }),
  );
  for (const [rel, body] of Object.entries(tracked)) writeFileSync(join(dir, rel), body);

  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture']);
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  for (const [rel, body] of Object.entries(worktree)) writeFileSync(join(dir, rel), body);
  return { dir, sha };
}

/**
 * Run the real hook against `cwd` and return its result plus whatever the probe
 * gate recorded (null when the gate never ran).
 */
function runHook({ cwd, stdin, probeExit = 0, env = {}, hookPath = HOOK_PATH }) {
  const probeOut = join(mkTmp('so-pre-push-probe-'), 'probe.json');
  const childEnv = { ...process.env };
  delete childEnv.SKIP_QUALITY_GATE;
  Object.assign(childEnv, { PROBE_OUT: probeOut, PROBE_EXIT: String(probeExit) }, env);

  const res = spawnSync('sh', [hookPath], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv,
  });
  const probe = existsSync(probeOut) ? JSON.parse(readFileSync(probeOut, 'utf8')) : null;
  return { res, probe };
}

const contentLine = (sha) => `refs/heads/main ${sha} refs/heads/main ${ZERO_SHA}\n`;
const deleteLine = `refs/heads/old ${ZERO_SHA} refs/heads/old ${'b'.repeat(40)}\n`;

describe('.husky/pre-push — gates the TRACKED tree, not the working tree', () => {
  it('BLOCKS when a test dependency exists in the working tree but is UNTRACKED', { timeout: 60_000 }, () => {
    // bug_caught: #1 — the only test that proves the rebuild changed anything.
    // helper.mjs is on disk but never committed, so it is present for a
    // working-tree gate and absent for CI. The probe fails exactly as a test
    // importing it would; the hook must block.
    const { dir, sha } = makeRepo({ worktree: { 'helper.mjs': 'export const x = 1;\n' } });
    expect(existsSync(join(dir, 'helper.mjs'))).toBe(true);
    expect(
      execFileSync('git', ['-C', dir, 'status', '--short'], { encoding: 'utf8' }),
    ).toContain('?? helper.mjs');

    const { res, probe } = runHook({ cwd: dir, stdin: contentLine(sha), probeExit: 2 });

    expect(probe).not.toBeNull();
    expect(probe.helperPresent).toBe(false); // the gate could not see the untracked file
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Push blocked');
  });

  it('reads TRACKED file content and clears the repo-root env vars', { timeout: 60_000 }, () => {
    // bug_caught: #5 — the quiet way this rebuild goes useless. Starting the gate
    // in a temp tree is not enough: scripts/lib/common.mjs findProjectRoot() and
    // resolvePluginRoot() consult CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT BEFORE
    // walking up from cwd, and Claude Code sets CLAUDE_PROJECT_DIR to the real
    // repo. Left set, the gate resolves its files back to the working copy.
    // Here the SAME path holds different bytes in each tree, so "which tree did
    // the gate read" has a single unambiguous answer.
    const { dir, sha } = makeRepo({
      tracked: { 'probe.txt': 'TRACKED\n' },
      worktree: { 'probe.txt': 'WORKTREE\n' },
    });

    const { res, probe } = runHook({
      cwd: dir,
      stdin: contentLine(sha),
      probeExit: 0,
      env: { CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: dir },
    });

    expect(probe.probeTxt).toBe('TRACKED');
    expect(probe.claudeProjectDir).toBeNull();
    expect(probe.claudePluginRoot).toBeNull();
    expect(probe.cwd.startsWith(dir)).toBe(false); // ran outside the working copy
    expect(res.status).toBe(0); // and a passing gate still lets the push through
  });

  it('removes the materialised tree even when the gate FAILS', { timeout: 60_000 }, () => {
    // bug_caught: #4 — cleanup wired to the happy path leaves ~1600 files per
    // failed push. The probe reports the directory it ran in, so this asserts on
    // the real path the hook created rather than on a guess.
    const { dir, sha } = makeRepo();
    const { res, probe } = runHook({ cwd: dir, stdin: contentLine(sha), probeExit: 2 });

    expect(res.status).toBe(1);
    expect(probe.cwd).toMatch(/tree$/);
    expect(existsSync(probe.cwd)).toBe(false);
    expect(existsSync(resolve(probe.cwd, '..'))).toBe(false); // the mktemp parent too
  });

  it('skips a delete-only push BEFORE materialising anything', { timeout: 60_000 }, () => {
    // bug_caught: #2 — pre-push-gate.test.mjs already pins that the gate does not
    // RUN on a delete-only push, but it drives the hook from a non-git dir where
    // materialisation is unreachable. This pins the new ordering: inside a real
    // repo, the delete-only shortcut must come before the clone, not after it.
    const { dir } = makeRepo();
    const { res, probe } = runHook({ cwd: dir, stdin: deleteLine, probeExit: 2 });

    expect(probe).toBeNull();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('delete-only push');
    expect(res.stderr).not.toContain('materialised');
  });

  it('SKIP_QUALITY_GATE bails before materialising — and says so', { timeout: 60_000 }, () => {
    // bug_caught: #3 — same ordering argument as above, plus the loudness the
    // bypass depends on: it is the pressure valve that keeps operators off
    // `git push --no-verify`, which disables EVERY hook including pre-commit's
    // leak and NUL guards.
    const { dir, sha } = makeRepo();
    const { res, probe } = runHook({
      cwd: dir,
      stdin: contentLine(sha),
      probeExit: 2,
      env: { SKIP_QUALITY_GATE: '1' },
    });

    expect(probe).toBeNull();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('BYPASSED');
    expect(res.stderr).not.toContain('materialised');
  });

  it('announces the working-tree fallback when there is no git work tree', { timeout: 60_000 }, () => {
    // bug_caught: #6 — the fallback is unreachable during a real push (git only
    // runs the hook from inside a work tree) and exists for hand-driven and
    // vendored invocations. If it ever degraded SILENTLY it would be the worst
    // shape available: a gate that proves nothing and reports nothing. The four
    // non-git cases in pre-push-gate.test.mjs all take this path, so this test is
    // what keeps that whole file from turning into a silent pass.
    const dir = mkTmp('so-pre-push-nogit-');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run-quality-gate.mjs'), '// stub\n');
    writeFileSync(join(dir, 'probe.mjs'), PROBE_SRC);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'pre-push-nogit-fixture',
        version: '0.0.0',
        private: true,
        scripts: { 'quality-gate': 'node probe.mjs' },
      }),
    );
    expect(
      spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).status,
    ).not.toBe(0);

    const { res, probe } = runHook({ cwd: dir, stdin: contentLine('a'.repeat(40)), probeExit: 0 });

    expect(res.stderr).toContain('gating the WORKING TREE');
    expect(probe.cwd).toBe(dir); // it really did run in place
    expect(res.status).toBe(0);
  });
});
