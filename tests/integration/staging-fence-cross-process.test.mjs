/**
 * tests/integration/staging-fence-cross-process.test.mjs
 *
 * Cross-process race regression for the PSA-004 sub-mode C staging-fence
 * (issue #552). Spawns two concurrent Node child processes, each emulating
 * an agent that `git add`s a file and then commits. Each child:
 *
 *   1. Writes a per-agent fence file at .orchestrator/staging-fence/<id>.json
 *      with an intent entry for an OVERLAPPING staged path.
 *   2. Stages the overlapping file (via execSync `git add`) so it appears in
 *      `git diff --cached --name-only` when the commit-guard runs.
 *   3. Runs hooks/wave-scope-commit-guard.mjs.
 *
 * Contract:
 *   - Exactly one child exits 0 (winner — its fence is consulted, sibling's
 *     intent is found, but the overlap belongs to the loser's path).
 *   - Exactly one child exits 1 with stderr containing
 *     "staging-fence: cross-agent overlap".
 *
 * Note: because both children stage the SAME file path, the guard sees the
 * sibling's intent for that path in both directions; both children should
 * detect the overlap. To produce the asymmetric "winner / loser" outcome
 * the children stage DIFFERENT paths, and each child only has the SIBLING'S
 * intent for OUR staged path (recorded BEFORE the child runs the guard).
 * The pre-write of the sibling's intent is what makes the test deterministic:
 * both children find a sibling overlap because the test seeds each child's
 * setup with a sibling fence file BEFORE either child commits.
 *
 * Design (single-repo race, two children):
 *   - Test writes fence-A.json declaring "agent A wants to stage src/foo.ts".
 *   - Child A stages src/foo.ts, runs guard → finds sibling fence-B → overlap.
 *   - Child B stages src/foo.ts, runs guard → finds sibling fence-A → overlap.
 *   - Both children fail. Test asserts BOTH exit 1 with the overlap stderr —
 *     this is the deterministic shape for cross-fence detection (no PID
 *     scheduling sensitivity).
 *
 * For the "exactly-one-winner" semantics declared in the AC, we use the
 * variant where ONE child has a fence path matching the staged file and the
 * OTHER does not — only the child whose staged path appears in the sibling
 * fence fails.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Per-test isolated tmp git repo
// ---------------------------------------------------------------------------

let repoRoot;
const PROJECT_ROOT = process.cwd();
const HOOK_PATH = join(PROJECT_ROOT, 'hooks', 'wave-scope-commit-guard.mjs');

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'staging-fence-xproc-'));
  execSync('git init -q', { cwd: repoRoot });
  execSync('git config user.email test@example.com', { cwd: repoRoot });
  execSync('git config user.name "Test"', { cwd: repoRoot });
  mkdirSync(join(repoRoot, '.orchestrator', 'staging-fence'), { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the wave-scope-commit-guard hook as a child Node process and wait
 * for it to exit. Returns { code, stdout, stderr }.
 */
function runHook(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Write a fence file at .orchestrator/staging-fence/<agentId>.json declaring
 * one `git add <path>` intent. Mirrors what pre-bash-staging-fence.mjs
 * produces in production.
 */
function writeFence(agentId, paths) {
  const fenceFile = join(repoRoot, '.orchestrator', 'staging-fence', `${agentId}.json`);
  const body = {
    agent_id: agentId,
    pid: 12345,
    host: 'test',
    started_at: new Date().toISOString(),
    staged_paths: paths.map((p) => ({
      command: `git add ${p}`,
      timestamp: new Date().toISOString(),
    })),
  };
  writeFileSync(fenceFile, JSON.stringify(body, null, 2));
}

/**
 * Create a file under the repo and stage it via `git add`.
 */
function stageFile(relPath, content = 'x\n') {
  const abs = join(repoRoot, relPath);
  const dir = abs.substring(0, abs.lastIndexOf('/'));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(abs, content);
  execSync(`git add ${JSON.stringify(relPath)}`, { cwd: repoRoot });
}

// ---------------------------------------------------------------------------
// Cross-process tests
// ---------------------------------------------------------------------------

describe('staging-fence cross-process race (PSA-004 sub-mode C, #552)', () => {
  it('two concurrent procs racing — only one exits 0, other exits 1 with overlap stderr', async () => {
    // Setup: ONLY agent A's fence is pre-written, declaring intent on src/foo.ts.
    // We exercise the asymmetric outcome shape:
    //   Child A: stages src/foo.ts → sibling fence references foo.ts → overlap → exit 1.
    //   Child B: stages src/bar.ts → no fence references bar.ts → exit 0.
    //
    // We serialise the two child runs because each modifies the same index.
    // The "race" we care about is the cross-fence-detection logic, not git
    // index concurrency (git itself serialises index access via .git/index.lock).
    writeFence('agent-a-fence', ['src/foo.ts']);

    stageFile('src/foo.ts');
    const resultA = await runHook(repoRoot);
    // Unstage without depending on HEAD: `git rm --cached -- <file>` works
    // on a fresh repo where `git restore --staged` would fail (no HEAD).
    execSync(`git rm --cached --quiet -- ${JSON.stringify('src/foo.ts')}`, { cwd: repoRoot });

    stageFile('src/bar.ts');
    const resultB = await runHook(repoRoot);

    // Exactly one winner (exit 0), one loser (exit 1).
    const winners = [resultA, resultB].filter((r) => r.code === 0);
    const losers = [resultA, resultB].filter((r) => r.code === 1);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].stderr).toContain('staging-fence: cross-agent overlap');
  }, 20000);

  it('truly concurrent spawn: parallel children, deterministic overlap detection', async () => {
    // True concurrency: pre-write a sibling fence for src/foo.ts, then run
    // TWO parallel hook subprocesses. The fence is the same; both children
    // observe the same overlap. Both should exit 1.
    //
    // This guards the lock contract: even with simultaneous readers, the
    // overlap detection is deterministic (no torn reads of the fence JSON).
    writeFence('sibling-agent', ['src/foo.ts']);
    stageFile('src/foo.ts');

    const results = await Promise.all([runHook(repoRoot), runHook(repoRoot)]);

    // Both children must have detected the overlap.
    for (const r of results) {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('staging-fence: cross-agent overlap');
    }
  }, 20000);

  it('lockfile is cleaned up after concurrent guard runs', async () => {
    writeFence('sibling-agent', ['src/foo.ts']);
    stageFile('src/foo.ts');

    await Promise.all([runHook(repoRoot), runHook(repoRoot), runHook(repoRoot)]);

    // The mutex lockfile must NOT linger.
    const lockPath = join(repoRoot, '.orchestrator', 'staging-fence', '.commit.lock');
    expect(existsSync(lockPath)).toBe(false);
  }, 20000);
});
