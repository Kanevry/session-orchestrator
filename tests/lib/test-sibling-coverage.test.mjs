/**
 * tests/lib/test-sibling-coverage.test.mjs
 *
 * TV-001, the bug this names: a broken denominator. If test files leak into the
 * production count (or production is enumerated by a directory list that drops
 * a top-level dir), every percentage in wave-loop-scope-manifest.md § Test-Sibling
 * Expansion silently moves while still looking plausible. A tmp git repo with a
 * known layout pins all four counts and the mirror ≤ exact ≤ glob ≤ total chain.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'lib', 'test-sibling-coverage.mjs');

const LAYOUT = [
  'scripts/lib/alpha.mjs', // mirror tests/lib/alpha.test.mjs → all three
  'hooks/beta.mjs', // exact basename, not mirrored → exact + glob
  'skills/x/gamma.mjs', // only a prefix match gamma-cli.test.mjs → glob
  'tools/delta.mjs', // new top-level dir, no test → total only
  'docs/readme.md', // not a sibling-rule source → not counted
  'tests/lib/alpha.test.mjs',
  'tests/unit/beta.test.mjs',
  'tests/unit/gamma-cli.test.mjs',
  'tests/helpers/fixture.mjs', // test-side .mjs → must NOT enter the denominator
  'scripts/lib/epsilon.test.mjs', // co-located test → must NOT enter the denominator
];

let repo;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'so-sibling-coverage-'));
  for (const f of LAYOUT) {
    mkdirSync(join(repo, dirname(f)), { recursive: true });
    writeFileSync(join(repo, f), '');
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: repo });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('test-sibling-coverage CLI', () => {
  it('counts production by negation and keeps mirror ≤ exact ≤ glob ≤ total', () => {
    const r = spawnSync(process.execPath, [SCRIPT, repo, '--json'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout);
    expect({ total: env.total, glob: env.glob, exact: env.exact, mirror: env.mirror })
      .toEqual({ total: 4, glob: 3, exact: 2, mirror: 1 });
    expect(env.uncovered).toEqual(['tools/delta.mjs']);
    expect(env.dirty).toBe(false);
    expect(typeof env.definition.invariant).toBe('string');
  });

  it('exits 2 outside a git repo instead of reporting zeros', () => {
    const plain = mkdtempSync(join(tmpdir(), 'so-sibling-nogit-'));
    try {
      const r = spawnSync(process.execPath, [SCRIPT, plain, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(plain) },
      });
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
