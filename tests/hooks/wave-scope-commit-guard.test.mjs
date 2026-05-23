/**
 * tests/hooks/wave-scope-commit-guard.test.mjs
 *
 * Regression tests for hooks/wave-scope-commit-guard.mjs — PSA-004 sub-mode B
 * commit-time guard that catches lint-staged sweep violations after the
 * PreToolUse Edit/Write gate has already passed.
 *
 * Strategy: spawn the hook as a subprocess inside a real tmp git repo
 * (NOT mocked — anti-test-the-mock per .claude/rules/test-quality.md),
 * stage files via `git add`, optionally write .orchestrator/wave-scope.json,
 * then assert exit code + stderr.
 *
 * Issue: #495 (PSA-004 sub-mode B)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(REPO_ROOT, 'hooks/wave-scope-commit-guard.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook with CWD set to the tmp repo. The hook resolves repoRoot
 * via `git rev-parse --show-toplevel`, so the tmp repo must be a real git
 * repo. Returns { code, stdout, stderr }.
 */
async function runHook(cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

/**
 * Create a fresh tmp git repo. Returns its absolute path.
 */
async function mkRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave-commit-guard-test-'));
  execSync('git init -q', { cwd: dir });
  // git config a user — needed so future `git commit` calls would work, but
  // we only use `git add` + `git diff --cached` here. Defensive belt-and-braces.
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  return dir;
}

/**
 * Write a wave-scope.json under .orchestrator/ inside the repo.
 */
async function writeScope(repoDir, scope) {
  const dir = path.join(repoDir, '.orchestrator');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'wave-scope.json'), scope);
}

/**
 * Create a file under the repo and `git add` it.
 */
async function stageFile(repoDir, relPath, content = 'x\n') {
  const abs = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  execSync(`git add ${JSON.stringify(relPath)}`, { cwd: repoDir });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkRepoTracked() {
  const dir = await mkRepo();
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Test cases (per task spec)
// ---------------------------------------------------------------------------

describe('wave-scope-commit-guard — PSA-004 sub-mode B', { timeout: 15000 }, () => {
  it('exits 0 with no output when no wave-scope.json present (no active wave)', async () => {
    const dir = await mkRepoTracked();
    await stageFile(dir, 'src/app.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 when wave-scope.json has empty allowedPaths (permissive default)', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: [] }));
    await stageFile(dir, 'README.md');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
  });

  it('exits 0 when all staged paths are inside allowedPaths', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/', 'lib/'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'lib/util.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 1 with stderr listing the path + restore hint when one staged path is outside allowedPaths', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'tests/foreign.test.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('wave-scope-commit-guard');
    expect(result.stderr).toContain('tests/foreign.test.ts');
    // src/app.ts is in-scope, must NOT appear in the violation list
    expect(result.stderr).not.toContain('  - src/app.ts');
    // Restore hint must be present
    expect(result.stderr).toContain('git restore --staged');
  });

  it('exits 1 with parse error when wave-scope.json is malformed', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, '{ not valid json');
    await stageFile(dir, 'src/app.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('wave-scope-commit-guard');
    expect(result.stderr).toContain('failed to parse wave-scope.json');
  });
});
