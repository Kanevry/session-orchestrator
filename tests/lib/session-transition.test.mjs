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
 *
 *  (d) DEREGISTER-BEFORE-OWNERSHIP. The first cut deleted the registry entry
 *      BEFORE reading the lock, and reported a foreign lock as `ok: true`. A
 *      caller passing the wrong `sessionId` therefore destroyed a live registry
 *      entry — the registry half of the phantom-peer state — and was told the
 *      departure succeeded.
 *
 *  (e) HOME PATH ON THE WEBHOOK. `from_root` put the absolute repo root in the
 *      `root_left` payload, and `emitEvent` forwards the whole payload to the
 *      optional Clank webhook unredacted. On this host that string is
 *      `/Users/<operator>/…`.
 *
 *  (f) ANOMALY / FAILURE PATHS UNOBSERVED. The unreadable/corrupt lock branch,
 *      the registry-unlink failure and the emit failure were each reachable and
 *      untested, so any of them could invert without a red test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { leaveSourceRoot, ROOT_LEFT_EVENT, LOCK_RELEASED_EVENT } from '@lib/session-transition.mjs';
import { registerSelf, readRegistry, repoPathHash } from '@lib/session-registry.mjs';
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

  // -- (a) + (e) -------------------------------------------------------------
  it('removes the source root\'s registry entry AND lock, and records the root by hash, never by path', async () => {
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
      from_root_hash: repoPathHash(repoRoot),
      from_root_basename: path.basename(repoRoot),
      reason: 'worktree-promotion',
    });
    // (e) — the payload travels to the Clank webhook unredacted, so the
    // absolute root must not be in it under ANY key, not merely not under
    // `from_root`. Serialising the record is the only assertion that holds when
    // a future field re-introduces the path under a new name.
    expect(JSON.stringify(left[0])).not.toContain(repoRoot);

    // ARCH-MED-1 — this is the third `release()` call site; it must be visible
    // on the same `orchestrator.session.lock.*` stream as the other two.
    const released = events.filter((e) => e.event === LOCK_RELEASED_EVENT);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      session_id: sessionId,
      semantic_session_id: 'main-2026-08-28-deep-1',
      caller: 'session-transition',
      outcome: 'deleted',
      verified: true,
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

  // -- (b) + (d) -------------------------------------------------------------
  it('aborts on a lock owned by another session — nothing removed, nothing emitted', async () => {
    const mine = 'cccccccc-3333-4333-8333-cccccccccccc';
    const foreign = 'dddddddd-4444-4444-8444-dddddddddddd';
    await registerSelf({ sessionId: mine, projectRoot: repoRoot });
    seedLock(repoRoot, foreign);

    const result = await leaveSourceRoot({ repoRoot, sessionId: mine, reason: 'worktree-promotion' });

    // (d) A caller whose id does not own this root has NOT departed it. Ownership
    // is read BEFORE the registry unlink, so the entry survives too.
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual({ deregistered: false, released: false, emitted: false });
    expect(result.reason).toBe(`lock-session-mismatch:${foreign}`);

    // The sibling's lock is untouched — same bytes, same owner.
    expect(readLock({ repoRoot })?.session_id).toBe(foreign);
    // …and so is the registry entry the first cut deleted here.
    expect((await readRegistry()).map((e) => e.session_id)).toEqual([mine]);
    // Nothing is written into a stream that belongs to the root's real owner.
    await expect(readEvents(repoRoot)).rejects.toThrow();
  });

  // -- (d) — the registry's own second ownership factor ------------------------
  it('does NOT deregister an entry pinned to a DIFFERENT root, and says so', async () => {
    // THE BUG: `deregisterSelf(sessionId)` is keyed by session id alone, so a
    // teardown of root A would unlink the entry of the same session id living
    // in root B — unregistering a session that is still running there.
    const sessionId = 'ffffffff-6666-4666-8666-ffffffffffff';
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'so-transition-other-'));
    try {
      await registerSelf({ sessionId, projectRoot: otherRoot, mode: 'deep' });
      seedLock(repoRoot, sessionId);

      const result = await leaveSourceRoot({ repoRoot, sessionId, reason: 'worktree-promotion' });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('registry-root-mismatch');
      expect(result.steps).toEqual({ deregistered: false, released: true, emitted: true });
      // The other root's claim survives, with its own hash intact.
      const entries = await readRegistry();
      expect(entries).toHaveLength(1);
      expect(entries[0].repo_path_hash).toBe(repoPathHash(otherRoot));
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  // -- (f) — the anomaly branch --------------------------------------------
  it.each([
    // `readLockDetailed` reports EISDIR as 'unreadable' and unparseable bytes as
    // 'corrupt'; both mean ownership is INDETERMINATE, which must fail closed.
    ['unreadable', async (root) => { await mkdir(path.join(root, LOCK_PATH), { recursive: true }); }],
    ['corrupt', async (root) => {
      await mkdir(path.dirname(path.join(root, LOCK_PATH)), { recursive: true });
      await writeFile(path.join(root, LOCK_PATH), 'not json at all\n', 'utf8');
    }],
  ])('fails closed on a %s lock — nothing removed, reason names the state', async (status, seed) => {
    const sessionId = '11111111-7777-4777-8777-111111111111';
    await registerSelf({ sessionId, projectRoot: repoRoot, mode: 'deep' });
    await seed(repoRoot);

    const result = await leaveSourceRoot({ repoRoot, sessionId, reason: 'worktree-promotion' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(`lock-${status}`);
    expect(result.steps).toEqual({ deregistered: false, released: false, emitted: false });
    // An indeterminate lock must not cost the registry entry either.
    expect((await readRegistry()).map((e) => e.session_id)).toEqual([sessionId]);
  });

  // -- (f) — the two failure paths -----------------------------------------
  it('reports a failed registry unlink as deregister-failed and still emits', async () => {
    // THE BUG: `deregisterSelf()` rethrows every non-ENOENT error. Unhandled it
    // would abort the promotion halfway — the two-live-roots state.
    const sessionId = '22222222-8888-4888-8888-222222222222';
    seedLock(repoRoot, sessionId);
    // The registry BASE is a plain file, so `<base>/active/<id>.json` is ENOTDIR
    // for every uid — root included (`testing.md` § Root-as-uid-0 hazards).
    const registryFile = path.join(registryDir, 'not-a-directory');
    await writeFile(registryFile, 'x', 'utf8');
    process.env.SO_SESSION_REGISTRY_DIR = registryFile;

    const result = await leaveSourceRoot({ repoRoot, sessionId, reason: 'worktree-promotion' });

    expect(result.ok).toBe(false);
    expect(result.steps.deregistered).toBe(false);
    expect(result.reason).toMatch(/^deregister-failed:/);
    // The lock half still ran — one failed step does not abandon the others.
    expect(result.steps).toMatchObject({ released: true, emitted: true });
  });

  it('reports a failing event emitter as emit-failed instead of throwing', async () => {
    // THE BUG: the promotion path has no catch. A throw out of the emitter
    // would surface as an exception in a caller that cannot abort any more.
    const sessionId = '33333333-9999-4999-8999-333333333333';
    await registerSelf({ sessionId, projectRoot: repoRoot, mode: 'deep' });
    seedLock(repoRoot, sessionId);

    const result = await leaveSourceRoot(
      { repoRoot, sessionId, reason: 'worktree-promotion' },
      { emitFn: () => { throw new Error('events.jsonl is a directory'); } },
    );

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual({ deregistered: true, released: true, emitted: false });
    expect(result.reason).toBe('emit-failed:events.jsonl is a directory');
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
