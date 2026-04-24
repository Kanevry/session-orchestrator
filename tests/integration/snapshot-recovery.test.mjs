/**
 * tests/integration/snapshot-recovery.test.mjs
 *
 * Integration tests for scripts/lib/coordinator-snapshot.mjs
 * Covers the full coordinator-snapshot recovery roundtrip:
 *   save -> mutate -> list -> apply stash -> verify content restored
 *
 * Part of v3.1.0 env-aware sessions (issue #196).
 *
 * Each test operates against a fresh git repo in a tmpdir.
 * Tests run serially (describe.sequential) to avoid races.
 * Timeout is 20 s per test to accommodate git I/O.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SNAPSHOT_MODULE = path.join(REPO_ROOT, 'scripts', 'lib', 'coordinator-snapshot.mjs');

// ---------------------------------------------------------------------------
// Git availability guard
// ---------------------------------------------------------------------------

const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
const gitAvailable = gitCheck.status === 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/**
 * Run a git command in the given directory and return trimmed stdout.
 * Throws on non-zero exit.
 *
 * @param {string} repoDir
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {string}
 */
function gitIn(repoDir, args, extraEnv) {
  const result = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, ...TEST_GIT_ENV, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${repoDir}:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Create a temporary git repository with an initial commit containing shared.txt.
 * Having a tracked file allows later tests to produce working-tree mutations that
 * git stash create can capture (stash create requires staged or modified tracked files).
 *
 * Returns the absolute path to the repo.
 *
 * @returns {Promise<string>}
 */
async function makeTempRepo() {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'so-snapshot-test-'));

  gitIn(repoDir, ['init', '-q']);
  gitIn(repoDir, ['config', 'user.email', 'test@example.com']);
  gitIn(repoDir, ['config', 'user.name', 'Test']);
  gitIn(repoDir, ['checkout', '-b', 'main']);

  // Commit a tracked file so later WT modifications are captured by git stash create.
  await writeFile(path.join(repoDir, 'shared.txt'), 'initial-content', 'utf8');
  gitIn(repoDir, ['add', 'shared.txt']);
  gitIn(repoDir, ['commit', '-m', 'initial commit with shared.txt']);

  return repoDir;
}

// ---------------------------------------------------------------------------
// Lifecycle -- track tmpdirs and original cwd for cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];
let origCwd = process.cwd();

