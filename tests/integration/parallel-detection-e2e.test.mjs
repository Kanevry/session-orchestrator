/**
 * tests/integration/parallel-detection-e2e.test.mjs
 *
 * End-to-end smoke test proving Epic #583 acceptance criteria.
 * Verifies that the runtime parallel-session-detection feature actually grips:
 *
 *   AC1 — In a Claude Code session, an active peer in another worktree is
 *         detected by `discoverActiveSessions()` AND classified by
 *         `classifyMode()`. Covers BOTH the lock surface AND the registry
 *         fallback surface.
 *   AC2 — The Phase 0.5 parallel-aware preamble fires AUQ when a real
 *         conflicting peer exists (no manual coordinator-prose required).
 *   AC3 — The PRD-quote in `skills/_shared/parallel-aware-preamble.md`
 *         "Phase 1b Peer-Guard" no longer contradicts runtime behavior
 *         (cross-references state-md-peer-guard.mjs).
 *   AC4 — `acquire()` records a session-lifetime indicator (heartbeat)
 *         usable for liveness checks (NOT writer-script's ephemeral PID).
 *
 * Deterministic, isolated: every test sets up its own tmp repo + lock fixture
 * via `mkdtempSync`. Mocks the registry directory via `SO_SESSION_REGISTRY_DIR`
 * to avoid touching the real `~/.config/session-orchestrator/sessions/`.
 *
 * `listWorktrees` is replaced via the DI seam `opts.listWorktreesImpl` to
 * avoid invoking real `git worktree list` — fast, hermetic, no side effects.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import {
  discoverActiveSessions,
} from '@lib/session-discovery.mjs';
import {
  acquire,
  isLockLive,
} from '@lib/session-lock.mjs';
import { classifyMode } from '@lib/exclusivity-matrix.mjs';
import {
  registerSelf,
  deregisterSelf,
} from '@lib/session-registry.mjs';

// ---------------------------------------------------------------------------
// Per-test isolation: tmp repo + tmp registry dir
// ---------------------------------------------------------------------------

let worktree1;          // "main" fixture worktree (writes session.lock here)
let worktree2;          // sibling fixture worktree (caller of discovery)
let registryDir;        // tmp host-registry override
let prevRegistryEnv;

beforeEach(() => {
  worktree1 = mkdtempSync(join(tmpdir(), 'pd-e2e-wt1-'));
  worktree2 = mkdtempSync(join(tmpdir(), 'pd-e2e-wt2-'));
  registryDir = mkdtempSync(join(tmpdir(), 'pd-e2e-reg-'));

  prevRegistryEnv = process.env.SO_SESSION_REGISTRY_DIR;
  process.env.SO_SESSION_REGISTRY_DIR = registryDir;
});

afterEach(() => {
  rmSync(worktree1, { recursive: true, force: true });
  rmSync(worktree2, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
  if (prevRegistryEnv === undefined) {
    delete process.env.SO_SESSION_REGISTRY_DIR;
  } else {
    process.env.SO_SESSION_REGISTRY_DIR = prevRegistryEnv;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a schema-v2 session.lock fixture at the given worktree.
 *
 * Body shape: { session_id, started_at, last_heartbeat, mode, pid, host,
 * ttl_hours, semantic_session_id? }.
 *
 * @param {string} wtPath
 * @param {object} overrides
 */
