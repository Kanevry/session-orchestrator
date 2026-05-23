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
import { performance } from 'node:perf_hooks';
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

// ---------------------------------------------------------------------------
// G-M1 + G-L2 coverage gap tests (#553)
// ---------------------------------------------------------------------------

describe('wave-scope-commit-guard — #553 G-M1 coverage gaps', { timeout: 20000 }, () => {
  // G-M1.a — concurrent git-add race (no false positive from interleaving)
  it('two concurrent hook subprocesses on disjoint scopes do not falsely interfere', async () => {
    // Two separate tmp repos run the hook in parallel. The hook reads from
    // its own tmp repo's wave-scope.json and only walks its own fence dir;
    // there must be no cross-talk between the two child processes.
    const dirA = await mkRepoTracked();
    const dirB = await mkRepoTracked();
    await writeScope(dirA, JSON.stringify({ allowedPaths: ['src/'] }));
    await writeScope(dirB, JSON.stringify({ allowedPaths: ['lib/'] }));
    await stageFile(dirA, 'src/a.ts');
    await stageFile(dirB, 'lib/b.ts');

    const [resultA, resultB] = await Promise.all([runHook(dirA), runHook(dirB)]);

    expect(resultA.code).toBe(0);
    expect(resultB.code).toBe(0);
  });

  // G-M1.b — gitignored path: `git diff --cached` already excludes ignored
  // files. Even if a gitignored path appears in allowedPaths the guard never
  // sees it among staged files. We verify two things:
  //   1) Without -f, `git add` of an ignored file fails (git's built-in safety).
  //   2) The guard sees only the tracked, in-scope files and exits 0.
  it('gitignored paths are silently excluded by git diff --cached (no false positive)', async () => {
    const dir = await mkRepoTracked();
    // Write a .gitignore that ignores tmp/ — but stage nothing from .gitignore yet.
    await fs.writeFile(path.join(dir, '.gitignore'), 'tmp/\n');
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await stageFile(dir, 'src/app.ts');

    // Create a gitignored file and try to stage it explicitly. git refuses
    // without -f. The file therefore NEVER appears in `git diff --cached`.
    const ignored = path.join(dir, 'tmp', 'ignored.txt');
    await fs.mkdir(path.dirname(ignored), { recursive: true });
    await fs.writeFile(ignored, 'secret');
    let addSucceeded = true;
    try {
      execSync('git add tmp/ignored.txt', { cwd: dir, stdio: 'pipe' });
    } catch {
      addSucceeded = false;
    }
    expect(addSucceeded).toBe(false);

    const result = await runHook(dir);
    // Only src/app.ts is in the cached set; it is in scope → exit 0.
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  // G-M1.c — glob edge cases: trailing slash + nested glob pattern
  it('trailing-slash directory pattern matches both files at the prefix and deep descendants', async () => {
    const dir = await mkRepoTracked();
    // Pattern 'src/' must match 'src/app.ts' AND 'src/utils/format.ts'.
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'src/utils/format.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('directory pattern WITHOUT trailing slash does NOT auto-match descendants', async () => {
    const dir = await mkRepoTracked();
    // 'src' (no slash) is treated as a literal path by pathMatchesPattern's
    // exact-match branch; 'src/app.ts' does NOT match 'src'.
    // This documents the existing behavior — operators must add trailing slash
    // or a recursive glob to allow descendants.
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src'] }));
    await stageFile(dir, 'src/app.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('src/app.ts');
  });

  it('nested recursive glob pattern src/**/*.ts matches deep descendants', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/**/*.ts'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'src/utils/helpers/format.ts');
    const result = await runHook(dir);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('nested recursive glob pattern src/**/*.ts rejects non-.ts files even when nested', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/**/*.ts'] }));
    await stageFile(dir, 'src/app.ts');
    await stageFile(dir, 'src/utils/data.json');
    const result = await runHook(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('src/utils/data.json');
  });
});

describe('wave-scope-commit-guard — #553 G-L2 performance bound', { timeout: 30000 }, () => {
  // G-L2 — stage 500 files (mix in/out scope); assert exit + duration < 2s
  it('completes 500-file scan in under 2 seconds (perf bound)', async () => {
    const dir = await mkRepoTracked();
    await writeScope(dir, JSON.stringify({ allowedPaths: ['src/'] }));

    // Stage 250 in-scope + 250 out-of-scope = 500 total.
    // Use a single `git add` call after writing all files to minimise setup time.
    const srcDir = path.join(dir, 'src');
    const otherDir = path.join(dir, 'other');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    const writes = [];
    for (let i = 0; i < 250; i++) {
      writes.push(fs.writeFile(path.join(srcDir, `f${i}.ts`), 'x'));
      writes.push(fs.writeFile(path.join(otherDir, `f${i}.ts`), 'x'));
    }
    await Promise.all(writes);
    execSync('git add src/ other/', { cwd: dir });

    const start = performance.now();
    const result = await runHook(dir);
    const elapsedMs = performance.now() - start;

    // Exit 1 because 250 out-of-scope files violate.
    expect(result.code).toBe(1);
    // Performance bound: 500-file scan must complete in under 2 seconds.
    expect(elapsedMs).toBeLessThan(2000);
  });
});
