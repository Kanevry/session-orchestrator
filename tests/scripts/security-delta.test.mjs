import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = join(process.cwd(), 'scripts', 'security-delta.mjs');
let repo;

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', timeout: 30000 });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'secdelta-cli-'));
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  const id = ['-c', 'user.email=t@example.org', '-c', 'user.name=t'];
  git('init', '-q');
  git(...id, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(...id, 'commit', '-q', '--allow-empty', '-m', 'two');
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('security-delta CLI', () => {
  // Bug caught: the entry guard or JSON path silently doing nothing (exit 0, empty stdout).
  it('prints one skipped JSON Result under --mode off and exits 0', () => {
    const r = run(['--range', 'HEAD~1..HEAD', '--repo-root', repo, '--mode', 'off', '--json']);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      schema: 1,
      mode: 'off',
      range: 'HEAD~1..HEAD',
      status: 'skipped',
      verdict: 'pass',
      checks: [],
    });
  });

  // Bug caught: the canonical $SESSION_RANGE fallback `<base>...HEAD` was
  // rejected as a usage error, so Phase 2.4 never measured on an unpinned start ref.
  it('resolves a three-dot --range to <merge-base>..<head> and exits 0', () => {
    const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const mergeBase = git('merge-base', 'HEAD~1', 'HEAD');
    const r = run(['--range', 'HEAD~1...HEAD', '--repo-root', repo, '--mode', 'warn', '--no-event', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).range).toBe(`${mergeBase}..HEAD`);
  });

  // Bug caught: a merge-base failure running the checks on an unresolved base.
  it('exits 1 when the three-dot base has no merge base', () => {
    const r = run(['--range', 'no-such-ref...HEAD', '--repo-root', repo, '--mode', 'warn', '--no-event', '--json']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('merge-base');
  });

  // Bug caught: an unknown mode falling back silently instead of a usage error.
  it('rejects an unknown --mode with exit 1', () => {
    const r = run(['--range', 'HEAD~1..HEAD', '--repo-root', repo, '--mode', 'block']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--mode');
  });

  // Bug caught: a range value git would read as an option.
  it('rejects a --range starting with - with exit 1', () => {
    const r = run(['--range=--output=x..HEAD', '--repo-root', repo, '--mode', 'off']);
    expect(r.status).toBe(1);
  });

  it('documents exit code 3 in --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\s+3\s+verdict block/m);
  });
});
