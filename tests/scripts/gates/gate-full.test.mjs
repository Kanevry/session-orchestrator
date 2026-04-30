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
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

// ---------------------------------------------------------------------------
// All skip → exit 0
// ---------------------------------------------------------------------------

describe('gate-full — all skip', () => {
  it('exits 0 when all three checks are skipped', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    expect(r.status).toBe(0);
  });

  it('emits a valid JSON object to stdout', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('JSON contains variant="full-gate"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.variant).toBe('full-gate');
  });

  it('JSON typecheck.status is "skip"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.status).toBe('skip');
  });

  it('JSON test.status is "skip"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.test.status).toBe('skip');
  });

  it('JSON lint.status is "skip"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.lint.status).toBe('skip');
  });

  it('JSON contains duration_seconds as a non-negative number', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(typeof json.duration_seconds).toBe('number');
    expect(json.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it('JSON contains debug_artifacts as an empty array when no ref given', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(Array.isArray(json.debug_artifacts)).toBe(true);
  });

  it('JSON lint.warnings is 0 when lint is skipped', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.lint.warnings).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Typecheck failure → exit 2
// ---------------------------------------------------------------------------

describe('gate-full — typecheck failure', () => {
  it('exits 2 when typecheck fails', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    expect(r.status).toBe(2);
  });

  it('typecheck.status is "fail" when command exits non-zero', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.status).toBe('fail');
  });

  it('typecheck.error_count is >= 1 when output contains TS error lines', () => {
    const cmd = `node -e "process.stdout.write('error TS2304: Cannot find name\\n'); process.exit(1)"`;
    const r = run({ TYPECHECK_CMD: cmd, TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.error_count).toBeGreaterThanOrEqual(1);
  });

  it('typecheck.error_count is 0 when output has no TS error lines', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.error_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test failure → exit 2
// ---------------------------------------------------------------------------

describe('gate-full — test failure', () => {
  it('exits 2 when TEST_CMD fails', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'node -e "process.exit(1)"', LINT_CMD: 'skip' });
    expect(r.status).toBe(2);
  });

  it('test.status is "fail" when command exits non-zero', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'node -e "process.exit(1)"', LINT_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.test.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// All pass → exit 0
// ---------------------------------------------------------------------------

describe('gate-full — all pass', () => {
  it('exits 0 when all three commands succeed', () => {
    const r = run({
      TYPECHECK_CMD: 'echo TC_OK',
      TEST_CMD: 'echo TEST_OK',
      LINT_CMD: 'echo LINT_OK',
    });
    expect(r.status).toBe(0);
  });

  it('all statuses are "pass" when commands succeed', () => {
    const r = run({
      TYPECHECK_CMD: 'echo TC_OK',
      TEST_CMD: 'echo TEST_OK',
      LINT_CMD: 'echo LINT_OK',
    });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck.status).toBe('pass');
    expect(json.test.status).toBe('pass');
    expect(json.lint.status).toBe('pass');
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
