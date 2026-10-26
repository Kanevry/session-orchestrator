/**
 * tests/husky/pre-push-gate.test.mjs
 *
 * Tests for the .husky/pre-push full-quality-gate hook (#932 / #940).
 *
 * Bug class this locks in (TV-001): the hook wires the ONLY blocking variant of
 * run-quality-gate.mjs (`full-gate`, exit 2 on failure) in front of every push.
 * The hook itself shipped untested — a fail-open regression in any of its four
 * paths would silently turn the gate back into the decoration it replaced.
 *
 * The tests execute the REAL hook file against tmp dirs whose package.json
 * `quality-gate` script is a controllable stub that records whether it ran.
 * The stub covers the hook's side of the seam (invokes the `quality-gate` npm
 * script, forwards its exit); a structural test covers the repo's side (the
 * real `quality-gate` script IS the blocking full-gate variant) — together the
 * chain is closed with no gap at the npm-script name.
 *
 * Named bugs covered:
 *   1. gate failure no longer blocks (hook exits 0 on gate exit != 0) → the
 *      exact fail-open shape the hook exists to remove
 *   2. happy path blocks (hook crashes / inverts on gate exit 0) → every push
 *      blocked, hook gets bypassed or deleted as noise
 *   3. delete-only push runs the ~2-min gate → pure latency with no signal,
 *      breeds reflex `--no-verify`
 *   4. a MIXED push (one deleted ref + one content ref) is misread as
 *      delete-only → deleting a branch alongside pushing broken code skips
 *      the gate
 *   5. SKIP_QUALITY_GATE bypass broken (gate still runs, or bypass is silent)
 *      → operators fall back to `--no-verify`, which disables EVERY hook
 *   6. missing gate script blocks the push → vendored-hook consumer repos
 *      (no scripts/run-quality-gate.mjs) can never push
 *   7. package.json `quality-gate` flipped to a non-blocking variant
 *      (incremental ends in an unconditional exit 0) → hook still "runs a
 *      gate" but can never block; behavioral tests 1-6 would stay green
 *   8. (#C10) SCRATCH push to an unconfigured raw URL (e.g. the remote-offload
 *      tool's SSH sync target) still runs the full ~74s gate — the hook never
 *      read $1/$2 before #C10, so gating was indiscriminate of push target.
 *      Proven red on the unmodified hook (quoted in the #C10 report): a push
 *      to `ssh://user@host/path` — not a configured remote — ran the gate and
 *      could block on it.
 *  10. (#1623, #1778) a commit lands on the pushed ref WHILE the gate runs → the
 *      hook warned and exited 0, and over smart HTTP(S) git sent the NEW, ungated
 *      tip (incident #1778: 042464b8 gated, 980777b3 reached GitLab). The hook
 *      must block (exit 1) on any moved ref.
 *  11. (#1778) a revision-EXPRESSION or bare-name source (`HEAD~0`, `feat/x`)
 *      was skipped by the re-check, so a moved ref passed; an unresolvable
 *      source passed too. Over HTTP(S) the expression is resolved again after
 *      the hook. A literal full sha must still pass (release pushes use them).
 *  12. (#1787) a push whose content refs name DIFFERENT commits gated only the
 *      first, warned, and printed "quality gate passed" for the rest. It must
 *      block before the gate. Refs that peel to ONE commit (branch + lightweight
 *      or annotated tag) must still pass, gated once.
 *   9. (#C10) a PUBLISH push — a configured remote NAME, or a URL-form push
 *      whose URL matches a configured remote (`git push https://github.com/...`)
 *      — is misread as scratch and skips the gate it needs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { join, resolve } from 'node:path';
import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';
import { posixShell } from '../_helpers/posix-shell.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK_PATH = join(REPO_ROOT, '.husky', 'pre-push');

const ZERO_SHA = '0'.repeat(40);
const CONTENT_SHA = 'a'.repeat(40);

/** One stdin line in git's pre-push format: <local_ref> <local_sha> <remote_ref> <remote_sha>. */
const contentLine = `refs/heads/feat/x ${CONTENT_SHA} refs/heads/feat/x ${ZERO_SHA}\n`;
const deleteLine = `refs/heads/old ${ZERO_SHA} refs/heads/old ${'b'.repeat(40)}\n`;

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

