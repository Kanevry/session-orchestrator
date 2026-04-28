/**
 * tests/scripts/measure-policy-cache-effectiveness.test.mjs
 *
 * Smoke tests for scripts/measure-policy-cache-effectiveness.mjs (issue #266).
 *
 * Covers: script runs to exit 0, --json output is valid JSON with expected
 * top-level keys, human output includes the recommendation verdict string,
 * missing --headless guard does NOT apply (no required flags for this script).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'measure-policy-cache-effectiveness.mjs');

/**
 * Run the measurement script with given extra args.
 * Use --subprocess-count 2 and --inprocess-count 2 to keep tests fast.
 */
function run(extraArgs = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--subprocess-count', '2', '--inprocess-count', '2', ...extraArgs],
    { encoding: 'utf8', timeout: 30_000 },
  );
}

describe('measure-policy-cache-effectiveness.mjs — smoke', () => {
  it('exits 0 (human output mode)', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('--json flag produces parseable JSON with required top-level keys', () => {
    const result = run(['--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    let parsed;
    expect(() => {
      parsed = JSON.parse(result.stdout);
    }).not.toThrow();

    expect(parsed).toHaveProperty('measured_at');
    expect(parsed).toHaveProperty('config');
    expect(parsed).toHaveProperty('findings');
    expect(parsed).toHaveProperty('recommendation');
  });

  it('--json output has cache and policy sub-findings', () => {
    const result = run(['--json']);
    const parsed = JSON.parse(result.stdout);

    expect(parsed.findings).toHaveProperty('cache');
    expect(parsed.findings).toHaveProperty('policy');

    // cache section must report persists_across_subprocesses as a boolean
    expect(typeof parsed.findings.cache.persists_across_subprocesses).toBe('boolean');

    // recommendation must have a string verdict
    expect(typeof parsed.recommendation.verdict).toBe('string');
    expect(parsed.recommendation.verdict.length).toBeGreaterThan(0);
  });

  it('human output contains the Recommendation section header', () => {
    const result = run();
    expect(result.stdout).toContain('Recommendation');
    expect(result.stdout).toContain('Verdict');
  });
});
