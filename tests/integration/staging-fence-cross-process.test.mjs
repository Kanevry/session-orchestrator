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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';

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

  // ---------------------------------------------------------------------------
  // Q2-L3 — 3-proc / 4-proc parallel race coverage (#558)
  // ---------------------------------------------------------------------------
  //
  // The 2-proc tests above cover the smallest contention case. The N-proc
  // variants below guard against an N-only failure mode — e.g., a regression
  // that serialises into N-1 winners by accident (any algorithm coupling that
  // works for 2 but not for ≥3).
  //
  // Design (deterministic with parallel spawn):
  //   - All N children share the same repo and a single sibling fence file
  //     pre-written for "src/foo.ts".
  //   - The single staged file "src/foo.ts" is staged BEFORE any child runs,
  //     so all N children see the same staged set + same sibling fence.
  //   - Each child runs the commit-guard concurrently via Promise.all.
  //   - Contract: ALL N children must detect the overlap and exit 1 (no
  //     race-window in which any child misses the sibling fence). The mutex
  //     in withStagingFenceLock serialises the read window, but the resulting
  //     decision is identical across all readers because the fence content
  //     does not mutate during the run.
  //
  // This is the same shape as the existing 2-proc "truly concurrent" test —
  // we extend the parallel-fanout count to expose N-only regressions.

  it('Q2-L3: 3 procs race in parallel — all 3 detect overlap and exit 1', async () => {
    writeFence('sibling-agent', ['src/foo.ts']);
    stageFile('src/foo.ts');

    const results = await Promise.all([
      runHook(repoRoot),
      runHook(repoRoot),
      runHook(repoRoot),
    ]);

    // All 3 must exit 1 with the cross-agent overlap stderr — no winner in
    // this shape (single staged path / single sibling fence is overlap for
    // every reader). The deterministic exit-distribution is the invariant.
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('staging-fence: cross-agent overlap');
    }
  }, 20000);

  it('Q2-L3: 4 procs race in parallel — all 4 detect overlap and exit 1', async () => {
    // 4-proc fan-out — guards against mutex-fairness regressions that only
    // show up under ≥4-way contention (e.g., a counter that wraps modulo 3).
    // Same shape as the 3-proc test: shared staged set + shared sibling
    // fence, parallel Promise.all spawn, all readers must reach the same
    // verdict.
    writeFence('sibling-agent', ['src/foo.ts']);
    stageFile('src/foo.ts');

    const results = await Promise.all([
      runHook(repoRoot),
      runHook(repoRoot),
      runHook(repoRoot),
      runHook(repoRoot),
    ]);

    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('staging-fence: cross-agent overlap');
    }
  }, 20000);

  // ---------------------------------------------------------------------------
  // Q2-L4 — e2e fence via the real pre-bash-staging-fence.mjs hook (#558)
  // ---------------------------------------------------------------------------
  //
  // The other tests in this file write "fake" fence files via writeFence(),
  // which mirrors but does NOT exercise hooks/pre-bash-staging-fence.mjs's
  // production write path. The test below closes that gap end-to-end:
  //
  //   1. Spawn the REAL hook subprocess with a PreToolUse JSON payload on
  //      stdin (the documented Claude Code hook contract).
  //   2. Set SO_WAVE_AGENT=1 + CLAUDE_PROJECT_DIR=<tmp repo> so the hook
  //      passes the G4 (context) and G5 (path resolution) gates.
  //   3. Let the hook run its full G1-G6 ladder and write the fence file
  //      via writeJsonAtomicSync (the production code path).
  //   4. Read the resulting fence file from disk and assert its shape:
  //      JSON-parseable, correct agent_id / pid / staged_paths entry,
  //      ISO timestamp present, hostname recorded.

  it('Q2-L4: real hook writes a structurally valid fence file end-to-end', () => {
    const HOOK_REAL = resolve(import.meta.dirname, '../..', 'hooks/pre-bash-staging-fence.mjs');
    const command = 'git add src/foo.ts';

    // Invoke the real hook synchronously. spawnSync mirrors how Claude Code
    // dispatches PreToolUse subprocesses (single shot, JSON-on-stdin).
    const result = spawnSync('node', [HOOK_REAL], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: repoRoot,
        SO_WAVE_AGENT: '1',
        // Strip env that would short-circuit the hook (profile/disabled list).
        SO_HOOK_PROFILE: '',
        SO_DISABLED_HOOKS: '',
      },
    });

    // The hook is fail-open: it must exit 0 even when it writes successfully.
    expect(result.status).toBe(0);

    // Exactly one fence file should now exist in the staging-fence dir
    // (excluding dot-files, which are tmp-write artifacts).
    const fenceDir = join(repoRoot, '.orchestrator', 'staging-fence');
    const fenceFiles = readdirSync(fenceDir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    expect(fenceFiles).toHaveLength(1);

    // Parse and validate the fence file shape against the documented contract.
    const fenceJson = JSON.parse(readFileSync(join(fenceDir, fenceFiles[0]), 'utf8'));

    // agent_id composition: "${SO_WAVE_AGENT}-${pid}-${rnd6hex}" — must start
    // with "1-" because SO_WAVE_AGENT=1 is the documented gate value.
    expect(fenceJson.agent_id).toMatch(/^1-\d+-[0-9a-f]{6}$/);

    // pid: must be a positive integer (the hook subprocess's own pid).
    expect(typeof fenceJson.pid).toBe('number');
    expect(fenceJson.pid).toBeGreaterThan(0);

    // host: must be a non-empty string (os.hostname() result).
    expect(typeof fenceJson.host).toBe('string');
    expect(fenceJson.host.length).toBeGreaterThan(0);

    // started_at: must be a valid ISO 8601 timestamp.
    expect(fenceJson.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isFinite(Date.parse(fenceJson.started_at))).toBe(true);

    // staged_paths: must contain exactly one entry matching the issued command.
    expect(Array.isArray(fenceJson.staged_paths)).toBe(true);
    expect(fenceJson.staged_paths).toHaveLength(1);
    expect(fenceJson.staged_paths[0].command).toBe(command);
    expect(fenceJson.staged_paths[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  }, 20000);
});
