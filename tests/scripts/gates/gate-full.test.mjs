/**
 * tests/scripts/gates/gate-full.test.mjs
 *
 * Integration tests for scripts/lib/gates/gate-full.mjs
 * Spawns the script via node, injects env vars, and asserts on JSON stdout + exit codes.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/gates/gate-full.mjs',
);

/**
 * Spawn gate-full.mjs with the given extra env vars.
 */
function run(extraEnv = {}) {
  const env = { ...process.env };
  for (const key of ['TYPECHECK_CMD', 'TEST_CMD', 'LINT_CMD', 'FILES', 'SESSION_START_REF']) {
    delete env[key];
  }
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  });
}

// ---------------------------------------------------------------------------
// All skip → exit 0
// ---------------------------------------------------------------------------

describe('gate-full — all skip', () => {
  // Consolidated from 9 single-assertion `it`s that each re-spawned the gate to
  // read ONE field of the SAME envelope (TV-002 duplication). One spawn, one
  // envelope, whole-object assertions — which are also tighter than the
  // per-field `toBe`s they replace.
  it('emits the documented all-skip envelope and exits 0', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    expect(r.status).toBe(0);

    const json = JSON.parse(r.stdout);
    expect(json.variant).toBe('full-gate');
    expect(json.typecheck).toEqual({ status: 'skip', error_count: 0 });
    // `failed` is published explicitly since #967 item 1 — a skipped test gate
    // must still carry the key (as 0), or the consumer's
    // `passed + failed === total` drift check silently degrades to a derivation.
    //
    // The file-level four are the OPPOSITE case and are ABSENT here: a skipped
    // gate produced no `Test Files` line, so nothing about files was measured.
    // Publishing `files_*: 0` + `suite_died: false` stated a verdict nobody
    // checked — this whole-object `toEqual` is what pins their absence.
    expect(json.test).toEqual({
      status: 'skip',
      total: 0,
      passed: 0,
      failed: 0,
    });
    expect(json.lint).toEqual({ status: 'skip', warnings: 0 });
    expect(json.debug_artifacts).toEqual([]);
    expect(typeof json.duration_seconds).toBe('number');
    expect(json.duration_seconds).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Typecheck failure → exit 2
// ---------------------------------------------------------------------------

describe('gate-full — typecheck failure', () => {
  // Consolidated from 4 `it`s (3 of which re-spawned the identical command).
  it('exits 2, reports status "fail", and counts 0 errors without TS error lines', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    expect(r.status).toBe(2);
    const json = JSON.parse(r.stdout);
    expect(json.typecheck).toEqual({ status: 'fail', error_count: 0 });
  });

  it('typecheck.error_count is >= 1 when output contains TS error lines', () => {
    const cmd = `node -e "process.stdout.write('error TS2304: Cannot find name\\n'); process.exit(1)"`;
    const r = run({ TYPECHECK_CMD: cmd, TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.error_count).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test failure → exit 2
// ---------------------------------------------------------------------------

describe('gate-full — test failure', () => {
  // Consolidated from 2 `it`s that re-spawned the identical command.
  it('exits 2 and reports test.status "fail" when TEST_CMD fails', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'node -e "process.exit(1)"', LINT_CMD: 'skip' });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).test.status).toBe('fail');
  });

  // #1149 — a suite that dies at import is a file-level failure. Vitest omits
  // `N failed` on the `Tests` line when zero test CASES ran, so the test-case
  // triple stays `failed: 0` even though a file died. `files_failed` and the
  // self-diagnosing `suite_died` boolean must still land on the ONE stdout
  // JSON document, so the contradiction is greppable instead of silent.
  it('publishes files_failed and suite_died:true when a suite dies at import with no test-case failed segment (#1149)', () => {
    const cmd =
      'node -e "process.stdout.write(\' Test Files  1 failed (1)\\n      Tests  5 passed (5)\\n\'); process.exit(1)"';
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: cmd, LINT_CMD: 'skip' });
    expect(r.status).toBe(2);

    const parsed = JSON.parse(r.stdout);
    expect(parsed.test).toEqual({
      status: 'fail',
      total: 5,
      passed: 5,
      failed: 0,
      files_total: 1,
      files_passed: 0,
      files_failed: 1,
      suite_died: true,
    });
    // Contract: consumers parse exactly one JSON document from stdout.
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  // The sibling of the row above, and the bug it names: a FAILING runner that
  // prints no `Test Files` line at all (non-vitest, or a terse reporter) used to
  // publish `files_total/passed/failed: 0` plus `suite_died: false` — an
  // unmeasured zero the envelope could not tell from a measured one, and a
  // "the suite did not die" verdict derived from it. Absent, not zero.
  it('omits every files_* key AND suite_died when the runner printed no Test Files line', () => {
    const cmd = 'node -e "process.stdout.write(\'      Tests  3 passed (3)\\n\'); process.exit(1)"';
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: cmd, LINT_CMD: 'skip' });
    expect(r.status).toBe(2);

    const parsed = JSON.parse(r.stdout);
    expect(parsed.test).toEqual({ status: 'fail', total: 3, passed: 3, failed: 0 });
    expect(parsed.test).not.toHaveProperty('files_total');
    expect(parsed.test).not.toHaveProperty('files_passed');
    expect(parsed.test).not.toHaveProperty('files_failed');
    // The load-bearing half: `suite_died: false` here would be a claim about a
    // file-level measurement that never happened.
    expect(parsed.test).not.toHaveProperty('suite_died');
  });
});