/**
 * The `quality-gate` npm script used by the `args`-driven (#C10) fixture repo
 * below. Writes an ABSOLUTE sentinel path from `GATE_RAN_FILE` rather than a
 * relative `touch gate-ran`: a non-scratch run executes this INSIDE the
 * hook's own cloned temp tree (`git clone --no-hardlinks`, deleted by the
 * hook's own cleanup trap before this function returns), so a relative
 * sentinel would never be observable from the fixture repo dir.
 */
const GATE_PROBE_SRC = [
  "import { writeFileSync } from 'node:fs';",
  "import { execFileSync } from 'node:child_process';",
  // #1623: simulate a commit made in the pushed worktree while the gate runs.
  // MOVE_DELETE instead deletes that ref during the gate (#1778 fail-closed row).
  "if (process.env.MOVE_REPO) execFileSync('git', ['-C', process.env.MOVE_REPO, '-c', 'core.hooksPath=/dev/null',",
  "  ...(process.env.MOVE_DELETE ? ['update-ref', '-d', process.env.MOVE_DELETE]",
  "    : ['commit', '-q', '--allow-empty', '-m', 'made during the gate'])]);",
  // The sentinel records ARGV, not just the fact of the run: the hook hands the
  // gate the real repo root as `--ledger-root <root>` (it runs inside a
  // throwaway clone whose own .orchestrator/ dies with the EXIT trap), and
  // nothing else in this suite can see that the flag was passed.
  "writeFileSync(process.env.GATE_RAN_FILE, JSON.stringify(process.argv.slice(2)));",
  // Exit code moved out of the npm script string and into the probe: `npm run
  // <s> -- <args>` APPENDS the forwarded args to the script command line, so a
  // trailing `&& exit 0` would receive them (`exit 0 --ledger-root …`).
  "process.exit(Number(process.env.GATE_EXIT || 0));",
  '',
].join('\n');

/**
 * Run the real hook in a tmp dir with a stubbed `quality-gate` npm script.
 * The stub writes a `gate-ran` sentinel (so tests can assert whether the gate
 * was invoked at all) and exits with the configured code.
 *
 * `args`, when given, is passed as argv after HOOK_PATH — git's own pre-push
 * invocation shape (`$1`=remote name-or-URL, `$2`=remote URL, #C10). The
 * scratch-vs-publish check that reads them needs REAL `git remote` state to
 * query, so an `args` run builds a real tmp git repo (remotes added via
 * `git remote add`, mirroring makeRepo() in pre-push-tracked-tree.test.mjs)
 * instead of the bare non-git tmp dir the argv-less path below uses. The
 * argv-less path is UNCHANGED — the bug class this locks in is a divergence
 * between the two.
 */
