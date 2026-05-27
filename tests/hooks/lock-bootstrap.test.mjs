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
import { tmpdir } from 'node:os';
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
