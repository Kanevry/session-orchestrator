/**
 * tests/lib/learnings/store-lock.test.mjs — the learnings store lock
 * (GitLab #1447 point 8, `withLearningsLock()` in scripts/lib/learnings/io.mjs).
 *
 * Bug pinned: a rewriter (prune / sweep / promote) reads the store, then
 * renames its next generation over it. An `appendLearning()` landing in
 * between was silently lost — no archive line, no error. The mock below parks
 * the rewriter right AFTER its read of the store returned (so it already holds
 * the stale generation) and issues the append from the test's own async
 * context (NOT the rewriter's, which would join its lock reentrantly).
 *
 * Parking inside `rewriteLearnings()` instead (e.g. at its backup copy) cannot
 * see the read window: `rewriteLearnings()` takes the lock itself, so the
 * append waits there even when the rewriter's own lock around the read is gone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Set by a test to park the rewriter just after its read of the store. */
let onStoreRead = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const readFile = async (file, ...rest) => {
    const content = await actual.readFile(file, ...rest);
    if (onStoreRead && String(file).endsWith('learnings.jsonl')) await onStoreRead();
    return content;
  };
  return { ...actual, default: { ...actual, readFile }, readFile };
});

const { appendLearning, LearningsLockError } = await import('../../../scripts/lib/learnings/io.mjs');
const { pruneLearnings, sweepExpiredLearnings } = await import('../../../scripts/lib/learnings/expiry-sweep.mjs');
const { promoteHwLearnings } = await import('../../../scripts/export-hw-learnings.mjs');
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

/** A private hardware-pattern record — the only input promote rewrites for. */
function privateHwLearning(id) {
  return {
    ...learning(id),
    type: 'hardware-pattern',
    subject: 'oom-kill::macos-arm64-m3pro',
    evidence: 'signal=oom-kill, occurrences=3',
    scope: 'private',
    host_class: 'macos-arm64-m3pro',
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
  onStoreRead = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('learnings store lock', () => {
  it.each([
    [
      'pruneLearnings',
      [],
      (file, d) => pruneLearnings({ filePath: file, archivePath: join(d, 'archive.jsonl'), dryRun: false }),
      ['appended-mid-rewrite', 'kept-1'],
    ],
    [
      'sweepExpiredLearnings',
      [],
      (file, d) => sweepExpiredLearnings({ filePath: file, archivePath: join(d, 'archive.jsonl'), dryRun: false }),
      ['appended-mid-rewrite', 'kept-1'],
    ],
    [
      'promoteHwLearnings',
      [privateHwLearning('hw-1')],
      (file) => promoteHwLearnings({ input: file, dryRun: false }),
      ['appended-mid-rewrite', 'hw-1', 'hw-1', 'kept-1'],
    ],
  ])('%s: an append issued between the read of the store and the rename survives the rewrite', async (_name, extra, runRewriter, expectedIds) => {
    writeFileSync(store, [learning('kept-1'), ...extra].map((e) => `${JSON.stringify(e)}\n`).join(''));
    let reachedRead;
    const atRead = new Promise((resolve) => { reachedRead = resolve; });
    let releaseRead;
    const readReleased = new Promise((resolve) => { releaseRead = resolve; });
    onStoreRead = async () => {
      onStoreRead = null; // one-shot: only the rewriter's first read parks
      reachedRead();
      await readReleased;
    };

    const rewrite = runRewriter(store, dir);
    await atRead; // the rewriter has read the store and holds its stale generation

    const append = appendLearning(store, learning('appended-mid-rewrite'));
    // Unlocked, the append lands at once; locked, it waits for the rewrite.
    await Promise.race([append, new Promise((r) => setTimeout(r, 250))]);
    releaseRead();
    await Promise.all([rewrite, append]);

    expect(idsIn(store).sort()).toEqual(expectedIds);
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
