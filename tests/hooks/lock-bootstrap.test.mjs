/**
 * tests/hooks/lock-bootstrap.test.mjs
 *
 * Unit tests for hooks/_lib/lock-bootstrap.mjs — mechanical session.lock writer
 * for SessionStart (Epic #583 P3 — #584 + #587).
 *
 * Strategy: import bootstrapLock() directly and inject mock acquire/forceAcquire
 * impls via the test-only `_acquireImpl` / `_forceAcquireImpl` / `_emitEventImpl`
 * DI seams. This isolates the helper from the real session-lock module so we
 * can test failure paths (acquire throws, fs-error, schema overlay) without
 * touching the host's session.lock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import { bootstrapLock } from '../../hooks/_lib/lock-bootstrap.mjs';

// ── sandbox helpers ──────────────────────────────────────────────────────────

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'lock-bootstrap-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readLock() {
  const lockPath = join(sandbox, '.orchestrator', 'session.lock');
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, 'utf8'));
}

function readCurrentSession() {
  const sessionPath = join(sandbox, '.orchestrator', 'current-session.json');
  if (!existsSync(sessionPath)) return null;
  return JSON.parse(readFileSync(sessionPath, 'utf8'));
}

/** Seed an existing current-session.json with the canonical SessionStart fields. */
function seedCurrentSession(body) {
  const dir = join(sandbox, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'current-session.json'),
    JSON.stringify(body, null, 2) + '\n',
  );
}

/** Stub acquire() that writes a v1-shape lock to disk and returns ok:true. */
function makeAcquireStub(opts = {}) {
  return vi.fn((args) => {
    const lockBody = {
      session_id: args.sessionId,
      started_at: '2026-05-27T12:00:00.000Z',
      mode: args.mode,
      pid: opts.pid ?? 99999,
      host: opts.host ?? 'test-host',
      ttl_hours: args.ttlHours ?? 4,
    };
    // Write to disk so the helper can re-read + enrich.
    const dir = join(args.repoRoot, '.orchestrator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.lock'), JSON.stringify(lockBody, null, 2) + '\n');
    return { ok: true, lock: lockBody };
  });
}

const noopEmit = vi.fn(async () => {});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — acquire succeeds, lock is enriched with v2 schema
// ─────────────────────────────────────────────────────────────────────────────

describe('bootstrapLock — happy path', () => {
  it('returns the enriched lock body when acquire succeeds', async () => {
    const acquireStub = makeAcquireStub();
    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-1',
      semanticSessionId: 'main-2026-05-27-deep-1',
      mode: 'deep',
      _acquireImpl: acquireStub,
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });

    expect(result).not.toBeNull();
    expect(result.session_id).toBe('main-2026-05-27-deep-1');
    expect(result.semantic_session_id).toBe('main-2026-05-27-deep-1');
    expect(result.mode).toBe('deep');
    expect(result.ttl_hours).toBe(4);
  });

  it('writes last_heartbeat field equal to started_at', async () => {
    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-1',
      semanticSessionId: 'main-2026-05-27-deep-1',
      mode: 'deep',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });
    expect(result.last_heartbeat).toBe(result.started_at);
    expect(result.last_heartbeat).toBe('2026-05-27T12:00:00.000Z');
  });

  it('surfaces a DIFFERENT semantic_session_id when sessionId is a UUID (D4 #587)', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const semantic = 'main-2026-05-27-deep-3';
    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: uuid,
      semanticSessionId: semantic,
      mode: 'deep',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });
    expect(result.session_id).toBe(uuid);
    expect(result.semantic_session_id).toBe(semantic);
    expect(result.session_id).not.toBe(result.semantic_session_id);
  });

  it('falls back to session_id when semanticSessionId is omitted', async () => {
    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-feature-2',
      mode: 'feature',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });
    // No semanticSessionId provided → mirror sessionId
    expect(result.semantic_session_id).toBe('main-2026-05-27-feature-2');
  });

  it('persists the v2 schema to disk', async () => {
    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-1',
      semanticSessionId: 'main-2026-05-27-deep-1',
      mode: 'deep',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });

    const lock = readLock();
    expect(lock).not.toBeNull();
    expect(lock.session_id).toBe('main-2026-05-27-deep-1');
    expect(lock.semantic_session_id).toBe('main-2026-05-27-deep-1');
    expect(lock.last_heartbeat).toBe('2026-05-27T12:00:00.000Z');
    expect(lock.mode).toBe('deep');
    expect(lock.host).toBe('test-host');
    expect(lock.pid).toBe(99999);
    expect(lock.ttl_hours).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths — every error class returns null, never throws