function writeLockV2(wtPath, overrides = {}) {
  const now = new Date().toISOString();
  const body = {
    session_id:     'main-2026-05-27-deep-A',
    started_at:     now,
    last_heartbeat: now,
    mode:           'deep',
    pid:            process.pid,
    host:           hostname(),
    ttl_hours:      4,
    ...overrides,
  };
  const dir = join(wtPath, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.lock'), JSON.stringify(body, null, 2) + '\n');
  return body;
}

/**
 * Build a listWorktrees DI replacement returning the given paths.
 * @param {Array<{path: string, branch?: string}>} entries
 */
function makeListWorktreesImpl(entries) {
  return async () => entries.map((e) => ({
    path:   e.path,
    branch: e.branch ?? 'main',
    head:   'fixture',
  }));
}

/**
 * Minimal in-test re-implementation of the parallel-aware preamble.
 *
 * This mirrors the reference algorithm documented in
 * `skills/_shared/parallel-aware-preamble.md` § "Implementation (JavaScript
 * reference)". Re-implementing it here (rather than importing) is the
 * documented pattern in the test prompt — the preamble is currently markdown-
 * referenced prose, not a callable export. When the SSOT becomes a module,
 * this fixture can be replaced with a direct import.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.callerMode
 * @param {string} args.callerSessionId
 * @param {Function} args.discoverImpl - DI seam to swap in a mock.
 * @returns {Promise<{outcome: string, callerClass?: string, parallelPeer?: object, blockingSession?: object}>}
 */
async function runParallelAwarePreambleFixture({
  repoRoot,
  callerMode,
  callerSessionId,
  discoverImpl,
}) {
  let active;
  try {
    active = await discoverImpl(repoRoot);
  } catch {
    return { outcome: 'PASS_THROUGH', reason: 'discovery-error' };
  }

  let callerClass;
  try {
    callerClass = classifyMode(callerMode);
  } catch {
    callerClass = 'parallel-ok';
  }

  if (callerClass === 'always-ok') return { outcome: 'PASS_THROUGH', callerClass };
  if (!Array.isArray(active) || active.length === 0) {
    return { outcome: 'PASS_THROUGH', callerClass };
  }

  const classifiedActive = active.map((entry) => {
    let entryClass;
    try { entryClass = classifyMode(entry.mode); } catch { entryClass = 'parallel-ok'; }
    return { ...entry, _class: entryClass };
  });

  const exclusiveActive = classifiedActive.find(
    (e) => e._class === 'exclusive' && e.sessionId !== callerSessionId,
  );
  if (exclusiveActive) {
    return { outcome: 'EXCLUSIVE_BLOCKED', callerClass, blockingSession: exclusiveActive };
  }

  const parallelPeer = callerClass === 'parallel-ok'
    ? classifiedActive.find((e) => e._class === 'parallel-ok' && e.sessionId !== callerSessionId)
    : null;
  if (parallelPeer) {
    return { outcome: 'PROMOTION_OFFER', callerClass, parallelPeer };
  }

  return { outcome: 'PASS_THROUGH', callerClass };
}

// ---------------------------------------------------------------------------
// T1 — AC1 happy path (lock surface)
// ---------------------------------------------------------------------------

describe('Epic #583 AC1 — lock-surface detection happy path', () => {
  it('discoverActiveSessions returns the peer lock + classifyMode buckets it as parallel-ok', async () => {
    // worktree1 owns the lock (peer); worktree2 is the discovery caller.
    writeLockV2(worktree1, {
      session_id: 'main-2026-05-27-deep-A',
      mode:       'deep',
      // last_heartbeat fresh (default = now).
    });

    const listWorktreesImpl = makeListWorktreesImpl([
      { path: worktree1, branch: 'main' },
      { path: worktree2, branch: 'feat/x' },
    ]);

    const result = await discoverActiveSessions(worktree2, { listWorktreesImpl });

    // AC1.a — discovery returns exactly the peer session (worktree2 has no lock).
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('main-2026-05-27-deep-A');
    expect(result[0].mode).toBe('deep');
    expect(result[0].worktreePath).toBe(worktree1);

    // AC1.b — classifyMode buckets the peer.
    expect(classifyMode(result[0].mode)).toBe('parallel-ok');
  });
});

// ---------------------------------------------------------------------------
// T2 — AC1 fallback to registry (when lock surface is empty)
// ---------------------------------------------------------------------------

describe('Epic #583 AC1 — registry-fallback detection', () => {
  it('discoverActiveSessions returns a registry-only session when no lock exists', async () => {
    // No locks anywhere — only a registry entry.
    const registered = await registerSelf({
      sessionId:   'peer-housekeeping-A',
      projectRoot: worktree2,         // same repo path as the discovery caller
      mode:        'housekeeping',
      status:      'active',
    });

    try {
      const listWorktreesImpl = makeListWorktreesImpl([
        { path: worktree2, branch: 'main' },
      ]);

      const result = await discoverActiveSessions(worktree2, { listWorktreesImpl });

      // AC1.a — discovery returns 1 session, sourced from the registry.
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('peer-housekeeping-A');
      expect(result[0].mode).toBe('housekeeping');

      // AC1.b — classifyMode buckets the peer (housekeeping → exclusive).
      expect(classifyMode(result[0].mode)).toBe('exclusive');
    } finally {
      await deregisterSelf(registered.session_id);
    }
  });
});

// ---------------------------------------------------------------------------
// T2b — AC1 multi-peer: 3+ concurrent sessions all discovered (Issue #591 H6)
// ---------------------------------------------------------------------------

describe('Epic #583 AC1 — 3+ concurrent peers are all discovered', () => {
  it('discoverActiveSessions returns all three registry peers in the same repo with no drop or dedup-collapse', async () => {
    // Three concurrent sessions registered against the SAME repo path
    // (worktree2 — the discovery caller's root). The registry fallback keys on
    // repo_path_hash(repoRoot), so all three must share that root to be merged.
    // Distinct modes (one per exclusivity class) make the assertion stronger:
    // it catches a merge bug that attaches the wrong mode to a sessionId, not
    // just a missing-peer bug.
    const peers = [
      { sessionId: 'peer-deep-1',         mode: 'deep' },          // parallel-ok
      { sessionId: 'peer-feature-2',      mode: 'feature' },       // parallel-ok
      { sessionId: 'peer-housekeeping-3', mode: 'housekeeping' },  // exclusive
    ];

    const registered = [];
    for (const p of peers) {
      registered.push(await registerSelf({
        sessionId:   p.sessionId,
        projectRoot: worktree2,
        mode:        p.mode,
        status:      'active',
      }));
    }

    try {
      const listWorktreesImpl = makeListWorktreesImpl([
        { path: worktree2, branch: 'main' },
      ]);

      const result = await discoverActiveSessions(worktree2, { listWorktreesImpl });

      // AC1.a — exactly three sessions surfaced (no peer dropped, none collapsed
      // by the dedupeBySessionId pass since all three ids are distinct).
      expect(result).toHaveLength(3);

      // AC1.b — the exact set of (sessionId, mode) pairs round-trips. Sorting
      // by sessionId makes the comparison order-independent (discovery merge
      // order is not part of the contract).
      const pairs = result
        .map((r) => ({ sessionId: r.sessionId, mode: r.mode }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      expect(pairs).toEqual([
        { sessionId: 'peer-deep-1',         mode: 'deep' },
        { sessionId: 'peer-feature-2',      mode: 'feature' },
        { sessionId: 'peer-housekeeping-3', mode: 'housekeeping' },
      ]);

      // AC1.c — classifyMode buckets each discovered peer correctly across the
      // mixed-exclusivity set (proves the modes survived the registry → session
      // shape conversion intact, per Epic #583 W2-I3 schema-v2 mode field).
      const classByMode = Object.fromEntries(
        result.map((r) => [r.mode, classifyMode(r.mode)]),
      );
      expect(classByMode).toEqual({
        deep:         'parallel-ok',
        feature:      'parallel-ok',
        housekeeping: 'exclusive',
      });
    } finally {
      // Cleanup so the seeded registry state never leaks into sibling tests.
      for (const r of registered) await deregisterSelf(r.session_id);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — AC2 preamble fires when a real conflicting peer exists
// ---------------------------------------------------------------------------

describe('Epic #583 AC2 — preamble fires PROMOTION_OFFER for parallel-ok conflict', () => {
  it('returns outcome=PROMOTION_OFFER when caller and peer are both parallel-ok', async () => {
    const discoverImpl = async () => [
      {
        worktreePath: '/fake/peer/wt',
        sessionId:    'peer-id',
        mode:         'deep',
        startedAt:    new Date().toISOString(),
        pid:          12345,
        host:         hostname(),
        branch:       'feat/peer',
      },
    ];

    const result = await runParallelAwarePreambleFixture({
      repoRoot:        worktree2,
      callerMode:      'deep',
      callerSessionId: 'me',
      discoverImpl,
    });

    expect(result.outcome).toBe('PROMOTION_OFFER');
    expect(result.callerClass).toBe('parallel-ok');
    expect(result.parallelPeer).toBeDefined();
    expect(result.parallelPeer.sessionId).toBe('peer-id');
  });

  it('returns outcome=EXCLUSIVE_BLOCKED when peer is exclusive-class', async () => {
    const discoverImpl = async () => [
      {
        worktreePath: '/fake/peer/wt',
        sessionId:    'peer-housekeeping',
        mode:         'housekeeping',
        startedAt:    new Date().toISOString(),
        pid:          12345,
        host:         hostname(),
        branch:       'main',
      },
    ];

    const result = await runParallelAwarePreambleFixture({
      repoRoot:        worktree2,
      callerMode:      'deep',
      callerSessionId: 'me',
      discoverImpl,
    });

    expect(result.outcome).toBe('EXCLUSIVE_BLOCKED');
    expect(result.blockingSession.sessionId).toBe('peer-housekeeping');
  });

  it('returns outcome=PASS_THROUGH when no peers exist', async () => {
    const discoverImpl = async () => [];

    const result = await runParallelAwarePreambleFixture({
      repoRoot:        worktree2,
      callerMode:      'deep',
      callerSessionId: 'me',
      discoverImpl,
    });

    expect(result.outcome).toBe('PASS_THROUGH');
  });
});

// ---------------------------------------------------------------------------
// T4 — AC4 heartbeat-based liveness (NOT writer-PID liveness)
// ---------------------------------------------------------------------------

describe('Epic #583 AC4 — heartbeat-based liveness replaces writer-PID liveness', () => {
  // PID guaranteed dead on any host (well above PID_MAX 4194304 on Linux).
  const BOGUS_DEAD_PID = 999999;

  it('discovery INCLUDES a lock with a bogus dead PID but a fresh heartbeat', async () => {
    // The D2 production case: writer process (hook) is dead, but the session
    // (Claude harness) is still alive and heart-beating.
    const startedAt = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    writeLockV2(worktree1, {
      session_id:     'live-via-heartbeat',
      pid:            BOGUS_DEAD_PID,
      started_at:     startedAt,
      last_heartbeat: startedAt, // fresh ≪ TTL (4h)
    });

    const listWorktreesImpl = makeListWorktreesImpl([
      { path: worktree1, branch: 'main' },
    ]);

    const result = await discoverActiveSessions(worktree2, { listWorktreesImpl });

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('live-via-heartbeat');
    // The lock's pid IS the bogus dead value — discovery surfaced it anyway
    // because heartbeat (not PID) is the liveness signal.
    expect(result[0].pid).toBe(BOGUS_DEAD_PID);
  });

  it('discovery EXCLUDES the same lock once heartbeat is stale (>TTL)', async () => {
    const startedAt = new Date(Date.now() - 60 * 1000).toISOString();
    writeLockV2(worktree1, {
      session_id:     'stale-by-heartbeat',
      pid:            BOGUS_DEAD_PID,
      started_at:     startedAt,
      last_heartbeat: startedAt,
      ttl_hours:      4,
    });

    const listWorktreesImpl = makeListWorktreesImpl([
      { path: worktree1, branch: 'main' },
    ]);

    // Simulate 5 hours of wall-clock time passing via the `now` test seam.
    const fiveHoursAfterStart =
      Date.parse(startedAt) + 5 * 3600 * 1000;

    const result = await discoverActiveSessions(worktree2, {
      listWorktreesImpl,
      now: fiveHoursAfterStart,
    });

    expect(result).toHaveLength(0);
  });

  it('acquire() persists last_heartbeat=started_at as the lifetime indicator', async () => {
    // Production verification: a fresh acquire() must seed last_heartbeat so
    // isLockLive() returns true immediately. This is the AC4 mechanical
    // contract — the lock body carries a heartbeat-shaped lifetime signal,
    // not a "trust this ephemeral PID" signal.
    const result = acquire({
      sessionId: 'acquire-ac4-test',
      mode:      'deep',
      ttlHours:  4,
      repoRoot:  worktree1,
    });

    expect(result.ok).toBe(true);
    expect(result.lock).toBeDefined();
    expect(typeof result.lock.last_heartbeat).toBe('string');
    expect(result.lock.last_heartbeat).toBe(result.lock.started_at);

    // The lock is live by heartbeat (≪ ttl_hours).
    expect(isLockLive(result.lock)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T5 — AC3 self-consistency: preamble.md prose references the new mechanical wiring
// ---------------------------------------------------------------------------

describe('Epic #583 AC3 — parallel-aware-preamble.md prose matches runtime', () => {
  // Resolve relative to the test file so the path always works regardless of
  // where vitest is invoked from. `import.meta.dirname` is Node 20+.
  const RESOLVED_PATH = join(import.meta.dirname, '../../skills/_shared/parallel-aware-preamble.md');

  it('preamble.md exists and references discoverActiveSessions + checkPeerStateMd', () => {
    expect(existsSync(RESOLVED_PATH)).toBe(true);
    const prose = readFileSync(RESOLVED_PATH, 'utf8');

    // The preamble.md must reference the runtime functions; this guarantees
    // operators reading the SSOT see the same call-sites the implementation
    // actually uses.
    expect(prose).toContain('discoverActiveSessions');
    expect(prose).toContain('classifyMode');
    expect(prose).toContain('checkPeerStateMd');
    expect(prose).toContain('state-md-peer-guard.mjs');
    expect(prose).toContain('Phase 1b');
  });

  it('preamble.md documents the Phase 1b peer-guard decision tree', () => {
    const prose = readFileSync(RESOLVED_PATH, 'utf8');

    // The decision tree must mention the peer (non-null) branch firing AUQ.
    expect(prose).toContain('peer');
    expect(prose).toContain('Promotion AUQ');
    expect(prose).toContain('Worktree anlegen');
  });
});

// ---------------------------------------------------------------------------
// T6 — optional live-evidence check (skipped when no main worktree exists)
// ---------------------------------------------------------------------------