function runPrePush({
  stdin,
  gateExit = 0,
  env = {},
  withGateScript = true,
  args,
  remotes = {},
  moveDuringGate = false,
  setup,
} = {}) {
  if (args) {
    const dir = makeTmpDir('so-pre-push-remote-');
    tmpDirs.push(dir);
    const sentinelDir = makeTmpDir('so-pre-push-sentinel-');
    tmpDirs.push(sentinelDir);
    const gateRanFile = join(sentinelDir, 'gate-ran');

    fixtureGit(['init', '-q', dir]);
    // The default stdin names refs/heads/feat/x — make it the real checked-out
    // branch so the post-gate moved-ref re-check (#1623) sees an existing ref.
    fixtureGit(['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/feat/x']);
    fixtureGit(['-C', dir, 'config', 'user.email', 'test@example.com']);
    fixtureGit(['-C', dir, 'config', 'user.name', 'Test']);
    fixtureGit(['-C', dir, 'config', 'commit.gpgsign', 'false']);
    for (const [name, url] of Object.entries(remotes)) {
      fixtureGit(['-C', dir, 'remote', 'add', name, url]);
    }
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run-quality-gate.mjs'), '// stub\n');
    writeFileSync(join(dir, 'gate-probe.mjs'), GATE_PROBE_SRC);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'pre-push-remote-fixture',
        version: '0.0.0',
        private: true,
        scripts: { 'quality-gate': 'node gate-probe.mjs' },
      }),
    );
    fixtureGit(['-C', dir, 'add', '-A']);
    fixtureGit(['-C', dir, 'commit', '-q', '-m', 'fixture']);
    const sha = fixtureGit(['-C', dir, 'rev-parse', 'HEAD'], undefined, { encoding: 'utf8' }).trim();
    // `setup(dir, sha)` builds extra refs after the fixture commit; its return
    // value reaches a function-form `stdin` as the second argument (#1787).
    const extra = setup ? setup(dir, sha) : undefined;

    const childEnv = { ...process.env };
    delete childEnv.SKIP_QUALITY_GATE;
    Object.assign(childEnv, { GATE_RAN_FILE: gateRanFile, GATE_EXIT: String(gateExit) }, env);
    if (moveDuringGate) childEnv.MOVE_REPO = dir;
    const res = spawnSync(posixShell('sh'), ['-e', HOOK_PATH, ...args], {
      cwd: dir,
      // A function receives the fixture's commit sha (only known after the commit).
      input: typeof stdin === 'function' ? stdin(sha, extra) : (stdin ?? `refs/heads/feat/x ${sha} refs/heads/feat/x ${ZERO_SHA}\n`),
      encoding: 'utf8',
      timeout: 60_000,
      env: childEnv,
    });
    const gateRan = existsSync(gateRanFile);
    return {
      res,
      gateRan,
      dir,
      sha,
      gateArgv: gateRan ? JSON.parse(readFileSync(gateRanFile, 'utf8')) : null,
    };
  }

  const dir = makeTmpDir('so-pre-push-');
  tmpDirs.push(dir);
  if (withGateScript) {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    // The hook only probes existence of this file; the command it runs is the
    // npm script below.
    writeFileSync(join(dir, 'scripts', 'run-quality-gate.mjs'), '// stub\n');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'pre-push-fixture',
        version: '0.0.0',
        private: true,
        scripts: { 'quality-gate': `touch gate-ran && exit ${gateExit}` },
      }),
    );
  }
  const childEnv = { ...process.env };
  delete childEnv.SKIP_QUALITY_GATE;
  Object.assign(childEnv, env);
  // `sh -e` as husky 9 runs it (.husky/_/h): under plain `sh` a red gate's
  // `( … ); status=$?` survived and printed "Push blocked"; under -e it aborted
  // silently before the message — the suite stayed green on that bug (#1540).
  const res = spawnSync(posixShell('sh'), ['-e', HOOK_PATH], {
    cwd: dir,
    input: stdin,
    encoding: 'utf8',
    timeout: 30_000,
    env: childEnv,
  });
  return { res, gateRan: existsSync(join(dir, 'gate-ran')) };
}

