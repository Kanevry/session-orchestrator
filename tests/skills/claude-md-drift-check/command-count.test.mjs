/**
 * tests/skills/claude-md-drift-check/command-count.test.mjs
 *
 * Vitest suite for the command-count drift probe (check 5) in
 * skills/claude-md-drift-check/checker.mjs.
 *
 * Strategy: spawn the checker as a subprocess with a temp VAULT_DIR.
 * Use --commands-dir to point at an ephemeral commands/ fixture directory
 * so tests are fully isolated from the real commands/ folder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECKER = resolve(process.cwd(), 'skills/claude-md-drift-check/checker.mjs');

function runChecker(vaultDir, args = []) {
  const r = spawnSync('node', [CHECKER, ...args], {
    env: { ...process.env, VAULT_DIR: vaultDir, PATH: process.env.PATH },
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function parseJson(out) {
  const line = out.trim().split('\n').find((l) => l.startsWith('{'));
  return JSON.parse(line);
}

/** Create N dummy *.md files in a directory and return the directory path. */
function makeCommandsDir(parentDir, count) {
  const dir = join(parentDir, 'commands');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(dir, `cmd${i}.md`), `# command ${i}\n`);
  }
  return dir;
}

let vault;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'drift-cmd-count-'));
});

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true });
});

describe('check 5: command-count', () => {
  it('no drift — claimed count matches actual commands/ count', () => {
    const cmdDir = makeCommandsDir(vault, 8);
    writeFileSync(join(vault, 'CLAUDE.md'), '- 8 commands (/session, /go, /close, ...)\n');
    const r = runChecker(vault, ['--skip-issue-refs', '--commands-dir', cmdDir]);
    const j = parseJson(r.stdout);
    expect(j.checks_run).toContain('command-count');
    const errs = j.errors.filter((e) => e.check === 'command-count');
    expect(errs).toHaveLength(0);
    expect(j.command_count.actual).toBe(8);
  });

  it('drift — claimed count too low (claimed < actual)', () => {
    const cmdDir = makeCommandsDir(vault, 9);
    writeFileSync(join(vault, 'CLAUDE.md'), '8 commands\n');
    const r = runChecker(vault, ['--skip-issue-refs', '--commands-dir', cmdDir]);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'command-count');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/claims 8 commands.*actual.*9/);
    expect(errs[0].command_count).toEqual({ actual: 9, claimed: 8 });
  });

  it('drift — claimed count too high (claimed > actual)', () => {
    const cmdDir = makeCommandsDir(vault, 5);
    writeFileSync(join(vault, 'CLAUDE.md'), '10 commands available\n');
    const r = runChecker(vault, ['--skip-issue-refs', '--commands-dir', cmdDir]);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'command-count');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/claims 10 commands.*actual.*5/);
    expect(errs[0].command_count).toEqual({ actual: 5, claimed: 10 });
  });

  it('no-claim-found — no "N commands" text in CLAUDE.md, no drift error (info only)', () => {
    const cmdDir = makeCommandsDir(vault, 8);
    writeFileSync(join(vault, 'CLAUDE.md'), '# No command count mentioned here\n');
    const r = runChecker(vault, ['--skip-issue-refs', '--commands-dir', cmdDir]);
    const j = parseJson(r.stdout);
    expect(j.checks_run).toContain('command-count');
    const errs = j.errors.filter((e) => e.check === 'command-count');
    expect(errs).toHaveLength(0);
    // actual count still surfaced in top-level summary
    expect(j.command_count.actual).toBe(8);
  });

  it('skipped when commands/ directory is absent', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '8 commands\n');
    // no commands-dir created, no commands/ in vault
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('command-count');
    expect(j.checks_skipped.some((s) => s.startsWith('command-count'))).toBe(true);
    expect(j.errors.filter((e) => e.check === 'command-count')).toHaveLength(0);
  });

  it('can be disabled with --skip-command-count', () => {
    const cmdDir = makeCommandsDir(vault, 3);
    writeFileSync(join(vault, 'CLAUDE.md'), '99 commands\n');
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-command-count', '--commands-dir', cmdDir]);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('command-count');
    expect(j.errors.filter((e) => e.check === 'command-count')).toHaveLength(0);
  });

  it('hidden .md files and non-.md files are not counted', () => {
    const dir = makeCommandsDir(vault, 3);
    writeFileSync(join(dir, '.hidden.md'), '# hidden\n');
    writeFileSync(join(dir, 'readme.txt'), 'not a command\n');
    // 3 real + 1 hidden + 1 txt = only 3 counted
    writeFileSync(join(vault, 'CLAUDE.md'), '3 commands\n');
    const r = runChecker(vault, ['--skip-issue-refs', '--commands-dir', dir]);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'command-count');
    expect(errs).toHaveLength(0);
    expect(j.command_count.actual).toBe(3);
  });

  it('matches "N /commands" slash-prefix variant', () => {
    const cmdDir = makeCommandsDir(vault, 4);
    writeFileSync(join(vault, 'CLAUDE.md'), '5 /commands available\n');
    const r = runChecker(vault, ['--skip-issue-refs', '--commands-dir', cmdDir]);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'command-count');
    expect(errs).toHaveLength(1);
    expect(errs[0].command_count).toEqual({ actual: 4, claimed: 5 });
  });
});
