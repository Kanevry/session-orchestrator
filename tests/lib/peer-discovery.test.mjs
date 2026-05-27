/**
 * tests/lib/peer-discovery.test.mjs
 *
 * Vitest suite for scripts/lib/peer-discovery.mjs (Issue #592 MED-1).
 *
 * findPeers(repoRoot, opts) unions all THREE peer-discovery surfaces into one
 * provenance-tagged flat list:
 *   - Surface A+B (lock + registry) via discoverActiveSessions
 *   - Surface C   (STATE.md)        via checkPeerStateMd
 *
 * Fixture style mirrors tests/lib/session-discovery.test.mjs (writeLock /
 * lockBody / singleWtImpl / SO_SESSION_REGISTRY_DIR isolation) and
 * tests/lib/state-md-peer-guard.test.mjs (writeStateMd / buildStateMd). No
 * real `git worktree list` is ever invoked — listWorktreesImpl is always
 * injected. The host registry is isolated to a tmp dir AND the registryReader
 * DI seam is injected, so the real ~/.config/ dir never leaks into results.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import { findPeers } from '@lib/peer-discovery.mjs';
import { repoPathHash } from '@lib/session-registry.mjs';

let repoRoot;
let registryDir;
let prevRegistryEnv;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'peer-discovery-test-'));
  // Isolate the host registry so the discoverActiveSessions fallback path does
  // not read the user's real ~/.config/session-orchestrator/sessions/.
  registryDir = mkdtempSync(join(tmpdir(), 'peer-discovery-registry-'));
  prevRegistryEnv = process.env.SO_SESSION_REGISTRY_DIR;
  process.env.SO_SESSION_REGISTRY_DIR = registryDir;
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
  if (prevRegistryEnv === undefined) {
    delete process.env.SO_SESSION_REGISTRY_DIR;
  } else {
    process.env.SO_SESSION_REGISTRY_DIR = prevRegistryEnv;
  }
});

// ---------------------------------------------------------------------------
// Lock fixtures (mirror session-discovery.test.mjs)
// ---------------------------------------------------------------------------

/** Write a session.lock at a given worktree path. */
function writeLock(wtPath, body) {
  const dir = join(wtPath, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.lock'), JSON.stringify(body, null, 2) + '\n');
}

/** Lock body factory — all required schema-v2 fields with sensible defaults. */
function lockBody(overrides = {}) {
  const nowIso = new Date().toISOString();
  return {
    session_id: 'test-session',
    started_at: nowIso,
    last_heartbeat: nowIso, // fresh by default (schema v2 liveness signal)
    mode: 'deep',
    pid: process.pid, // live writer PID by default
    host: hostname(),
    ttl_hours: 4,
    ...overrides,
  };
}

/** Build a one-element listWorktreesImpl that returns the given worktree path. */
function singleWtImpl(path, branch = 'main', head = 'abc123') {
  return async () => [{ path, branch, head }];
}

/** A registry reader that yields no entries (Surface B contributes nothing). */
const emptyRegistryReader = async () => [];

// ---------------------------------------------------------------------------
// Registry fixtures (mirror session-discovery.test.mjs Group G)
// ---------------------------------------------------------------------------

/** Build a fresh registry entry targeting the test's repoRoot. */
function regEntry(overrides = {}) {
  const nowIso = new Date().toISOString();
  return {
    session_id: 'reg-default',
    pid: 0, // registry entries default to 0 when no pid recorded → 'registry' provenance
    platform: 'claude',
    repo_path_hash: repoPathHash(repoRoot),
    repo_name: 'test-repo',
    branch: 'main',
    started_at: nowIso,
    last_heartbeat: nowIso,
    status: 'active',
    current_wave: 0,
    host_class: null,
    mode: 'feature',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// STATE.md fixtures (mirror state-md-peer-guard.test.mjs)
// ---------------------------------------------------------------------------

/** Write a STATE.md fixture under <repoRoot>/.claude/STATE.md */
function writeStateMd(repoRootPath, content) {
  const dir = join(repoRootPath, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'STATE.md'), content, 'utf8');
}

/** Build a minimal valid STATE.md frontmatter string from key/value pairs. */
function buildStateMd(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n# Body\n`;
}

/** ISO timestamp for N minutes ago. */
function minutesAgo(n) {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

/**
 * Write an ACTIVE STATE.md owned by a peer session (so checkPeerStateMd
 * returns a non-null peer for any non-matching mySessionId).
 */
function writeActivePeerStateMd(sessionId, { wave = 3, mode = 'deep', startedAt } = {}) {
  writeStateMd(repoRoot, buildStateMd({
    'schema-version': 1,
    'session-type': mode,
    'started_at': startedAt ?? minutesAgo(10),
    'status': 'active',
    'current-wave': wave,
    'session': sessionId,
  }));
}

// ---------------------------------------------------------------------------
// Group A — Single surface contributes
// ---------------------------------------------------------------------------

describe('Group A — each surface contributing in isolation', () => {
  it('A1: lock-only (live lock, empty registry, no STATE.md) → 1 peer tagged "lock"', async () => {
    writeLock(repoRoot, lockBody({ session_id: 'sess-lock-A1', pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].source).toBe('lock');
    expect(result.peers[0].sessionId).toBe('sess-lock-A1');
    expect(result.peers[0].mode).toBe('deep');
    expect(result.peers[0].host).toBe(hostname());
    expect(result.peers[0].pid).toBe(process.pid);
    expect(result.peers[0].worktreePath).toBe(repoRoot);
  });

  it('A2: registry-only (no lock, registry entry, no STATE.md) → 1 peer tagged "registry"', async () => {
    // No lock written. Registry has one fresh entry (pid:0 → registry provenance).
    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: 'sess-reg-A2', pid: 0 })],
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].source).toBe('registry');
    expect(result.peers[0].sessionId).toBe('sess-reg-A2');
    expect(result.peers[0].mode).toBe('feature');
  });

  it('A3: state-md-only (no lock, empty registry, active peer STATE.md) → 1 peer tagged "state-md"', async () => {
    writeActivePeerStateMd('sess-statemd-A3', { wave: 4, mode: 'deep' });

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].source).toBe('state-md');
    expect(result.peers[0].sessionId).toBe('sess-statemd-A3');
    expect(result.peers[0].mode).toBe('deep');
    expect(result.peers[0].currentWave).toBe(4);
    expect(typeof result.peers[0].ageHours).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Group B — Combined surfaces
// ---------------------------------------------------------------------------

describe('Group B — multiple surfaces unioned', () => {
  it('B1: all three surfaces contribute distinct sessions → 3 peers with correct provenance tags', async () => {
    writeLock(repoRoot, lockBody({ session_id: 'sess-lock-B1', pid: process.pid }));
    writeActivePeerStateMd('sess-statemd-B1', { wave: 2 });

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: 'sess-reg-B1', pid: 0 })],
    });

    expect(result.peers).toHaveLength(3);
    const bySource = Object.fromEntries(result.peers.map((p) => [p.source, p.sessionId]));
    expect(bySource).toEqual({
      'lock': 'sess-lock-B1',
      'registry': 'sess-reg-B1',
      'state-md': 'sess-statemd-B1',
    });
  });

  it('B2: STATE.md peer with SAME sessionId as a lock peer is STILL emitted separately (provenance preserved, intentional non-dedup)', async () => {
    const shared = 'sess-shared-B2';
    writeLock(repoRoot, lockBody({ session_id: shared, pid: process.pid }));
    writeActivePeerStateMd(shared, { wave: 5 });

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    // Two entries for the same sessionId — one per surface (defense-in-depth).
    expect(result.peers).toHaveLength(2);
    const sources = result.peers.map((p) => p.source).sort();
    expect(sources).toEqual(['lock', 'state-md']);
    for (const p of result.peers) {
      expect(p.sessionId).toBe(shared);
    }
  });

  it('B3: lock + registry (distinct sessions), no STATE.md → 2 peers, no "state-md" entry', async () => {
    writeLock(repoRoot, lockBody({ session_id: 'sess-lock-B3', pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: 'sess-reg-B3', pid: 0 })],
    });

    expect(result.peers).toHaveLength(2);
    const sources = result.peers.map((p) => p.source).sort();
    expect(sources).toEqual(['lock', 'registry']);
    expect(result.peers.some((p) => p.source === 'state-md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group C — Fail-open per surface (load-bearing error semantics)
// ---------------------------------------------------------------------------

describe('Group C — fail-open per surface (findPeers never throws)', () => {
  it('C1: throwing listWorktreesImpl → findPeers still RESOLVES and the STATE.md peer is still returned', async () => {
    // discoverActiveSessions is internally fail-open: a throwing listWorktrees
    // triggers its single-worktree A1 fallback (reads repoRoot's own lock).
    // We write NO lock, so Surface A+B contributes nothing — but Surface C
    // (STATE.md) must still surface its peer, proving the surfaces are
    // independent and findPeers does not reject.
    writeActivePeerStateMd('sess-statemd-C1', { wave: 1 });

    const promise = findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: async () => {
        throw new Error('boom: git worktree list failed');
      },
      registryReader: emptyRegistryReader,
    });

    // Must not reject.
    await expect(promise).resolves.toBeTruthy();
    const result = await promise;
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].source).toBe('state-md');
    expect(result.peers[0].sessionId).toBe('sess-statemd-C1');
  });

  it('C2: throwing registryReader → findPeers still resolves; lock peer survives, registry contributes nothing', async () => {
    // A throwing registryReader is swallowed inside discoverActiveSessions; the
    // live lock peer must still come through and findPeers must not reject.
    writeLock(repoRoot, lockBody({ session_id: 'sess-lock-C2', pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => {
        throw new Error('boom: registry read failed');
      },
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].source).toBe('lock');
    expect(result.peers[0].sessionId).toBe('sess-lock-C2');
  });

  it('C3: empty repo (no lock, empty registry, no STATE.md) → { peers: [] }', async () => {
    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(result).toEqual({ peers: [] });
  });
});