describe('.husky/pre-push — full quality gate (#932)', () => {
  it('blocks the push (exit 1) when the quality gate fails', { timeout: 25_000 }, () => {
    // bug_caught: #1 — the fail-open shape. gate-incremental's unconditional
    // exit 0 is exactly one npm-script edit away; if the hook ever stops
    // forwarding a non-zero gate exit, a red gate pushes anyway.
    const { res, gateRan } = runPrePush({ stdin: contentLine, gateExit: 2 });

    expect(gateRan).toBe(true);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Push blocked');
  });

  it('allows the push (exit 0) when the quality gate passes', { timeout: 25_000 }, () => {
    // bug_caught: #2 — an inverted or crashing happy path blocks every push,
    // which gets the hook deleted or reflex-bypassed within days.
    const { res, gateRan } = runPrePush({ stdin: contentLine, gateExit: 0 });

    expect(gateRan).toBe(true);
    expect(res.status).toBe(0);
  });

  it('skips the gate on a delete-only push', { timeout: 25_000 }, () => {
    // bug_caught: #3 — a push that only deletes refs ships no code; running
    // the ~2-min full gate on it is pure latency that breeds `--no-verify`.
    const { res, gateRan } = runPrePush({ stdin: deleteLine, gateExit: 2 });

    expect(gateRan).toBe(false);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('delete-only push');
  });

  it('still runs (and blocks on) the gate for a MIXED delete + content push', { timeout: 25_000 }, () => {
    // bug_caught: #4 — if the stdin loop reads only one line, or lets a
    // zero-sha line overwrite the content flag, deleting a branch alongside
    // pushing broken code slips past the gate entirely.
    const { res, gateRan } = runPrePush({ stdin: deleteLine + contentLine, gateExit: 2 });

    expect(gateRan).toBe(true);
    expect(res.status).toBe(1);
  });

  it('SKIP_QUALITY_GATE bypasses without running the gate — but never silently', { timeout: 25_000 }, () => {
    // bug_caught: #5 — the named, greppable bypass is the pressure valve that
    // keeps operators off `git push --no-verify` (which disables EVERY hook,
    // including pre-commit's leak + NUL guards). If it stops working, or works
    // without announcing itself, both properties are lost.
    const { res, gateRan } = runPrePush({
      stdin: contentLine,
      gateExit: 2,
      env: { SKIP_QUALITY_GATE: '1' },
    });

    expect(gateRan).toBe(false);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('BYPASSED');
  });

  it('exits 0 without touching npm when scripts/run-quality-gate.mjs is absent', { timeout: 25_000 }, () => {
    // bug_caught: #6 — consumer repos that vendor the hook but not the gate
    // script would otherwise hit `npm run quality-gate` → missing-script
    // failure → every push blocked in a repo that never opted into the gate.
    const { res } = runPrePush({ stdin: contentLine, withGateScript: false });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('package.json wires `quality-gate` to the blocking full-gate variant', () => {
    // bug_caught: #7 — the behavioral tests above stub package.json, so they
    // cannot see the real repo flipping the npm script to `--variant
    // incremental`: gate-incremental.mjs ends in an unconditional
    // `process.exit(0)` (a REPORTING variant), and per run-quality-gate.mjs
    // only `full-gate` can exit 2. A hook wired to any other variant prints
    // failures and pushes anyway — decorative enforcement.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const script = pkg.scripts['quality-gate'];

    expect(script).toContain('scripts/run-quality-gate.mjs');
    expect(script).toMatch(/--variant full-gate(\s|$)/);
  });

  // #C10 scratch-vs-publish classification — four cases differing only in
  // args/remotes/gateExit and the expected gateRan/status/stderr, merged into
  // one table (TV rules § merge tests differing only in input/expected).
  const ORIGIN_URL = 'https://example.com/origin-fixture.git';
  const SCRATCH_URL = 'ssh://user@host/path';
  const GITHUB_URL = 'https://github.com/Kanevry/session-orchestrator.git';
  // This repo's REAL origin (a self-hosted GitLab, not github.com) — neither
  // of the two #C10 escape hatches (configured-name match, `*github.com*`
  // substring) covers it; only the `git remote get-url --all` URL-match loop
  // does. See mustNotContainStderr below for what this row proves.
  const GITLAB_URL = 'https://gitlab.example.at/x.git';
  // A sentinel `.not.toContain()` can never match real stderr — lets every
  // row assert on the loop-deletion regression without branching inside the
  // shared it.each body (rows that don't care about it get a no-op check).
  const NO_STDERR_CHECK = '\u0000__no-stderr-check__\u0000';

  it('hands the real repo root to the gate as --ledger-root', { timeout: 60_000 }, () => {
    // bug_caught (Q5 named gap; the writer half of the 2026-09-06 HIGH): the
    // hook runs the gate inside a `git clone` of the tracked tree with every
    // *PROJECT_DIR name scrubbed, so the gate resolves THAT tree as its project
    // dir and appends `orchestrator.quality_gate.{passed,failed}` to a
    // directory the hook's EXIT trap deletes. Measured 2026-09-06: a pre-push
    // run that BLOCKED a push left no failed-record in this repo's ledger at
    // all. The writer side of the fix — the hook handing the real root back —
    // had no test: delete `-- --ledger-root "$repo_root"` from the hook and
    // every other test in this file stays green.
    const { res, gateRan, gateArgv, dir } = runPrePush({
      args: ['origin', ORIGIN_URL],
      remotes: { origin: ORIGIN_URL },
      gateExit: 0,
    });

    expect(res.status).toBe(0);
    expect(gateRan).toBe(true);
    const idx = gateArgv.indexOf('--ledger-root');
    expect(idx).toBeGreaterThanOrEqual(0);
    // `git rev-parse --show-toplevel` returns the resolved path, so compare
    // against realpath (/var → /private/var on macOS).
    // resolve(): Git Bash hands over C:/… where realpath says C:\…; a no-op elsewhere.
    expect(resolve(gateArgv[idx + 1])).toBe(realpathSync(dir));
  });

  it('blocks the push when the pushed ref moves while the gate runs (#1623, #1778)', { timeout: 60_000 }, () => {
    // bug_caught: #10 — a warn-and-pass on a moved ref lets an ungated commit
    // leave: over smart HTTP(S) git re-resolves the ref name after the hook and
    // sends the NEW tip (measured 2026-10-24, git 2.56.0; incident #1778). The
    // hook must exit 1 and must not print "quality gate passed".
    const { res, gateRan, dir, sha } = runPrePush({
      args: ['origin', ORIGIN_URL],
      remotes: { origin: ORIGIN_URL },
      moveDuringGate: true,
    });
    const now = fixtureGit(['-C', dir, 'rev-parse', 'refs/heads/feat/x'], undefined, { encoding: 'utf8' }).trim();

    expect(gateRan).toBe(true);
    expect(now).not.toBe(sha);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`gated ${sha}, now ${now}`);
    expect(res.stderr).toContain('Push blocked');
    expect(res.stderr).not.toContain('quality gate passed');
  });

  it.each([
    { src: () => 'HEAD~0', env: {}, status: 1, marker: 'HEAD~0 moved during the gate' },
    { src: () => 'feat/x', env: {}, status: 1, marker: 'feat/x moved during the gate' },
    {
      src: () => 'refs/heads/feat/x',
      env: { MOVE_DELETE: 'refs/heads/feat/x' },
      status: 1,
      marker: 'refs/heads/feat/x no longer resolves after the gate',
    },
    { src: (sha) => sha, env: {}, status: 0, marker: 'quality gate passed' },
  ])('re-checks every non-literal-sha source after the gate (#1778): $marker', { timeout: 60_000 }, ({ src, env, status, marker }) => {
    // bug_caught: #11 — the wave-1 re-check only looked at refs/* and HEAD, so
    // `git push origin HEAD~1:refs/heads/feat` with a commit landing during the
    // gate printed "passed" while HTTP(S) re-resolved HEAD~1 to an ungated tip.
    // The literal-sha row guards the other direction: a raw-sha source (as
    // scripts/release.mjs pushes) cannot move and must not be blocked.
    const { res, gateRan } = runPrePush({
      args: ['origin', ORIGIN_URL],
      remotes: { origin: ORIGIN_URL },
      moveDuringGate: true,
      env,
      stdin: (sha) => `${src(sha)} ${sha} refs/heads/feat/x ${ZERO_SHA}\n`,
    });

    expect(gateRan).toBe(true);
    expect(res.stderr).toContain(marker);
    expect(res.status).toBe(status);
  });

  const git = (dir, argv) => fixtureGit(['-C', dir, ...argv], undefined, { encoding: 'utf8' }).trim();

  it('blocks a push whose refs point at more than one commit, before the gate (#1787)', { timeout: 60_000 }, () => {
    // bug_caught: #12 — the hook gated only the first content line's commit and
    // printed "quality gate passed" for a push that also sent a second, ungated
    // commit. `other` has the SAME tree but a different commit, so a tree-level
    // comparison would wrongly let it through.
    const { res, gateRan } = runPrePush({
      args: ['origin', ORIGIN_URL],
      remotes: { origin: ORIGIN_URL },
      setup: (dir, sha) => {
        const other = git(dir, ['commit-tree', `${sha}^{tree}`, '-p', sha, '-m', 'same tree, other commit']);
        git(dir, ['update-ref', 'refs/heads/other', other]);
        return other;
      },
      stdin: (sha, other) =>
        `refs/heads/feat/x ${sha} refs/heads/feat/x ${ZERO_SHA}\n` +
        `refs/heads/other ${other} refs/heads/other ${ZERO_SHA}\n`,
    });

    expect(gateRan).toBe(false);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('point at more than one commit');
    expect(res.stderr).toContain('refs/heads/feat/x -> ');
    expect(res.stderr).toContain('refs/heads/other -> ');
    expect(res.stderr).not.toContain('quality gate passed');
    // The local gate runs AFTER materialisation, so `gateRan` alone stays green if
    // the block moves below the clone: the block must also precede materialisation.
    expect(res.stderr).not.toContain('materialised the tracked tree');
    expect(res.stderr).not.toContain('running the full quality gate');
  });

  it.each([
    { kind: 'lightweight', tagArgs: ['tag', 'v1'] },
    { kind: 'annotated', tagArgs: ['tag', '-a', '-m', 'v1', 'v1'] },
  ])('gates a branch and its $kind tag on the same commit once (#1787)', { timeout: 60_000 }, ({ tagArgs }) => {
    // bug_caught: #12, the over-block direction — blocking by ref COUNT would
    // stop every release-style "branch + tag" push; comparing the raw local_sha
    // would stop the annotated row, whose stdin carries the TAG OBJECT sha.
    const { res, gateRan } = runPrePush({
      args: ['origin', ORIGIN_URL],
      remotes: { origin: ORIGIN_URL },
      setup: (dir) => {
        fixtureGit(['-C', dir, '-c', 'tag.gpgsign=false', ...tagArgs]);
        return git(dir, ['rev-parse', 'refs/tags/v1']);
      },
      stdin: (sha, tagObj) =>
        `refs/heads/feat/x ${sha} refs/heads/feat/x ${ZERO_SHA}\n` +
        `refs/tags/v1 ${tagObj} refs/tags/v1 ${ZERO_SHA}\n`,
    });

    expect(gateRan).toBe(true);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('2 refs point at one commit — gated once.');
    expect(res.stderr).toContain('quality gate passed');
  });

  it.each([
    {
      // bug_caught: #9 — a configured remote name must never be misread as
      // scratch, or a real publish push loses its gate entirely.
      label: 'gates a PUBLISH push to a configured remote NAME (origin)',
      args: ['origin', ORIGIN_URL],
      remotes: { origin: ORIGIN_URL },
      gateExit: 0,
      expectGateRan: true,
      // '' — no stderr-content expectation for this row (unchanged from the
      // pre-consolidation test, which asserted nothing about stderr here);
      // toContain('') is unconditionally true so the row needs no branch.
      mustContainStderr: '',
      mustNotContainStderr: NO_STDERR_CHECK,
    },
    {
      // bug_caught: #8 — proven red on the unmodified hook (quoted in the #C10
      // report): before the hook read $1/$2 at all, this exact push shape ran
      // the full gate and could block on it (gateExit=2 here would BLOCK the
      // push if the gate ran at all — it must not run).
      label: 'skips the gate as a SCRATCH push for an unconfigured raw URL',
      args: [SCRATCH_URL, SCRATCH_URL],
      remotes: {},
      gateExit: 2,
      expectGateRan: false,
      mustContainStderr: 'scratch push',
      mustNotContainStderr: NO_STDERR_CHECK,
    },
    {
      // bug_caught: #9, the ceiling case (CEILINGS #5) — $1 and $2 are both the
      // URL form (no remote NAME on the command line) when a push targets a
      // remote directly by URL. The github remote's own URL must still gate,
      // or every URL-form publish push reads as scratch.
      label: 'still gates a PUBLISH push made BY URL when the URL matches a configured remote (github)',
      args: [GITHUB_URL, GITHUB_URL],
      remotes: { github: GITHUB_URL },
      gateExit: 0,
      expectGateRan: true,
      mustContainStderr: '',
      mustNotContainStderr: NO_STDERR_CHECK,
    },
    {
      // bug_caught: GAP-1 (qa-strategist, MED) — the github-substring and
      // origin-host escape hatches both rescue the GITHUB_URL row above even
      // if the `git remote get-url --all` URL-match loop were deleted
      // entirely, so that row alone cannot prove the loop matters. This row
      // has NO origin remote configured and a non-github URL, so ONLY the
      // loop can classify it as a publish push — deleting the loop makes
      // so_scratch stay 1, and the push silently skips its gate.
      label: 'still gates a PUBLISH push made BY URL to a configured NON-GitHub remote (gitlab), no origin configured',
      args: [GITLAB_URL, GITLAB_URL],
      remotes: { gitlab: GITLAB_URL },
      gateExit: 0,
      expectGateRan: true,
      mustContainStderr: '',
      mustNotContainStderr: 'scratch push',
    },
  ])('$label', { timeout: 60_000 }, ({ args, remotes, gateExit, expectGateRan, mustContainStderr, mustNotContainStderr }) => {
    const { res, gateRan } = runPrePush({ args, remotes, gateExit });

    expect(gateRan).toBe(expectGateRan);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain(mustContainStderr);
    expect(res.stderr).not.toContain(mustNotContainStderr);
  });
});
