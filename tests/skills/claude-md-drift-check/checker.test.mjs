/**
 * tests/skills/claude-md-drift-check/checker.test.mjs
 *
 * Vitest suite for skills/claude-md-drift-check/checker.mjs — 4 narrative-drift
 * checks (path-resolver, project-count-sync, issue-reference-freshness,
 * session-file-existence) + mode handling (warn/hard/off).
 *
 * Strategy: spawn the checker as a subprocess with VAULT_DIR pointing at
 * an ephemeral tmp vault. Assert on JSON output + exit code.
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

let vault;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'drift-check-'));
});

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true });
});

describe('mode handling', () => {
  it('mode=off short-circuits to skipped-mode-off without scanning', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# Test\n/Users/nowhere/xyz\n');
    const r = runChecker(vault, ['--mode', 'off']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('skipped-mode-off');
    expect(j.mode).toBe('off');
  });

  it('mode=warn exits 0 even when errors exist', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'Bad path: /Users/definitely/missing/xyz-abc\n');
    const r = runChecker(vault, ['--mode', 'warn', '--skip-issue-refs']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('invalid');
    expect(j.errors.length).toBeGreaterThan(0);
  });

  it('mode=hard exits 1 when errors exist', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'Bad path: /Users/definitely/missing/xyz-abc\n');
    const r = runChecker(vault, ['--mode', 'hard', '--skip-issue-refs']);
    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('invalid');
  });

  it('mode=hard exits 0 when clean', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# clean\nNo paths here.\n');
    const r = runChecker(vault, ['--mode', 'hard', '--skip-issue-refs']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('ok');
  });

  it('invalid --mode returns infra-error exit 2', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# x\n');
    const r = runChecker(vault, ['--mode', 'banana']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid --mode');
  });
});

describe('check 1: path-resolver', () => {
  it('flags non-existent absolute paths', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'See /Users/nobody/nowhere/ghost.txt for details.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const paths = j.errors.filter((e) => e.check === 'path-resolver');
    expect(paths.length).toBe(1);
    expect(paths[0].extracted).toBe('/Users/nobody/nowhere/ghost.txt');
  });

  it('accepts paths that exist', () => {
    const realFile = join(vault, 'real.txt');
    writeFileSync(realFile, 'x');
    writeFileSync(join(vault, 'CLAUDE.md'), `Found at ${realFile}\n`);
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const paths = j.errors.filter((e) => e.check === 'path-resolver');
    expect(paths.length).toBe(0);
  });

  it('skips paths inside triple-backtick fences', () => {
    writeFileSync(join(vault, 'CLAUDE.md'),
      'Example:\n```\n/Users/example/in-fence\n```\nEnd.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const paths = j.errors.filter((e) => e.check === 'path-resolver');
    expect(paths.length).toBe(0);
  });

  it('strips trailing punctuation before existence check', () => {
    const realFile = join(vault, 'real.txt');
    writeFileSync(realFile, 'x');
    writeFileSync(join(vault, 'CLAUDE.md'), `Found at ${realFile}.\n`);
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const pathErrs = j.errors.filter((e) => e.check === 'path-resolver');
    expect(pathErrs.length).toBe(0);
  });

  it('can be disabled with --skip-path-resolver', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '/Users/ghost/nowhere\n');
    const r = runChecker(vault, ['--skip-path-resolver', '--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('path-resolver');
    expect(j.errors.filter((e) => e.check === 'path-resolver').length).toBe(0);
  });
});

describe('check 2: project-count-sync', () => {
  it('flags mismatch between claimed and actual 01-projects/ count', () => {
    mkdirSync(join(vault, '01-projects/alpha'), { recursive: true });
    mkdirSync(join(vault, '01-projects/beta'), { recursive: true });
    writeFileSync(join(vault, 'CLAUDE.md'), 'Currently (5 registered) active projects.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'project-count-sync');
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/claims 5.*actual.*2/);
  });

  it('accepts matching count', () => {
    mkdirSync(join(vault, '01-projects/alpha'), { recursive: true });
    mkdirSync(join(vault, '01-projects/beta'), { recursive: true });
    mkdirSync(join(vault, '01-projects/gamma'), { recursive: true });
    writeFileSync(join(vault, 'CLAUDE.md'), 'Currently (3 projects) active.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'project-count-sync');
    expect(errs.length).toBe(0);
  });

  it('ignores folders starting with _ or .', () => {
    mkdirSync(join(vault, '01-projects/alpha'), { recursive: true });
    mkdirSync(join(vault, '01-projects/_archive'), { recursive: true });
    mkdirSync(join(vault, '01-projects/.hidden'), { recursive: true });
    writeFileSync(join(vault, 'CLAUDE.md'), 'Claim (1 registered).\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'project-count-sync');
    expect(errs.length).toBe(0);
  });

  it('skips when 01-projects/ directory is absent', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'Claim (5 projects).\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_skipped.some((s) => s.startsWith('project-count-sync'))).toBe(true);
    expect(j.errors.filter((e) => e.check === 'project-count-sync').length).toBe(0);
  });
});

describe('check 3: issue-reference-freshness (auto-skip without glab)', () => {
  it('reports skip when glab is absent (skip-issue-refs bypasses)', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '## Backlog\n- #42 foo\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('issue-reference-freshness');
    expect(j.errors.filter((e) => e.check === 'issue-reference-freshness').length).toBe(0);
  });

  it('forward-section heading detection — "What\'s Next" is forward', () => {
    writeFileSync(join(vault, 'CLAUDE.md'),
      '## Recently Closed\n- #100 shipped\n## What\'s Next\n- #200 upcoming\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('ok');
  });
});

describe('check 4: session-file-existence', () => {
  it('flags references to missing session files', () => {
    writeFileSync(join(vault, 'CLAUDE.md'),
      'See [[50-sessions/2026-04-19-feat.md]] for details.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'session-file-existence');
    expect(errs.length).toBe(1);
    expect(errs[0].extracted).toBe('50-sessions/2026-04-19-feat.md');
  });

  it('accepts references to existing session files', () => {
    mkdirSync(join(vault, '50-sessions'), { recursive: true });
    writeFileSync(join(vault, '50-sessions/2026-04-19-feat.md'), '# session\n');
    writeFileSync(join(vault, 'CLAUDE.md'),
      'See [[50-sessions/2026-04-19-feat.md]] for details.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'session-file-existence');
    expect(errs.length).toBe(0);
  });

  it('can be disabled with --skip-session-files', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'See [[50-sessions/2026-04-19-feat.md]]\n');
    const r = runChecker(vault, ['--skip-session-files', '--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('session-file-existence');
    expect(j.errors.filter((e) => e.check === 'session-file-existence').length).toBe(0);
  });
});

describe('include-paths globbing', () => {
  it('scans _meta/**/*.md files by default', () => {
    mkdirSync(join(vault, '_meta/sub'), { recursive: true });
    writeFileSync(join(vault, '_meta/sub/notes.md'), '/Users/ghost/missing\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.files_scanned).toBe(1);
    const errs = j.errors.filter((e) => e.check === 'path-resolver');
    expect(errs.length).toBe(1);
    expect(errs[0].file).toBe('_meta/sub/notes.md');
  });

  it('honors explicit --include-path overrides', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '/Users/ghost/one\n');
    writeFileSync(join(vault, 'README.md'), '/Users/ghost/two\n');
    const r = runChecker(vault, ['--include-path', 'README.md', '--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.files_scanned).toBe(1);
    const files = j.errors.map((e) => e.file);
    expect(files).toContain('README.md');
    expect(files).not.toContain('CLAUDE.md');
  });

  it('reports skipped status when no scope files match', () => {
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('skipped');
    expect(j.files_scanned).toBe(0);
  });
});

describe('infra errors', () => {
  it('returns exit 2 on unknown argument', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# x\n');
    const r = runChecker(vault, ['--not-a-real-flag']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown arg');
  });
});
