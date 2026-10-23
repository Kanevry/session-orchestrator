/**
 * tests/lib/validate/check-test-posix-shell.test.mjs
 *
 * Tests for scripts/lib/validate/check-test-posix-shell.mjs (#1613). The bug the
 * check exists to catch: a test spawns `sh`/`bash` by bare name and is red on
 * native Windows, where sh is not on PATH and bash is WSL. Each case below runs
 * the real CLI against a tmp fixture tree (not a git toplevel, so the checker's
 * file walk is used) and names the regression it guards.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCheckTestPosixShell } from '@lib/validate/check-test-posix-shell.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-test-posix-shell.mjs');

const tmpRoots = [];
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

/** @param {Record<string, string>} files repo-relative path → content */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-test-posix-shell-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

/** The shipped CLI, with the shipped baseline. */
function runCli(root) {
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', timeout: 30_000 });
}

/** In-process with an EMPTY baseline, so a fixture need not carry the three baselined files. */
function run(root) {
  const lines = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)); });
  try {
    const status = runCheckTestPosixShell(root, { baseline: new Map() });
    return { status, stdout: lines.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

const HEADER = "import { spawnSync } from 'node:child_process';\n";

describe('check-test-posix-shell', () => {
  it('FAILs a new bare spawnSync(\'sh\', …) in a test file', () => {
    const r = run(fixture({ 'tests/a.test.mjs': `${HEADER}spawnSync('sh', ['-c', 'true']);\n` }));
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/FAIL: tests\/a\.test\.mjs:2 — spawnSync\('sh'/);
  });

  it('passes the same call routed through posixShell()', () => {
    const r = run(fixture({
      'tests/a.test.mjs': `${HEADER}import { posixShell } from './_helpers/posix-shell.mjs';\nspawnSync(posixShell('sh'), ['-c', 'true']);\n`,
    }));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/FAIL:|WARN:/);
  });

  it('WARNs, but does not FAIL, on a baselined file', () => {
    const r = runCli(fixture({
      'tests/so-hud/rules.test.mjs': `${HEADER}spawnSync("bash", ['-c', 'true']);\n`,
      'tests/skills/tmux-layout.test.mjs': `${HEADER}spawnSync('/bin/sh', ['-c', 'true']);\n`,
      'tests/scripts/sweep-expired-learnings-cli.test.mjs': `${HEADER}spawnSync(\`bash\`, ['-c', 'true']);\n`,
    }));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout.match(/WARN:/g)).toHaveLength(3);
    expect(r.stdout).not.toMatch(/FAIL:/);
  });

  it('FAILs a baseline entry whose file no longer has a bare spawn (baseline-stale)', () => {
    // Bug: a converted file keeps its exemption forever, so a later bare spawn
    // in it is only ever a WARN.
    const root = fixture({ 'tests/converted.test.mjs': `${HEADER}spawnSync(posixShell('sh'), ['-c', 'true']);\n` });
    const lines = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)); });
    let status;
    try {
      status = runCheckTestPosixShell(root, { baseline: new Map([['tests/converted.test.mjs', '#1613: test entry']]) });
    } finally {
      spy.mockRestore();
    }
    expect(status, lines.join('\n')).toBe(1);
    expect(lines.join('\n')).toMatch(/tests\/converted\.test\.mjs.*baseline-stale|baseline-stale.*tests\/converted\.test\.mjs/);
  });

  it('does not report a commented-out bare spawn', () => {
    const r = run(fixture({
      'tests/a.test.mjs': `${HEADER}// spawnSync('sh', ['-c', 'true']);\n/* execFileSync('/bin/bash', []); */\n`,
    }));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/FAIL:/);
  });

  it('exempts the posixShell helper itself', () => {
    const r = run(fixture({ 'tests/_helpers/posix-shell.mjs': `${HEADER}spawnSync('sh', ['-c', 'true']);\n` }));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/FAIL:/);
  });
});
