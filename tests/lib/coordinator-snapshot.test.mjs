/**
 * tests/lib/coordinator-snapshot.test.mjs
 *
 * Vitest unit tests for scripts/lib/coordinator-snapshot.mjs
 * Issue #196 — pre-dispatch coordinator snapshot helpers.
 *
 * Each test operates against a real git repo created in a tmpdir.
 * Tests run serially (describe.sequential) to avoid races on shared git refs.
 * Timeout is 15 s per test to accommodate git I/O.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';

vi.setConfig({ testTimeout: 15000 });

// ---------------------------------------------------------------------------
// Skip gracefully when git is not available
// ---------------------------------------------------------------------------

const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
const gitAvailable = gitCheck.status === 0;

// ---------------------------------------------------------------------------
// Import module under test once (cached; uses process.cwd() at call time)
// ---------------------------------------------------------------------------

import {
  saveSnapshot,
  listSnapshots,
  deleteSnapshot,
  gcSnapshots,
} from '../../scripts/lib/coordinator-snapshot.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/**
 * Run a git command synchronously inside `cwd`, return trimmed stdout.
 * Throws on non-zero exit.
 */
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Same as git() but with backdated author + committer date.
 */
function gitBackdated(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      GIT_AUTHOR_DATE: '2020-01-01T12:00:00+0000',
      GIT_COMMITTER_DATE: '2020-01-01T12:00:00+0000',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git(backdated) ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Create a minimal git repo with one commit. Returns realpath of repoDir.
 */
async function makeTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'so-snapshot-'));
  const repoDir = await realpath(dir);

  git(repoDir, 'init', '-q');
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test');
  git(repoDir, 'checkout', '-b', 'main');
  writeFileSync(path.join(repoDir, 'README.md'), 'init\n', 'utf8');
  git(repoDir, 'add', 'README.md');
  git(repoDir, 'commit', '-m', 'init', '--allow-empty');

  return repoDir;
}

/**
 * List all refs under refs/so-snapshots/ in repoDir.
 * Uses `git for-each-ref` which supports prefix filtering correctly.
 */
function listSnapshotRefs(repoDir) {
  const result = spawnSync(
    'git',
    ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/so-snapshots/'],
    { cwd: repoDir, encoding: 'utf8', env: GIT_ENV }
  );
  // for-each-ref exits 0 even when nothing matches.
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const spaceIdx = line.indexOf(' ');
      const sha = line.slice(0, spaceIdx);
      const ref = line.slice(spaceIdx + 1);
      return { sha, ref };
    });
}

