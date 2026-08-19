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
 *      working copy (via CLAUDE_PROJECT_DIR, which resolveProjectDir() checks
 *      BEFORE walking up from cwd) — green while proving nothing
 *   6. the not-a-git-repo fallback degrades SILENTLY — a gate that proves nothing
 *      and says nothing
 *   7. the root-env scrub covers only the platforms someone happened to type out.
 *      It covered SIX of the NINE names the two resolvers read: CURSOR_PROJECT_DIR,
 *      the bare native PLUGIN_ROOT (rung ONE of resolvePluginRoot, outranking every
 *      name that WAS scrubbed) and CURSOR_RULES_DIR all survived. The census for
 *      that test is DERIVED FROM the resolver sources, so a tenth name added to
 *      platform.mjs is covered without anyone editing this file — and a name with
 *      a suffix the hook's sweep does not match goes RED here.
 *   8. the git-env scrub names one handle of a two-handle channel — it removed
 *      GIT_CONFIG_PARAMETERS but not the enumerated GIT_CONFIG_COUNT / KEY_n /
 *      VALUE_n, which injects `core.hooksPath` into the materialised clone just
 *      as effectively.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The keep-set is imported, not restated: tests/setup/scrub-git-env.mjs and this
// hook share one justification for which GIT_ names may survive a sweep, and a
// second copy here would let the two drift apart unnoticed.
import { GIT_ENV_KEEP } from '../setup/scrub-git-env.mjs';

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
  gitDir: process.env.GIT_DIR ?? null,
  gitIndexFile: process.env.GIT_INDEX_FILE ?? null,
  gitWorkTree: process.env.GIT_WORK_TREE ?? null,
  gitConfigParameters: process.env.GIT_CONFIG_PARAMETERS ?? null,
  // Every name the gate child could still see that points at a project root, a
  // plugin root, or a git repository. Reported generically so a test can assert
  // over a census DERIVED FROM SOURCE rather than over a list typed out here —
  // a list here would drift exactly the way the hook's own list did.
  survivors: Object.keys(process.env)
    .filter((k) => /(?:PROJECT_DIR|PLUGIN_ROOT|RULES_DIR)$/.test(k) || k.startsWith('GIT_'))
    .sort(),
}));
process.exit(Number(process.env.PROBE_EXIT ?? '0'));
`;

/**
 * The env vars the project-root / plugin-root resolvers actually read, DERIVED
 * from their two source files instead of listed here.
 *
 * Why derived: the hook's own hand-written list is what this fixes. It named six
 * of these nine, and the three it missed are the ones no reviewer would have
 * spotted from the list alone — `CURSOR_PROJECT_DIR` (the fourth platform in
 * resolveProjectDir's chain), the bare `PLUGIN_ROOT` (rung ONE of
 * resolvePluginRoot, above every name the list did cover), and `CURSOR_RULES_DIR`
 * (the Cursor plugin root is not called CURSOR_PLUGIN_ROOT, so extending the list
 * by the guessed name would have read as a fix and closed nothing). A second
 * hand-written copy here would drift the same way and, being a test, would drift
 * silently green.
 *
 * Both read shapes are covered, and both are load-bearing: `process.env.NAME`
 * (platform.mjs, four inline ifs) and the string-literal indirection
 * (plugin-root.mjs, whose COMPATIBILITY_ROOTS table and `_envDirectory('PLUGIN_ROOT')`
 * call are read via `process.env[envName]` — a `process.env\.` grep sees NONE of
 * those five and undercounts by more than half, which is `.claude/rules/parallel-sessions.md`
 * PSA-006's payload-vs-channel census trap in miniature).
 *
 * NON_LOCATION is an exclusion list, deliberately: every OTHER env read in those
 * files enters the census by default, so a newly added read goes RED until
 * someone either scrubs it in the hook or excludes it here with a reason.
 *
 * CEILING (BV-004): the hook sweeps by SUFFIX, so a location var with a novel
 * suffix (a hypothetical `FOO_WORKSPACE`) is caught by this census but NOT by the
 * sweep — which is the point; the test goes red and names it. Revisit trigger:
 * the first resolver env var that is neither a PROJECT_DIR, a PLUGIN_ROOT nor a
 * RULES_DIR.
 */
const RESOLVER_SOURCES = ['scripts/lib/platform.mjs', 'scripts/lib/plugin-root.mjs'];
const NON_LOCATION = new Set([
  // Reorders the compatibility roots; names no path. With every root swept it is
  // inert, and scrubbing it would change which platform the gate believes it is
  // running on — a behaviour change with no safety gain.
  'SO_PLATFORM',
  // A WSL presence flag (SO_IS_WSL), not a location.
  'WSL_DISTRO_NAME',
]);

const ROOT_ENV_CENSUS = (() => {
  const names = new Set();
  for (const rel of RESOLVER_SOURCES) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/'([A-Z][A-Z0-9_]*)'/g)) names.add(m[1]);
  }
  for (const excluded of NON_LOCATION) names.delete(excluded);
  return [...names].sort();
})();

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

  it('reads TRACKED file content and clears EVERY root env var the resolvers read', { timeout: 60_000 }, () => {
    // bug_caught: #5 and #7 in one run. Starting the gate in a temp tree is not
    // enough: platform.mjs resolveProjectDir() and plugin-root.mjs
    // resolvePluginRoot() consult these names BEFORE walking up from cwd, and
    // Claude Code sets CLAUDE_PROJECT_DIR to the real repo. Left set, the gate
    // resolves its files back to the working copy.
    //
    // The census is DERIVED (see ROOT_ENV_CENSUS), not typed out, because the
    // typed-out version is the defect: the hook scrubbed six of these nine names
    // and the three it missed were not guessable. All of them are set here, so
    // one run answers the whole population. `probe.survivors` reports what the
    // gate child could still see, so the assertion is on the child's environment
    // rather than on the hook's text.
    //
    // Here the SAME path holds different bytes in each tree, so "which tree did
    // the gate read" has a single unambiguous answer.
    const { dir, sha } = makeRepo({
      tracked: { 'probe.txt': 'TRACKED\n' },
      worktree: { 'probe.txt': 'WORKTREE\n' },
    });

    const env = {};
    for (const name of ROOT_ENV_CENSUS) env[name] = dir;

    const { res, probe } = runHook({ cwd: dir, stdin: contentLine(sha), probeExit: 0, env });

    // The population is real: a census regex that silently matched nothing would
    // make every assertion below vacuous.
    expect(ROOT_ENV_CENSUS.length).toBeGreaterThanOrEqual(9);
    expect(ROOT_ENV_CENSUS).toContain('CLAUDE_PROJECT_DIR'); // the one that was covered
    expect(ROOT_ENV_CENSUS).toContain('CURSOR_PROJECT_DIR'); // the fourth platform
    expect(ROOT_ENV_CENSUS).toContain('PLUGIN_ROOT'); // bare native, rung one
    expect(ROOT_ENV_CENSUS).toContain('CURSOR_RULES_DIR'); // not "CURSOR_PLUGIN_ROOT"

    expect(probe.survivors.filter((k) => ROOT_ENV_CENSUS.includes(k))).toEqual([]);
    expect(probe.claudeProjectDir).toBeNull();
    expect(probe.claudePluginRoot).toBeNull();

    expect(probe.probeTxt).toBe('TRACKED');
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

  it('does not operate on the ORIGINAL repo when git sets GIT_DIR', { timeout: 60_000 }, () => {
    // bug_caught: git runs EVERY hook with GIT_DIR set, and GIT_DIR outranks both
    // `-C <path>` and cwd. So the materialisation's own `git -C "$tree" checkout
    // --detach` operated on the ORIGINAL repository instead of the clone, and the
    // gate's suite — which creates throwaway git repos — committed into it.
    // Observed live on this hook's second real run: the working copy's HEAD went
    // detached and three fixture commits landed in the real .git. Recovery was
    // metadata-only, but the class is data-loss, not inconvenience.
    //
    // This test is the A/B that the fix rests on. Without the scrub the assertions
    // below flip: `probe.gitDir` carries the path, and `symbolic-ref HEAD` fails
    // because the fixture is detached.
    const { dir, sha } = makeRepo({ tracked: { 'probe.txt': 'TRACKED\n' } });
    const branchBefore = execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    const { res, probe } = runHook({
      cwd: dir,
      stdin: contentLine(sha),
      probeExit: 0,
      env: {
        GIT_DIR: join(dir, '.git'),
        GIT_INDEX_FILE: '.git/index',
        GIT_CONFIG_PARAMETERS: "'core.hooksPath'='.husky'",
        // bug_caught: #8 — the ENUMERATED form of the same command-line config
        // channel. It is independent of GIT_CONFIG_PARAMETERS (neither gates the
        // other), so a scrub that named only the latter injected `core.hooksPath`
        // into the materialised clone through this one instead. Measured
        // 2026-08-19 in a throwaway /tmp repo: with these three set a `git commit`
        // fired a foreign hook; without them it did not.
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: join(dir, '.husky-foreign'),
      },
    });

    // 1. The gate child no longer inherits git's repo pointers.
    expect(probe.gitDir).toBeNull();
    expect(probe.gitIndexFile).toBeNull();
    expect(probe.gitWorkTree).toBeNull();
    // GIT_CONFIG_PARAMETERS is the one that measurably broke this hook: it carried
    // `core.hooksPath=.husky` into the clone, where .husky/ exists, so every
    // throwaway git repo the gate's suite creates fired the repository's real
    // pre-commit hooks. Three pushes reported `test: fail, total: 0` because of it.
    expect(probe.gitConfigParameters).toBeNull();
    // …and every other GIT_ channel, asserted as a set rather than name by name:
    // the keep-set (identity, GIT_EDITOR, transport) is the only thing that may
    // survive, because it answers WHO/HOW and never WHICH repository.
    expect(probe.survivors.filter((k) => k.startsWith('GIT_') && !GIT_ENV_KEEP.includes(k))).toEqual(
      [],
    );

    // 2. It still ran in the materialised tree and read TRACKED bytes there.
    expect(probe.cwd).not.toBe(dir);
    expect(probe.probeTxt).toBe('TRACKED');

    // 3. And the ORIGINAL repo is untouched — still on its branch, same commit.
    //    `symbolic-ref` throws on a detached HEAD, which is precisely the damage.
    expect(
      execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe(branchBefore);
    expect(execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(
      sha,
    );
    expect(res.status).toBe(0);
  });
});