// ---------------------------------------------------------------------------
// All pass → exit 0
// ---------------------------------------------------------------------------

describe('gate-full — all pass', () => {
  // Consolidated from 2 `it`s that re-spawned the identical env.
  it('exits 0 with all three statuses "pass" when commands succeed', () => {
    const r = run({
      TYPECHECK_CMD: 'echo TC_OK',
      TEST_CMD: 'echo TEST_OK',
      LINT_CMD: 'echo LINT_OK',
    });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.status).toBe('pass');
    expect(json.test.status).toBe('pass');
    expect(json.lint.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// stubbed field in emitted JSON
// ---------------------------------------------------------------------------

describe('gate-full — stubbed field in emitted JSON', () => {
  it('JSON contains stubbed as an empty object when all commands are real (not stubs)', () => {
    const r = run({
      TYPECHECK_CMD: 'node -e "process.exit(0)"',
      TEST_CMD: 'node -e "process.exit(0)"',
      LINT_CMD: 'node -e "process.exit(0)"',
    });
    const json = JSON.parse(r.stdout);
    expect(json.stubbed).toEqual({});
  });

  it('JSON contains stubbed key even when all checks are skipped', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json).toHaveProperty('stubbed');
    expect(json.stubbed).toEqual({});
  });

  // Consolidated from 3 `it`s that re-spawned the identical echo-stub env.
  it('flags an echo TEST_CMD as a stub while still passing the gate', () => {
    const r = run({
      TYPECHECK_CMD: 'node -e "process.exit(0)"',
      TEST_CMD: 'echo "no tests yet"',
      LINT_CMD: 'node -e "process.exit(0)"',
    });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.stubbed.test).toEqual({ kind: 'echo' });
    expect(json.test.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Missing env vars
// ---------------------------------------------------------------------------

describe('gate-full — missing env vars', () => {
  it('exits 1 when TYPECHECK_CMD is not set', () => {
    const env = { ...process.env };
    delete env.TYPECHECK_CMD;
    env.TEST_CMD = 'skip';
    env.LINT_CMD = 'skip';
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TYPECHECK_CMD');
  });

  it('exits 1 when TEST_CMD is not set', () => {
    const env = { ...process.env };
    delete env.TEST_CMD;
    env.TYPECHECK_CMD = 'skip';
    env.LINT_CMD = 'skip';
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TEST_CMD');
  });

  it('exits 1 when LINT_CMD is not set', () => {
    const env = { ...process.env };
    delete env.LINT_CMD;
    env.TYPECHECK_CMD = 'skip';
    env.TEST_CMD = 'skip';
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('LINT_CMD');
  });
});
