/**
 * tests/lib/learnings/store-lock.test.mjs — the learnings store lock
 * (GitLab #1447 point 8, `withLearningsLock()` in scripts/lib/learnings/io.mjs).
 *
 * Bug pinned: a rewriter (prune / sweep / apply / promote) reads the store,
 * then renames its next generation over it. An `appendLearning()` landing in
 * between was silently lost — no archive line, no error. The rewrite's backup
 * step (`copyFile` of the store) sits inside that window, so the mock below
 * parks the rewriter there and issues the append from the test's own async
 * context (NOT the rewriter's, which would join its lock reentrantly).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Set by a test to intercept the rewrite's backup copy of the store. */
let onStoreBackup = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const copyFile = async (src, dest, ...rest) => {
    if (onStoreBackup && String(src).endsWith('learnings.jsonl')) await onStoreBackup();
    return actual.copyFile(src, dest, ...rest);
  };
  return { ...actual, default: { ...actual, copyFile }, copyFile };
});

const { appendLearning, LearningsLockError } = await import('../../../scripts/lib/learnings/io.mjs');
const { pruneLearnings } = await import('../../../scripts/lib/learnings/expiry-sweep.mjs');
const { tryAcquireFileLock, releaseFileLock } = await import('../../../scripts/lib/file-lock.mjs');

const DAY_MS = 86400000;

function learning(id) {
  return {
    id,
    type: 'recurring-issue',
    subject: `subject-${id}`,
    insight: `insight ${id}`,
    evidence: `evidence ${id}`,
    confidence: 0.6,
    source_session: 'sess-1',
    created_at: new Date(Date.now() - DAY_MS).toISOString(),
    expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
  };
}

const idsIn = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).id);

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'learnings-lock-'));
  store = join(dir, 'learnings.jsonl');
  writeFileSync(store, `${JSON.stringify(learning('kept-1'))}\n`);
});

afterEach(() => {
  onStoreBackup = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('learnings store lock', () => {
  it('an append issued between a rewriter read and its rename survives the rewrite', async () => {
    let reachedBackup;
    const atBackup = new Promise((resolve) => { reachedBackup = resolve; });
    let releaseBackup;
    const backupReleased = new Promise((resolve) => { releaseBackup = resolve; });
    onStoreBackup = async () => {
      onStoreBackup = null; // the append's own path never copies, but stay one-shot
      reachedBackup();
      await backupReleased;
    };

    const rewrite = pruneLearnings({ filePath: store, archivePath: join(dir, 'archive.jsonl'), dryRun: false });
    await atBackup; // the rewriter has read the store and holds its next generation

    const append = appendLearning(store, learning('appended-mid-rewrite'));
    // Unlocked, the append lands at once; locked, it waits for the rewrite.
    await Promise.race([append, new Promise((r) => setTimeout(r, 250))]);
    releaseBackup();
    await Promise.all([rewrite, append]);

    expect(idsIn(store).sort()).toEqual(['appended-mid-rewrite', 'kept-1']);
  });

  it('a held lock times out the append with a LearningsLockError and writes nothing', async () => {
    const lockPath = join(realpathSync(dir), 'learnings.jsonl.lock');
    const holder = 'test-holder';
    expect(tryAcquireFileLock(lockPath, { holder }).acquired).toBe(true);
    const before = readFileSync(store, 'utf8');
    try {
      const err = await appendLearning(store, learning('blocked'), { lockTimeoutMs: 150 }).catch((e) => e);
      expect(err).toBeInstanceOf(LearningsLockError);
      expect(err.message).toContain(lockPath);
      expect(readFileSync(store, 'utf8')).toBe(before);
    } finally {
      releaseFileLock(lockPath, { holder });
    }
  });
});
