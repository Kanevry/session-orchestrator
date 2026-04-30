/**
 * tests/scripts/gates/gate-per-file.test.mjs
 *
 * Integration tests for scripts/lib/gates/gate-per-file.mjs
 * Spawns the script via node, injects env vars, and asserts on JSON stdout + exit codes.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/gates/gate-per-file.mjs',
);

/**
 * Spawn gate-per-file.mjs with the given extra env vars.
 */
function run(extraEnv = {}) {
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

// ---------------------------------------------------------------------------
// skip + skip, no FILES
// ---------------------------------------------------------------------------

describe('gate-per-file — skip+skip, no FILES', () => {
  it('exits 0 when both commands are "skip" and FILES is empty', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', FILES: '' });
    expect(r.status).toBe(0);
  });

  it('emits valid JSON to stdout', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', FILES: '' });
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('JSON contains variant="per-file"', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', FILES: '' });
    const json = JSON.parse(r.stdout);
    expect(json.variant).toBe('per-file');
  });

  it('JSON files array is empty when FILES env is empty', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', FILES: '' });
    const json = JSON.parse(r.stdout);
    expect(Array.isArray(json.files)).toBe(true);
    expect(json.files).toHaveLength(0);
  });

  it('JSON test is "skip" when FILES is empty', () => {
    const r = run({ TYPECHECK_CMD: 'skip', TEST_CMD: 'skip', FILES: '' });
    const json = JSON.parse(r.stdout);
    expect(json.test).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// FILES provided
// ---------------------------------------------------------------------------

describe('gate-per-file — FILES provided', () => {
  it('JSON files array contains both files when FILES has two entries', () => {
    const r = run({
      TYPECHECK_CMD: 'skip',
      TEST_CMD: 'skip',
      FILES: 'a.test.mjs,b.test.mjs',
    });
    const json = JSON.parse(r.stdout);
    expect(json.files).toEqual(['a.test.mjs', 'b.test.mjs']);
  });

  it('exits 0 when FILES are provided and TEST_CMD is skip', () => {
    const r = run({
      TYPECHECK_CMD: 'skip',
      TEST_CMD: 'skip',
      FILES: 'a.test.mjs,b.test.mjs',
    });
    expect(r.status).toBe(0);
  });

  it('JSON test is "skip" even with FILES when TEST_CMD is "skip"', () => {
    const r = run({
      TYPECHECK_CMD: 'skip',
      TEST_CMD: 'skip',
      FILES: 'a.test.mjs',
    });
    const json = JSON.parse(r.stdout);
    expect(json.test).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// typecheck pass/fail
// ---------------------------------------------------------------------------

describe('gate-per-file — typecheck pass', () => {
  it('typecheck is "pass" when TYPECHECK_CMD succeeds', () => {
    const r = run({ TYPECHECK_CMD: 'echo TC_OK', TEST_CMD: 'skip', FILES: '' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck).toBe('pass');
  });
});

describe('gate-per-file — typecheck fail', () => {
  it('exits 0 even when typecheck fails (informational gate)', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip', FILES: '' });
    expect(r.status).toBe(0);
  });

  it('typecheck is "fail" when TYPECHECK_CMD exits non-zero', () => {
    const r = run({ TYPECHECK_CMD: 'node -e "process.exit(1)"', TEST_CMD: 'skip', FILES: '' });
    const json = JSON.parse(r.stdout);
    expect(json.typecheck).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// missing env vars
// ---------------------------------------------------------------------------

describe('gate-per-file — missing env vars', () => {
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
