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
 *   9. (#C10) a PUBLISH push — a configured remote NAME, or a URL-form push
 *      whose URL matches a configured remote (`git push https://github.com/...`)
 *      — is misread as scratch and skips the gate it needs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
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
const GATE_PROBE_SRC = "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.GATE_RAN_FILE, 'ran');\n";

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
function runPrePush({ stdin, gateExit = 0, env = {}, withGateScript = true, args, remotes = {} } = {}) {
  if (args) {
    const dir = mkdtempSync(join(tmpdir(), 'so-pre-push-remote-'));
    tmpDirs.push(dir);
    const gateRanFile = join(mkdtempSync(join(tmpdir(), 'so-pre-push-sentinel-')), 'gate-ran');

    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
    for (const [name, url] of Object.entries(remotes)) {
      execFileSync('git', ['-C', dir, 'remote', 'add', name, url]);
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
        scripts: { 'quality-gate': `node gate-probe.mjs && exit ${gateExit}` },
      }),
    );
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture']);
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const childEnv = { ...process.env };
    delete childEnv.SKIP_QUALITY_GATE;
    Object.assign(childEnv, { GATE_RAN_FILE: gateRanFile }, env);
    const res = spawnSync('sh', [HOOK_PATH, ...args], {
      cwd: dir,
      input: stdin ?? `refs/heads/feat/x ${sha} refs/heads/feat/x ${ZERO_SHA}\n`,
      encoding: 'utf8',
      timeout: 60_000,
      env: childEnv,
    });
    return { res, gateRan: existsSync(gateRanFile) };
  }

  const dir = mkdtempSync(join(tmpdir(), 'so-pre-push-'));
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
  const res = spawnSync('sh', [HOOK_PATH], {
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