afterEach(async () => {
  // Always restore cwd before removing directories.
  try {
    process.chdir(origCwd);
  } catch {
    // Ignore if origCwd was already cleaned up.
  }
  for (const d of tmpDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helper: dynamically import the module under test (cache-busting via query)
// ---------------------------------------------------------------------------

let _importCount = 0;
async function importSnapshot() {
  return import(`${SNAPSHOT_MODULE}?v=${_importCount++}`);
}

// ---------------------------------------------------------------------------
// Integration test suite
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable).sequential('coordinator-snapshot integration tests', { timeout: 20000 }, () => {

  // -------------------------------------------------------------------------
  // 1. save -> mutate -> apply roundtrip restores working-tree state
  // -------------------------------------------------------------------------

  it('save -> mutate -> apply roundtrip restores working-tree state', async () => {
    // Set up repo: commit a.txt so we have a tracked file to modify.
    const repoDir = await mkdtemp(path.join(tmpdir(), 'so-snapshot-test-'));
    tmpDirs.push(repoDir);

    gitIn(repoDir, ['init', '-q']);
    gitIn(repoDir, ['config', 'user.email', 'test@example.com']);
    gitIn(repoDir, ['config', 'user.name', 'Test']);
    gitIn(repoDir, ['checkout', '-b', 'main']);

    await writeFile(path.join(repoDir, 'a.txt'), 'original', 'utf8');
    gitIn(repoDir, ['add', 'a.txt']);
    gitIn(repoDir, ['commit', '-m', 'add a.txt']);

    // Modify a.txt without staging -- this is what the coordinator sees pre-dispatch.
    await writeFile(path.join(repoDir, 'a.txt'), 'modified-by-coordinator', 'utf8');

    // chdir so coordinator-snapshot uses this repo via process.cwd().
    origCwd = process.cwd();
    process.chdir(repoDir);

    const { saveSnapshot, listSnapshots, deleteSnapshot } = await importSnapshot();

    // Save snapshot -- captures the working-tree change.
    const saveResult = await saveSnapshot({ sessionId: 's1', waveN: 1, label: 'pre' });
    expect(saveResult.ok).toBe(true);
    expect(saveResult.skipped).toBeUndefined();
    expect(typeof saveResult.ref).toBe('string');
    expect(typeof saveResult.sha).toBe('string');
    expect(saveResult.sha.length).toBeGreaterThan(0);

    // Simulate crash: restore a.txt to its last committed state (another agent's
    // worktree merge-back discarded the coordinator's unstaged change).
    gitIn(repoDir, ['checkout', '--', 'a.txt']);
    const afterCrash = await readFile(path.join(repoDir, 'a.txt'), 'utf8');
    expect(afterCrash).toBe('original');

    // List snapshots -- should contain the saved entry with correct metadata.
    const listed = await listSnapshots({ sessionId: 's1' });
    expect(listed.length).toBe(1);
    expect(listed[0].sha).toBe(saveResult.sha);
    expect(listed[0].sessionId).toBe('s1');
    expect(listed[0].waveN).toBe(1);
    expect(listed[0].label).toBe('pre');

    // Apply the stash commit to recover the coordinator's working-tree state.
    // Working tree is now clean (a.txt == 'original'), so apply will not conflict.
    const applyResult = spawnSync('git', ['stash', 'apply', saveResult.sha], {
      cwd: repoDir,
      encoding: 'utf8',
      env: { ...process.env, ...TEST_GIT_ENV },
    });
    expect(applyResult.status).toBe(0);

    // Assert a.txt is restored to the coordinator's pre-dispatch content.
    const restored = await readFile(path.join(repoDir, 'a.txt'), 'utf8');
    expect(restored).toBe('modified-by-coordinator');

    // Cleanup: delete the snapshot ref.
    const deleteResult = await deleteSnapshot({ refName: saveResult.ref });
    expect(deleteResult.ok).toBe(true);

    // Verify the ref is gone.
    const afterDelete = await listSnapshots({ sessionId: 's1' });
    expect(afterDelete.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. cross-session isolation
  // -------------------------------------------------------------------------

  it('cross-session isolation -- session A snapshot is not visible to session B filter and vice versa', async () => {
    const repoDir = await makeTempRepo();
    tmpDirs.push(repoDir);

    origCwd = process.cwd();
    process.chdir(repoDir);

    const { saveSnapshot, listSnapshots } = await importSnapshot();

    // Modify the tracked file for session A's snapshot.
    // git stash create requires staged or modified tracked files -- untracked files alone
    // do not produce a stash commit object.
    await writeFile(path.join(repoDir, 'shared.txt'), 'modified-for-session-A', 'utf8');

    const saveA = await saveSnapshot({ sessionId: 'A', waveN: 1, label: 'pre' });
    expect(saveA.ok).toBe(true);
    expect(saveA.skipped).toBeUndefined();
    expect(typeof saveA.sha).toBe('string');

    // Further modify shared.txt -- session B captures this cumulative WT state.
    await writeFile(path.join(repoDir, 'shared.txt'), 'modified-for-session-B', 'utf8');

    const saveB = await saveSnapshot({ sessionId: 'B', waveN: 1, label: 'pre' });
    expect(saveB.ok).toBe(true);
    expect(saveB.skipped).toBeUndefined();
    expect(typeof saveB.sha).toBe('string');

    // Filtered list for A must return only A's snapshot.
    const listA = await listSnapshots({ sessionId: 'A' });
    expect(listA.length).toBe(1);
    expect(listA[0].sessionId).toBe('A');

    // Filtered list for B must return only B's snapshot.
    const listB = await listSnapshots({ sessionId: 'B' });
    expect(listB.length).toBe(1);
    expect(listB[0].sessionId).toBe('B');

    // Unfiltered list must contain both sessions.
    const listAll = await listSnapshots();
    const sessionIds = listAll.map((s) => s.sessionId).sort();
    expect(sessionIds).toContain('A');
    expect(sessionIds).toContain('B');
    expect(listAll.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // 3. gc end-to-end -- expired snapshot is removed, fresh one is retained
  // -------------------------------------------------------------------------

  it('gc end-to-end -- expired snapshot is removed on gc call, fresh snapshot is retained', async () => {
    const repoDir = await makeTempRepo();
    tmpDirs.push(repoDir);

    origCwd = process.cwd();
    process.chdir(repoDir);

    const { saveSnapshot, listSnapshots, gcSnapshots } = await importSnapshot();

    // Step 1: Create a backdated commit object and plant it under the expired session's
    // snapshot ref. Using a regular commit as the ref target works because listSnapshots
    // reads %(committerdate:iso8601) via git for-each-ref -- it does not validate object type.
    const oldSha = gitIn(repoDir, ['commit-tree', '-m', 'expired snapshot', 'HEAD^{tree}'], {
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00+00:00',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00+00:00',
    });
    expect(oldSha.length).toBeGreaterThan(0);

    // Plant the stale ref in the so-snapshots namespace.
    gitIn(repoDir, ['update-ref', 'refs/so-snapshots/expired-sess/wave-1-pre', oldSha]);

    // Step 2: Create one fresh snapshot by modifying the tracked file.
    await writeFile(path.join(repoDir, 'shared.txt'), 'fresh-content', 'utf8');
    const freshSave = await saveSnapshot({ sessionId: 'current', waveN: 1, label: 'pre' });
    expect(freshSave.ok).toBe(true);
    expect(freshSave.skipped).toBeUndefined();

    // Verify both refs exist before gc.
    const beforeGc = await listSnapshots();
    expect(beforeGc.length).toBe(2);

    // Step 3: Run gc -- anything older than 14 days must be deleted.
    // The expired ref has committer date 2020-01-01, well over 14 days ago.
    const gcResult = await gcSnapshots({ olderThanDays: 14 });
    expect(gcResult.ok).toBe(true);
    expect(gcResult.deletedCount).toBe(1);
    expect(gcResult.scanned).toBe(2);

    // Step 4: Expired session ref is gone; fresh session ref remains.
    const expiredAfterGc = await listSnapshots({ sessionId: 'expired-sess' });
    expect(expiredAfterGc.length).toBe(0);

    const currentAfterGc = await listSnapshots({ sessionId: 'current' });
    expect(currentAfterGc.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. clean-tree pre-dispatch -- saveSnapshot returns skipped when nothing to stash
  // -------------------------------------------------------------------------

  it('clean-tree pre-dispatch -- saveSnapshot returns skipped when working tree is clean', async () => {
    const repoDir = await makeTempRepo();
    tmpDirs.push(repoDir);

    // makeTempRepo already commits shared.txt, so the working tree is clean.

    origCwd = process.cwd();
    process.chdir(repoDir);

    const { saveSnapshot, listSnapshots } = await importSnapshot();

    // Working tree is clean -- saveSnapshot must skip without creating a ref.
    const result = await saveSnapshot({ sessionId: 's', waveN: 1, label: 'pre' });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.ref).toBeNull();
    expect(result.sha).toBeNull();

    // listSnapshots for this session must be empty (no ref was created).
    const listed = await listSnapshots({ sessionId: 's' });
    expect(listed.length).toBe(0);
  });
});
