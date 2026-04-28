/**
 * tests/scripts/lifecycle-sim-v6.test.mjs
 *
 * Smoke tests for scripts/lifecycle-sim-v6.mjs (issue #86).
 *
 * Coverage focus per test-quality.md:
 *   - exits 0 for the documented happy paths (warn / strict / both)
 *   - --json output has the documented shape (specific keys + types)
 *   - same seed → byte-identical output (deterministic contract)
 *   - bad arguments fail fast with exit 1 (error path)
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'lifecycle-sim-v6.mjs');

function run(args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

describe('lifecycle-sim-v6.mjs — smoke', () => {
  it('exits 0 for the default invocation (both modes, human output)', () => {
    const result = run(['--sessions', '20', '--seed', '42']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('mode: warn');
    expect(result.stdout).toContain('mode: strict');
  });

  it('--json emits both mode results with the documented shape', () => {
    const result = run(['--sessions', '20', '--seed', '42', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.seed).toBe(42);
    expect(parsed.sessions).toBe(20);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].mode).toBe('warn');
    expect(parsed.results[1].mode).toBe('strict');
    // Each result carries the documented shape.
    expect(parsed.results[0]).toEqual(
      expect.objectContaining({
        mode: 'warn',
        sessions: 20,
        totals: expect.objectContaining({
          planned: expect.any(Number),
          completed: expect.any(Number),
          blocked: expect.any(Number),
        }),
        completionRatio: expect.any(Number),
        carryover: expect.objectContaining({
          meanRatio: expect.any(Number),
          p95Ratio: expect.any(Number),
        }),
        stagnation: expect.objectContaining({
          stagnantSessions: expect.any(Number),
          stagnationRate: expect.any(Number),
          longestStreak: expect.any(Number),
        }),
      }),
    );
  });

  it('produces byte-identical output for the same seed (determinism)', () => {
    const a = run(['--sessions', '50', '--seed', '42', '--json']);
    const b = run(['--sessions', '50', '--seed', '42', '--json']);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('rejects invalid --enforcement with exit 1 and a stderr message', () => {
    const result = run(['--enforcement', 'banana', '--sessions', '10']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--enforcement');
  });
});
