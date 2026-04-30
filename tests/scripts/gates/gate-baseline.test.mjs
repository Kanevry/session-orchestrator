/**
 * tests/scripts/gates/gate-baseline.test.mjs
 *
 * Integration tests for scripts/lib/gates/gate-baseline.mjs
 * Spawns the script via node, injects env vars, and asserts on JSON stdout + exit code.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/gates/gate-baseline.mjs',
);

/**
 * Spawn gate-baseline.mjs with the given extra env vars.
 */
function run(extraEnv = {}) {
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

// ---------------------------------------------------------------------------
// skip + skip
// ---------------------------------------------------------------------------

describe('gate-baseline — skip+skip', () => {
  it('exits 0 when both commands are "skip"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    expect(r.status).toBe(0);
  });

  it('emits a valid JSON object to stdout', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout)).toBeTypeOf('object');
  });

  it('JSON contains variant="baseline"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.variant).toBe('baseline');
  });

  it('JSON typecheck and test fields are "skip"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck).toBe('skip');
    expect(json.test).toBe('skip');
  });

  it('JSON contains typecheck_output and test_output keys', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(Object.keys(json)).toContain('typecheck_output');
    expect(Object.keys(json)).toContain('test_output');
  });
});

// ---------------------------------------------------------------------------
// commands that produce real output
// ---------------------------------------------------------------------------

describe('gate-baseline — passing commands', () => {
  it('typecheck=pass when TYPECHECK_CMD succeeds', () => {
    const r = run({ TYPECHECK_CMD: 'echo TC_OK', TEST_CMD: 'skip' });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.typecheck).toBe('pass');
  });

  it('typecheck_output contains the command output', () => {
    const r = run({ TYPECHECK_CMD: 'echo TC_OK', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck_output).toContain('TC_OK');
  });

  it('test=pass when TEST_CMD succeeds', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'echo TEST_OK' });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.test).toBe('pass');
  });

  it('test_output contains the command output', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'echo TEST_OK' });
    const json = JSON.parse(r.stdout);
    expect(json.test_output).toContain('TEST_OK');
  });
});

// ---------------------------------------------------------------------------
// failing typecheck — informational only, still exits 0
// ---------------------------------------------------------------------------

describe('gate-baseline — failing typecheck', () => {
  it('exits 0 even when TYPECHECK_CMD fails (informational gate)', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip' });
    expect(r.status).toBe(0);
  });

  it('typecheck field is "fail" when command exits non-zero', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// missing env vars
// ---------------------------------------------------------------------------

describe('gate-baseline — missing env vars', () => {
  it('exits 1 when TYPECHECK_CMD is not set', () => {
    const env = { ...process.env };
    delete env.TYPECHECK_CMD;
    env.TEST_CMD = 'skip';
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TYPECHECK_CMD');
  });

  it('exits 1 when TEST_CMD is not set', () => {
    const env = { ...process.env };
    delete env.TEST_CMD;
    env.TYPECHECK_CMD = 'skip';
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TEST_CMD');
  });
});
