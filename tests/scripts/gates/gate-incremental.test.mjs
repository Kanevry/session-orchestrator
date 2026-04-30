/**
 * tests/scripts/gates/gate-incremental.test.mjs
 *
 * Integration tests for scripts/lib/gates/gate-incremental.mjs
 * Spawns the script via node, injects env vars, and asserts on JSON stdout + exit code.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/gates/gate-incremental.mjs',
);

/**
 * Spawn gate-incremental.mjs with the given extra env vars.
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

describe('gate-incremental — skip+skip', () => {
  it('exits 0 when both commands are "skip"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    expect(r.status).toBe(0);
  });

  it('emits a valid JSON object to stdout', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('JSON contains variant="incremental"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.variant).toBe('incremental');
  });

  it('JSON contains errors as an empty array when both skip', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(Array.isArray(json.errors)).toBe(true);
    expect(json.errors).toHaveLength(0);
  });

  it('JSON contains duration_seconds as a non-negative integer', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(typeof json.duration_seconds).toBe('number');
    expect(json.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(json.duration_seconds)).toBe(true);
  });

  it('JSON contains typecheck and test keys', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(Object.keys(json)).toContain('typecheck');
    expect(Object.keys(json)).toContain('test');
  });
});

// ---------------------------------------------------------------------------
// typecheck failure — errors array populated
// ---------------------------------------------------------------------------

describe('gate-incremental — typecheck failure', () => {
  it('exits 0 even when typecheck fails (informational gate)', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip' });
    expect(r.status).toBe(0);
  });

  it('typecheck field is "fail" when command exits non-zero', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck).toBe('fail');
  });

  it('errors array is populated when typecheck output contains TS error patterns', () => {
    // Command emits a TS-style error line then exits non-zero
    const cmd = `node -e "process.stdout.write('error TS2304: bad type\\n'); process.exit(1)"`;
    const r = run({ TYPECHECK_CMD: cmd, TEST_CMD: 'skip' });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.errors).toBeInstanceOf(Array);
    // The error line should be captured (extractErrorLinesJson looks for /error TS\d+/)
    expect(json.errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// no FILES / SESSION_START_REF → full test suite runs
// ---------------------------------------------------------------------------

describe('gate-incremental — full suite fallback when no file scope given', () => {
  it('test=pass when TEST_CMD succeeds and no FILES/SESSION_START_REF set', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'echo TESTS_PASS' });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.test).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// missing env vars
// ---------------------------------------------------------------------------

describe('gate-incremental — missing env vars', () => {
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