// ---------------------------------------------------------------------------
// Group D — Provenance-tag correctness & opts pass-through
// ---------------------------------------------------------------------------

describe('Group D — provenance heuristic & opts seams', () => {
  it('D1: discovered entry with pid:0 is tagged "registry"; entry with live pid is tagged "lock"', async () => {
    // Two worktrees: one live lock (pid>0 ⇒ 'lock'), no registry. Then a
    // separate assertion via a registry-only entry (pid:0 ⇒ 'registry').
    writeLock(repoRoot, lockBody({ session_id: 'sess-livepid-D1', pid: process.pid }));

    const lockResult = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });
    expect(lockResult.peers).toHaveLength(1);
    expect(lockResult.peers[0].source).toBe('lock');

    // Fresh repo for the registry-only assertion (avoid the lock above).
    const repo2 = mkdtempSync(join(tmpdir(), 'peer-discovery-D1b-'));
    try {
      const result = await findPeers(repo2, {
        mySessionId: 'main-2026-05-27-deep-6',
        listWorktreesImpl: singleWtImpl(repo2, 'main'),
        registryReader: async () => [{
          session_id: 'sess-zeropid-D1',
          pid: 0,
          platform: 'claude',
          repo_path_hash: repoPathHash(repo2),
          repo_name: 'test-repo',
          branch: 'main',
          started_at: new Date().toISOString(),
          last_heartbeat: new Date().toISOString(),
          status: 'active',
          current_wave: 0,
          host_class: null,
          mode: 'feature',
        }],
      });
      expect(result.peers).toHaveLength(1);
      expect(result.peers[0].source).toBe('registry');
      expect(result.peers[0].pid).toBe(0);
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  });

  it('D2: mySessionId pass-through — STATE.md owned by mySessionId is NOT flagged as a peer', async () => {
    const myId = 'main-2026-05-27-deep-6';
    // STATE.md is active but owned by US → checkPeerStateMd returns peer:null.
    writeActivePeerStateMd(myId, { wave: 3 });

    const result = await findPeers(repoRoot, {
      mySessionId: myId,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(result.peers.some((p) => p.source === 'state-md')).toBe(false);
    expect(result.peers).toEqual([]);
  });

  it('D3: maxAgeHours pass-through — an ABANDONED STATE.md (older than maxAgeHours) is NOT flagged', async () => {
    // STATE.md started 10 min ago; maxAgeHours: 0.01h (~36s) → treated abandoned.
    writeActivePeerStateMd('sess-old-D3', { wave: 2, startedAt: minutesAgo(10) });

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
      maxAgeHours: 0.01,
    });

    expect(result.peers.some((p) => p.source === 'state-md')).toBe(false);
  });

  it('D4: findPeers returns a Promise (is thenable)', () => {
    const returned = findPeers(repoRoot, {
      listWorktreesImpl: async () => [],
      registryReader: emptyRegistryReader,
    });
    expect(typeof returned.then).toBe('function');
  });

  it('D5: every emitted peer carries a source in the closed enum and a string sessionId', async () => {
    writeLock(repoRoot, lockBody({ session_id: 'sess-lock-D5', pid: process.pid }));
    writeActivePeerStateMd('sess-statemd-D5', { wave: 1 });

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: 'sess-reg-D5', pid: 0 })],
    });

    const allowed = new Set(['lock', 'registry', 'state-md']);
    expect(result.peers.length).toBeGreaterThanOrEqual(3);
    for (const p of result.peers) {
      expect(allowed.has(p.source)).toBe(true);
      expect(typeof p.sessionId).toBe('string');
      expect(p.sessionId.length).toBeGreaterThan(0);
    }
  });
});
