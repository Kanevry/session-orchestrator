/**
 * tests/lib/session-transition.test.mjs
 *
 * Unit tests for `leaveSourceRoot()` — the process-boundary teardown of a
 * source repo root (issue #1069, operator decision "Prozessgrenze").
 *
 * The bugs these catch (TV-001, named before written):
 *
 *  (a) PHANTOM PEER. Worktree-Auto-Promotion left the source root's registry
 *      entry and `session.lock` standing. `detectPeers()` reads that entry as
 *      FRESH for 15 minutes and `sweepZombies()` only reaps it after 60, so the
 *      abandoned root advertised a live session that no longer exists. No
 *      existing test covers a teardown of the OLD root, because no such
 *      teardown existed before this module.
 *
 *  (b) FOREIGN-LOCK DELETION. A teardown that unlinks whatever lock it finds in
 *      `repoRoot` would delete a sibling session's lock — the PSA-005 failure
 *      the whole `release()` ownership gate exists to prevent. `release()` has
 *      its own test for this; what is untested here is that this NEW caller
 *      actually routes through that gate rather than unlinking by itself.
 *
 *  (c) NON-IDEMPOTENT RERUN. `deregisterSelf()` throws on a non-ENOENT error
 *      and the promotion path has no catch; a second call (retry, resumed
 *      preamble) must report a clean no-op, not a failure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { leaveSourceRoot, ROOT_LEFT_EVENT } from '@lib/session-transition.mjs';
import { registerSelf, readRegistry } from '@lib/session-registry.mjs';
import { acquire, writeOwnerProof, readLock, LOCK_PATH } from '@lib/session-lock.mjs';

const EVENTS_RELPATH = path.join('.orchestrator', 'metrics', 'events.jsonl');

/** Read every event record written under `repoRoot`. */
async function readEvents(repoRoot) {
  const raw = await readFile(path.join(repoRoot, EVENTS_RELPATH), 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** True when a path exists. */
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Put a live lock + persisted owner proof into `repoRoot` for `sessionId`. */
function seedLock(repoRoot, sessionId, semanticSessionId = null) {
  const result = acquire({ sessionId, mode: 'deep', repoRoot, semanticSessionId, quiet: true });
  expect(result.ok).toBe(true);
  const proofResult = writeOwnerProof({ repoRoot, lock: result.lock });
  expect(proofResult.ok).toBe(true);
  return result.lock;
}

describe('leaveSourceRoot', () => {
  let repoRoot;
  let registryDir;
  let origRegistryEnv;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), 'so-transition-root-'));
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'so-transition-registry-'));
    origRegistryEnv = process.env.SO_SESSION_REGISTRY_DIR;
    process.env.SO_SESSION_REGISTRY_DIR = registryDir;
  });

  afterEach(async () => {
    if (origRegistryEnv === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
    else process.env.SO_SESSION_REGISTRY_DIR = origRegistryEnv;
    await rm(repoRoot, { recursive: true, force: true });
    await rm(registryDir, { recursive: true, force: true });
  });

  // -- (a) -------------------------------------------------------------------
  it('removes the source root\'s registry entry AND lock, and records from_root', async () => {
    const sessionId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    await registerSelf({ sessionId, projectRoot: repoRoot, mode: 'deep' });
    seedLock(repoRoot, sessionId, 'main-2026-08-28-deep-1');

    // Premise checks — without these the assertions below could pass vacuously.
    expect(await readRegistry()).toHaveLength(1);
    expect(readLock({ repoRoot })?.session_id).toBe(sessionId);

    const result = await leaveSourceRoot({
      repoRoot,
      sessionId,
      semanticSessionId: 'main-2026-08-28-deep-1',
      reason: 'worktree-promotion',
    });

    expect(result.ok).toBe(true);
    expect(result.steps).toEqual({ deregistered: true, released: true, emitted: true });

    // The phantom-peer surface is gone on BOTH sides.
    expect(await readRegistry()).toEqual([]);
    expect(readLock({ repoRoot })).toBeNull();
    expect(await exists(path.join(repoRoot, LOCK_PATH))).toBe(false);

    const events = await readEvents(repoRoot);
    const left = events.filter((e) => e.event === ROOT_LEFT_EVENT);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({
      session_id: sessionId,
      semantic_session_id: 'main-2026-08-28-deep-1',
      from_root: repoRoot,
      reason: 'worktree-promotion',
    });
  });

  it('omits semantic_session_id from the event when it is unknown', async () => {
    const sessionId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    await registerSelf({ sessionId, projectRoot: repoRoot });
    seedLock(repoRoot, sessionId);

    await leaveSourceRoot({ repoRoot, sessionId, reason: 'worktree-promotion' });

    const [record] = (await readEvents(repoRoot)).filter((e) => e.event === ROOT_LEFT_EVENT);
    expect(record).toBeDefined();
    expect('semantic_session_id' in record).toBe(false);
  });

  // -- (b) -------------------------------------------------------------------
  it('does NOT release a lock owned by another session, and names the mismatch', async () => {
    const mine = 'cccccccc-3333-4333-8333-cccccccccccc';
    const foreign = 'dddddddd-4444-4444-8444-dddddddddddd';
    await registerSelf({ sessionId: mine, projectRoot: repoRoot });
    seedLock(repoRoot, foreign);

    const result = await leaveSourceRoot({ repoRoot, sessionId: mine, reason: 'worktree-promotion' });

    // Refusing to delete a foreign lock is correct behaviour, not a failure.
    expect(result.ok).toBe(true);
    expect(result.steps.deregistered).toBe(true);
    expect(result.steps.released).toBe(false);
    expect(result.reason).toContain('mismatch');
    expect(result.reason).toContain(foreign);

    // The sibling's lock is untouched — same bytes, same owner.
    expect(readLock({ repoRoot })?.session_id).toBe(foreign);
  });

  // -- (c) -------------------------------------------------------------------
  it('is idempotent — a second call reports already-gone instead of failing', async () => {
    const sessionId = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
    await registerSelf({ sessionId, projectRoot: repoRoot });
    seedLock(repoRoot, sessionId);

    const first = await leaveSourceRoot({ repoRoot, sessionId, reason: 'worktree-promotion' });
    expect(first.steps).toEqual({ deregistered: true, released: true, emitted: true });

    const second = await leaveSourceRoot({ repoRoot, sessionId, reason: 'worktree-promotion' });
    expect(second.ok).toBe(true);
    expect(second.steps).toEqual({ deregistered: false, released: false, emitted: true });
    expect(second.reason).toBe('already-gone');
  });

  it('never throws on unusable input and emits nothing without a root', async () => {
    const result = await leaveSourceRoot({ repoRoot: '', sessionId: '' });
    expect(result).toEqual({
      ok: false,
      steps: { deregistered: false, released: false, emitted: false },
      reason: 'invalid-args',
    });
  });
});
