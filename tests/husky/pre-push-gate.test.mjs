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
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
 * Run the real hook in a tmp dir with a stubbed `quality-gate` npm script.
 * The stub writes a `gate-ran` sentinel (so tests can assert whether the gate
 * was invoked at all) and exits with the configured code.
 */
function runPrePush({ stdin, gateExit = 0, env = {}, withGateScript = true } = {}) {
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
});