// ---------------------------------------------------------------------------
// Test suite — sequential to avoid git concurrency issues
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable).sequential('coordinator-snapshot', () => {
  let repoDir;
  let origCwd;

  beforeEach(async () => {
    origCwd = process.cwd();
    repoDir = await makeTempRepo();
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(repoDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: save — clean tree is a no-op
  // -------------------------------------------------------------------------

  it('save: clean tree returns {ok:true, skipped:true, ref:null, sha:null}', async () => {
    const result = await saveSnapshot({ sessionId: 'sess-1', waveN: 1 });

    expect(result).toEqual({ ok: true, skipped: true, ref: null, sha: null });

    const refs = listSnapshotRefs(repoDir);
    expect(refs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 2: save — dirty tree captures stash commit, persists ref, tree unchanged
  // -------------------------------------------------------------------------

  it('save: dirty tree creates ref and does not modify the working tree', async () => {
    const filePath = path.join(repoDir, 'README.md');
    writeFileSync(filePath, 'modified content\n', 'utf8');

    const result = await saveSnapshot({ sessionId: 'sess-dirty', waveN: 2, label: 'pre' });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(typeof result.sha).toBe('string');
    expect(result.sha.length).toBeGreaterThan(0);
    expect(result.ref).toBe('refs/so-snapshots/sess-dirty/wave-2-pre');

    // Ref must exist in git.
    const refs = listSnapshotRefs(repoDir);
    expect(refs.some(r => r.ref === 'refs/so-snapshots/sess-dirty/wave-2-pre')).toBe(true);

    // Working tree must be UNCHANGED — stash create must not touch the tree.
    const { readFileSync } = await import('node:fs');
    const currentContent = readFileSync(filePath, 'utf8');
    expect(currentContent).toBe('modified content\n');
  });

  // -------------------------------------------------------------------------
  // Test 3a: save — empty sessionId fails gracefully (no throw)
  // -------------------------------------------------------------------------

  it('save: empty sessionId returns {ok:false} without throwing', async () => {
    const result = await saveSnapshot({ sessionId: '', waveN: 1 });

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.ref).toBeNull();
    expect(result.sha).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 3b: save — whitespace-only sessionId fails gracefully (no throw)
  // -------------------------------------------------------------------------

  it('save: whitespace-only sessionId returns {ok:false} without throwing', async () => {
    const result = await saveSnapshot({ sessionId: '   ', waveN: 1 });

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.ref).toBeNull();
    expect(result.sha).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 4: save — special chars in sessionId are sanitized to safe ref name
  // -------------------------------------------------------------------------

  it('save: sessionId with special chars produces sanitized ref name', async () => {
    writeFileSync(path.join(repoDir, 'README.md'), 'changed for special chars\n', 'utf8');

    const result = await saveSnapshot({ sessionId: 'feat/branch-42#foo', waveN: 1, label: 'pre' });

    expect(result.ok).toBe(true);
    expect(result.ref).toBe('refs/so-snapshots/feat-branch-42-foo/wave-1-pre');

    const refs = listSnapshotRefs(repoDir);
    expect(refs.some(r => r.ref === 'refs/so-snapshots/feat-branch-42-foo/wave-1-pre')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: list — empty namespace returns []
  // -------------------------------------------------------------------------

  it('list: no snapshots → returns empty array', async () => {
    const result = await listSnapshots();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 6: list — 3 saves across 2 sessions; filter by sessionId works
  // -------------------------------------------------------------------------

  it('list: 3 saves across 2 sessions; listSnapshots returns all 3, filter returns 2', async () => {
    writeFileSync(path.join(repoDir, 'README.md'), 'dirty-A1\n', 'utf8');
    const r1 = await saveSnapshot({ sessionId: 'sessA', waveN: 1, label: 'pre' });
    expect(r1.ok).toBe(true);
    expect(r1.skipped).toBeUndefined();

    writeFileSync(path.join(repoDir, 'README.md'), 'dirty-A2\n', 'utf8');
    const r2 = await saveSnapshot({ sessionId: 'sessA', waveN: 2, label: 'pre' });
    expect(r2.ok).toBe(true);
    expect(r2.skipped).toBeUndefined();

    writeFileSync(path.join(repoDir, 'README.md'), 'dirty-B1\n', 'utf8');
    const r3 = await saveSnapshot({ sessionId: 'sessB', waveN: 1, label: 'pre' });
    expect(r3.ok).toBe(true);
    expect(r3.skipped).toBeUndefined();

    const all = await listSnapshots();
    expect(all).toHaveLength(3);

    const filteredA = await listSnapshots({ sessionId: 'sessA' });
    expect(filteredA).toHaveLength(2);
    expect(filteredA.every(s => s.sessionId === 'sessA')).toBe(true);

    const filteredB = await listSnapshots({ sessionId: 'sessB' });
    expect(filteredB).toHaveLength(1);
    expect(filteredB[0].sessionId).toBe('sessB');
  });

  // -------------------------------------------------------------------------
  // Test 7: list — sort order is waveN DESC
  // -------------------------------------------------------------------------

  it('list: snapshots sorted by waveN descending — [10, 2, 1]', async () => {
    writeFileSync(path.join(repoDir, 'README.md'), 'wave1\n', 'utf8');
    await saveSnapshot({ sessionId: 'sort-sess', waveN: 1, label: 'pre' });

    writeFileSync(path.join(repoDir, 'README.md'), 'wave10\n', 'utf8');
    await saveSnapshot({ sessionId: 'sort-sess', waveN: 10, label: 'pre' });

    writeFileSync(path.join(repoDir, 'README.md'), 'wave2\n', 'utf8');
    await saveSnapshot({ sessionId: 'sort-sess', waveN: 2, label: 'pre' });

    const results = await listSnapshots({ sessionId: 'sort-sess' });

    expect(results).toHaveLength(3);
    expect(results[0].waveN).toBe(10);
    expect(results[1].waveN).toBe(2);
    expect(results[2].waveN).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 8: list — malformed ref (no slash after sessionId) is skipped, no throw
  // -------------------------------------------------------------------------

  it('list: malformed ref with no wave part is skipped without throwing', async () => {
    const headSha = git(repoDir, 'rev-parse', 'HEAD');
    // Manually create a ref that has no '/<wave-part>' after the sessionId segment.
    git(repoDir, 'update-ref', 'refs/so-snapshots/just-a-thing', headSha);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let results;
    try {
      results = await listSnapshots();
    } finally {
      consoleSpy.mockRestore();
    }

    expect(Array.isArray(results)).toBe(true);
    // The malformed ref must NOT appear in results.
    expect(results.every(s => s.ref !== 'refs/so-snapshots/just-a-thing')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 9: delete — idempotent; second delete still returns ok:true
  // -------------------------------------------------------------------------

  it('delete: deleteSnapshot is idempotent — second call on deleted ref still ok:true', async () => {
    writeFileSync(path.join(repoDir, 'README.md'), 'for-delete\n', 'utf8');
    const saved = await saveSnapshot({ sessionId: 'del-sess', waveN: 1, label: 'pre' });
    expect(saved.ok).toBe(true);
    expect(saved.ref).toBe('refs/so-snapshots/del-sess/wave-1-pre');

    const first = await deleteSnapshot({ refName: saved.ref });
    expect(first.ok).toBe(true);

    // Ref must be gone after first delete.
    const refsAfterFirst = listSnapshotRefs(repoDir);
    expect(refsAfterFirst.some(r => r.ref === saved.ref)).toBe(false);

    // Second delete on the same (now-missing) ref.
    const second = await deleteSnapshot({ refName: saved.ref });
    expect(second.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 10: delete — ref that was never created does not throw
  // -------------------------------------------------------------------------

  it('delete: non-existent ref name does not throw and returns an object with ok field', async () => {
    const refName = 'refs/so-snapshots/never-existed/wave-1-pre';

    let result;
    try {
      result = await deleteSnapshot({ refName });
    } catch {
      throw new Error('deleteSnapshot threw instead of returning a result object');
    }

    expect(typeof result).toBe('object');
    expect(typeof result.ok).toBe('boolean');
    // ok:true is expected (git update-ref -d is idempotent on missing refs),
    // but ok:false is also acceptable as long as no exception was thrown.
  });

  // -------------------------------------------------------------------------
  // Test 11: gc — no expired refs → deletedCount:0, scanned:1
  // -------------------------------------------------------------------------

  it('gc: fresh snapshot is not deleted; deletedCount:0, scanned:1', async () => {
    writeFileSync(path.join(repoDir, 'README.md'), 'for-gc-fresh\n', 'utf8');
    const saved = await saveSnapshot({ sessionId: 'gc-fresh', waveN: 1, label: 'pre' });
    expect(saved.ok).toBe(true);
    expect(saved.skipped).toBeUndefined();

    const gcResult = await gcSnapshots({ olderThanDays: 14 });

    expect(gcResult.ok).toBe(true);
    expect(gcResult.deletedCount).toBe(0);
    expect(gcResult.scanned).toBe(1);

    // Ref must still exist.
    const refs = listSnapshotRefs(repoDir);
    expect(refs.some(r => r.ref === saved.ref)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 12: gc — refs pointing at backdated commits are deleted
  // -------------------------------------------------------------------------

  it('gc: ref pointing at a backdated commit is deleted when threshold exceeded', async () => {
    // Create a backdated commit (committer-date 2020-01-01, well past 14-day threshold).
    writeFileSync(path.join(repoDir, 'old.txt'), 'old content\n', 'utf8');
    git(repoDir, 'add', 'old.txt');
    gitBackdated(repoDir, 'commit', '-m', 'old commit');
    // `git commit` output includes a summary line, not a SHA — get the SHA separately.
    const oldSha = git(repoDir, 'rev-parse', 'HEAD');

    // Point a snapshot ref at the old commit.
    git(repoDir, 'update-ref', 'refs/so-snapshots/old-sess/wave-1-pre', oldSha);

    // Ref must exist before gc.
    const refsBeforeGc = listSnapshotRefs(repoDir);
    expect(refsBeforeGc.some(r => r.ref === 'refs/so-snapshots/old-sess/wave-1-pre')).toBe(true);

    const gcResult = await gcSnapshots({ olderThanDays: 14 });

    expect(gcResult.ok).toBe(true);
    expect(gcResult.scanned).toBe(1);
    expect(gcResult.deletedCount).toBe(1);

    // Ref must be gone after gc.
    const refsAfterGc = listSnapshotRefs(repoDir);
    expect(refsAfterGc.some(r => r.ref === 'refs/so-snapshots/old-sess/wave-1-pre')).toBe(false);
  });
});