// ─────────────────────────────────────────────────────────────────────────────

describe('bootstrapLock — failure paths (best-effort contract)', () => {
  it('returns null when acquire() throws', async () => {
    const throwingAcquire = vi.fn(() => { throw new Error('boom'); });
    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-1',
      semanticSessionId: 'main-2026-05-27-deep-1',
      mode: 'deep',
      _acquireImpl: throwingAcquire,
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });
    expect(result).toBeNull();
  });

  it('returns null when acquire() returns non-ok and is not stale', async () => {
    // Simulate a parallel-conflict — bootstrap must NOT force-overwrite.
    const conflictAcquire = vi.fn(() => ({
      ok: false,
      reason: 'active-compatible-parallel',
      exclusivityClass: 'parallel-ok',
      allActiveSessions: [],
    }));
    const forceAcquire = vi.fn();
    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-1',
      semanticSessionId: 'main-2026-05-27-deep-1',
      mode: 'deep',
      _acquireImpl: conflictAcquire,
      _forceAcquireImpl: forceAcquire,
      _emitEventImpl: noopEmit,
    });
    expect(result).toBeNull();
    // forceAcquire must NOT have been called — we don't overwrite a live foreign lock
    expect(forceAcquire).not.toHaveBeenCalled();
  });

  it('force-overwrites a stale-pid-dead lock', async () => {
    const staleAcquire = vi.fn(() => ({
      ok: false,
      reason: 'stale-pid-dead',
      existingLock: {
        session_id: 'old-session',
        started_at: '2026-05-26T00:00:00.000Z',
        mode: 'deep',
        pid: 1,
        host: 'test-host',
        ttl_hours: 4,
      },
    }));
    const forceAcquire = makeAcquireStub();

    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-2',
      semanticSessionId: 'main-2026-05-27-deep-2',
      mode: 'deep',
      _acquireImpl: staleAcquire,
      _forceAcquireImpl: forceAcquire,
      _emitEventImpl: noopEmit,
    });

    expect(result).not.toBeNull();
    expect(result.session_id).toBe('main-2026-05-27-deep-2');
    expect(forceAcquire).toHaveBeenCalledOnce();
  });

  it('force-overwrites an active lock when session_ids match (idempotent refresh)', async () => {
    const sessionId = 'main-2026-05-27-deep-5';
    const liveAcquire = vi.fn(() => ({
      ok: false,
      reason: 'active',
      existingLock: {
        session_id: sessionId,  // same id → refresh
        started_at: '2026-05-27T11:00:00.000Z',
        mode: 'deep',
        pid: 99999,
        host: 'test-host',
        ttl_hours: 4,
      },
    }));
    const forceAcquire = makeAcquireStub();

    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId,
      semanticSessionId: sessionId,
      mode: 'deep',
      _acquireImpl: liveAcquire,
      _forceAcquireImpl: forceAcquire,
      _emitEventImpl: noopEmit,
    });

    expect(result).not.toBeNull();
    expect(forceAcquire).toHaveBeenCalledOnce();
  });

  it('does NOT force-overwrite when an active lock belongs to a different session', async () => {
    const foreignAcquire = vi.fn(() => ({
      ok: false,
      reason: 'active',
      existingLock: {
        session_id: 'other-session-id',
        started_at: '2026-05-27T11:00:00.000Z',
        mode: 'deep',
        pid: 99998,
        host: 'test-host',
        ttl_hours: 4,
      },
    }));
    const forceAcquire = vi.fn();

    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-7',
      semanticSessionId: 'main-2026-05-27-deep-7',
      mode: 'deep',
      _acquireImpl: foreignAcquire,
      _forceAcquireImpl: forceAcquire,
      _emitEventImpl: noopEmit,
    });
    expect(result).toBeNull();
    expect(forceAcquire).not.toHaveBeenCalled();
  });

  it('returns null and does NOT throw when emitEvent throws', async () => {
    const throwingEmit = vi.fn(async () => { throw new Error('emit-fail'); });
    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-1',
      semanticSessionId: 'main-2026-05-27-deep-1',
      mode: 'deep',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: throwingEmit,
    });
    // emitEvent failure is non-fatal — helper still returns the enriched lock.
    expect(result).not.toBeNull();
    expect(result.session_id).toBe('main-2026-05-27-deep-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conflict signal — foreign-active lock writes conflict_with_session_id (#590 Item 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('bootstrapLock — foreign-active conflict signal (#590)', () => {
  /** Acquire stub that reports a foreign session already owns the lock. */
  function makeForeignActiveAcquire(foreignSessionId) {
    return vi.fn(() => ({
      ok: false,
      reason: 'active',
      existingLock: {
        session_id: foreignSessionId,
        started_at: '2026-05-27T11:00:00.000Z',
        mode: 'deep',
        pid: 88888,
        host: 'test-host',
        ttl_hours: 4,
      },
    }));
  }

  it('returns null on the foreign-active bail path (return contract unchanged)', async () => {
    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-6',
      semanticSessionId: 'main-2026-05-27-deep-6',
      mode: 'deep',
      _acquireImpl: makeForeignActiveAcquire('foreign-xyz'),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });
    expect(result).toBeNull();
  });

  it('writes conflict_with_session_id equal to the foreign session_id', async () => {
    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-6',
      semanticSessionId: 'main-2026-05-27-deep-6',
      mode: 'deep',
      _acquireImpl: makeForeignActiveAcquire('foreign-xyz'),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });

    const session = readCurrentSession();
    expect(session).not.toBeNull();
    expect(session.conflict_with_session_id).toBe('foreign-xyz');
  });

  it('records a conflict_detected_at ISO-8601 timestamp', async () => {
    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-6',
      semanticSessionId: 'main-2026-05-27-deep-6',
      mode: 'deep',
      _acquireImpl: makeForeignActiveAcquire('foreign-xyz'),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });

    const session = readCurrentSession();
    // Assert a real ISO-8601 instant (Date round-trip is exact), not just truthiness.
    expect(session.conflict_detected_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(new Date(session.conflict_detected_at).toISOString()).toBe(
      session.conflict_detected_at,
    );
  });

  it('preserves all pre-existing current-session.json fields (read-modify-write)', async () => {
    // Seed the canonical SessionStart fields plus a concurrently-written array
    // that another hook (cwd-change-restore) would append.
    seedCurrentSession({
      session_id: 'main-2026-05-27-deep-6',
      semantic_session_id: 'main-2026-05-27-deep-6',
      pid: 4242,
      source: 'generated-uuid-fallback',
      timestamp: '2026-05-27T10:00:00.000Z',
      cwd_changes: [
        { timestamp: '2026-05-27T10:05:00.000Z', previous_cwd: '/a', new_cwd: '/b' },
      ],
    });

    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-6',
      semanticSessionId: 'main-2026-05-27-deep-6',
      mode: 'deep',
      _acquireImpl: makeForeignActiveAcquire('foreign-abc'),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });

    const session = readCurrentSession();
    // Conflict fields added …
    expect(session.conflict_with_session_id).toBe('foreign-abc');
    // … and every pre-existing field is intact (not clobbered).
    expect(session.session_id).toBe('main-2026-05-27-deep-6');
    expect(session.semantic_session_id).toBe('main-2026-05-27-deep-6');
    expect(session.pid).toBe(4242);
    expect(session.source).toBe('generated-uuid-fallback');
    expect(session.timestamp).toBe('2026-05-27T10:00:00.000Z');
    expect(session.cwd_changes).toEqual([
      { timestamp: '2026-05-27T10:05:00.000Z', previous_cwd: '/a', new_cwd: '/b' },
    ]);
  });

  it('does NOT write a conflict field when acquire succeeds (happy path)', async () => {
    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-6',
      semanticSessionId: 'main-2026-05-27-deep-6',
      mode: 'deep',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });

    // No current-session.json should have been created by bootstrapLock on the
    // happy path — it only touches session.lock.
    expect(readCurrentSession()).toBeNull();
  });

  it('does NOT write a conflict field when the active lock is OUR OWN session (force-refresh)', async () => {
    const sessionId = 'main-2026-05-27-deep-6';
    const liveAcquire = vi.fn(() => ({
      ok: false,
      reason: 'active',
      existingLock: {
        session_id: sessionId, // same id → force-refresh path, NOT a conflict
        started_at: '2026-05-27T11:00:00.000Z',
        mode: 'deep',
        pid: 99999,
        host: 'test-host',
        ttl_hours: 4,
      },
    }));

    await bootstrapLock({
      repoRoot: sandbox,
      sessionId,
      semanticSessionId: sessionId,
      mode: 'deep',
      _acquireImpl: liveAcquire,
      _forceAcquireImpl: makeAcquireStub(),
      _emitEventImpl: noopEmit,
    });

    // Same-session active → force-refresh succeeded → no conflict recorded.
    expect(readCurrentSession()).toBeNull();
  });

  it('does NOT write a conflict field on a non-active, non-stale failure', async () => {
    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-6',
      semanticSessionId: 'main-2026-05-27-deep-6',
      mode: 'deep',
      _acquireImpl: vi.fn(() => ({
        ok: false,
        reason: 'active-compatible-parallel',
        exclusivityClass: 'parallel-ok',
        allActiveSessions: [],
      })),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });

    // 'active-compatible-parallel' is a legitimate parallel-ok outcome, not a
    // foreign-lock collision — no conflict signal is recorded.
    expect(readCurrentSession()).toBeNull();
  });

  // MED-3 (#596): array-input guard test.
  //
  // The recordConflictSignal read-modify-write has the guard:
  //   if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  // This test seeds current-session.json as a top-level JSON array, then
  // triggers the conflict path. It asserts the merged output is a clean OBJECT
  // (not a numeric-keyed spread of the array) with the conflict fields intact.
  //
  // Surviving mutation: deleting the `!Array.isArray(parsed)` guard would cause
  // the array to be spread into the merged object as numeric-keyed properties
  // ('0', '1', ...). The assertions `expect(result).not.toHaveProperty('0')`
  // and the clean conflict field checks would then FAIL — proving the guard is load-bearing.
  it('MED-3: array-shaped current-session.json is rejected (not spread), conflict fields written cleanly', async () => {
    // Seed current-session.json as a top-level JSON array — the guard must reject this.
    const dir = join(sandbox, '.orchestrator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'current-session.json'),
      JSON.stringify(['x', 'y']),
    );

    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'main-2026-05-27-deep-6',
      semanticSessionId: 'main-2026-05-27-deep-6',
      mode: 'deep',
      _acquireImpl: vi.fn(() => ({
        ok: false,
        reason: 'active',
        existingLock: {
          session_id: 'foreign-xyz',
          started_at: '2026-05-27T11:00:00.000Z',
          mode: 'deep',
          pid: 88888,
          host: 'test-host',
          ttl_hours: 4,
        },
      })),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });

    const result = readCurrentSession();
    expect(result).not.toBeNull();

    // Conflict fields must be present with correct values.
    expect(result.conflict_with_session_id).toBe('foreign-xyz');
    expect(result.conflict_detected_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    // The array was REJECTED by the guard — it must NOT have been spread into
    // numeric-keyed properties. Deleting `!Array.isArray(parsed)` would cause
    // these to appear and the assertions below would FAIL.
    expect(result).not.toHaveProperty('0');
    expect(result).not.toHaveProperty('1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation — missing required args → null
// ─────────────────────────────────────────────────────────────────────────────

describe('bootstrapLock — input validation', () => {
  it('returns null when repoRoot is missing', async () => {
    const result = await bootstrapLock({
      sessionId: 'x',
      mode: 'deep',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });
    expect(result).toBeNull();
  });

  it('returns null when sessionId is missing', async () => {
    const result = await bootstrapLock({
      repoRoot: sandbox,
      mode: 'deep',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });
    expect(result).toBeNull();
  });

  it('returns null when mode is missing', async () => {
    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'x',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: noopEmit,
    });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Observability — event is emitted with full v2 payload
// ─────────────────────────────────────────────────────────────────────────────

describe('bootstrapLock — observability', () => {
  it('emits orchestrator.session.lock.acquired event with v2 payload fields', async () => {
    const emit = vi.fn(async () => {});
    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      semanticSessionId: 'main-2026-05-27-deep-1',
      mode: 'deep',
      _acquireImpl: makeAcquireStub(),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: emit,
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      'orchestrator.session.lock.acquired',
      expect.objectContaining({
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        semantic_session_id: 'main-2026-05-27-deep-1',
        mode: 'deep',
        pid: 99999,
        host: 'test-host',
        ttl_hours: 4,
      }),
    );
  });

  it('does NOT emit the event when acquire fails', async () => {
    const emit = vi.fn(async () => {});
    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'x',
      mode: 'deep',
      _acquireImpl: vi.fn(() => ({ ok: false, reason: 'fs-error', error: 'disk full' })),
      _forceAcquireImpl: vi.fn(),
      _emitEventImpl: emit,
    });
    expect(emit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end hijack prevention (#744) — REAL acquire()/forceAcquire(), no DI
// stubs. Discovery D1 flagged that the mocked "force-overwrites a stale-pid-
// dead lock" test above (see `bootstrapLock — failure paths`) exercises only
// the bootstrapLock-level branching, not the actual #744 classification fix
// inside scripts/lib/session-lock.mjs's classifyExisting. These tests omit
// `_acquireImpl`/`_forceAcquireImpl`/`_emitEventImpl` entirely so bootstrapLock
// takes its PRODUCTION path: `await import('../../scripts/lib/session-lock.mjs')`
// and calls the real `acquire`/`forceAcquire`.
//
// Fixture: a FOREIGN session's lock with a FRESH last_heartbeat (live) but a
// dead recorded PID on this same host — exactly the #744 incident shape (the
// lock's `pid` field is the ephemeral hook subprocess PID, not the semantic
// session's own PID, so a dead PID must never veto a fresh heartbeat).
//
// Falsification: if the #744 fix in classifyExisting were reverted (dead PID
// once again vetoes a fresh heartbeat), `acquire()` would misclassify this
// foreign lock as 'stale-pid-dead', bootstrapLock's `shouldForce` would flip
// true, and `forceAcquire()` would overwrite the foreign lock — the first
// assertion below (`onDisk.session_id` still equals the foreign id) would fail.
// ─────────────────────────────────────────────────────────────────────────────

describe('bootstrapLock — end-to-end hijack prevention (#744, real acquire/forceAcquire, no mocks)', () => {
  /** Seed a REAL foreign session.lock: fresh heartbeat (live) + dead PID, same host. */
  function seedForeignLiveLock(sessionId) {
    const dir = join(sandbox, '.orchestrator');
    mkdirSync(dir, { recursive: true });
    const lock = {
      session_id: sessionId,
      started_at: '2020-01-01T00:00:00.000Z', // old start — irrelevant, heartbeat governs liveness
      last_heartbeat: new Date().toISOString(), // FRESH heartbeat → live
      mode: 'deep',
      pid: 999999, // dead PID on this host
      host: hostname(),
      ttl_hours: 4,
    };
    writeFileSync(join(dir, 'session.lock'), JSON.stringify(lock, null, 2) + '\n');
  }

  it('does NOT overwrite a foreign lock with a fresh heartbeat + dead PID (the #744 incident)', async () => {
    const foreignSessionId = 'foreign-real-744-a';
    seedForeignLiveLock(foreignSessionId);

    const result = await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'my-own-session-744-a',
      semanticSessionId: 'my-own-session-744-a',
      mode: 'deep',
    });

    expect(result).toBeNull();
    const onDisk = readLock();
    expect(onDisk.session_id).toBe(foreignSessionId);
  });

  it('records the foreign session_id as a conflict signal (real acquire/forceAcquire path)', async () => {
    const foreignSessionId = 'foreign-real-744-b';
    seedForeignLiveLock(foreignSessionId);

    await bootstrapLock({
      repoRoot: sandbox,
      sessionId: 'my-own-session-744-b',
      semanticSessionId: 'my-own-session-744-b',
      mode: 'deep',
    });

    const session = readCurrentSession();
    expect(session).not.toBeNull();
    expect(session.conflict_with_session_id).toBe(foreignSessionId);
  });
});
