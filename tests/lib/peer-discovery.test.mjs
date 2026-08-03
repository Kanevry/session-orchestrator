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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPeers, checkLiveForeignSession } from '@lib/peer-discovery.mjs';
import { repoPathHash } from '@lib/session-registry.mjs';

// ---------------------------------------------------------------------------
// vi.mock for Group E (MED-4 both-surfaces-throw).
// Hoisted by Vitest: must sit before all imports. Default passes through to
// the real implementation so Groups A–D (DI-based) are undisturbed.
// ---------------------------------------------------------------------------

vi.mock('@lib/state-md-peer-guard.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, checkPeerStateMd: vi.fn(real.checkPeerStateMd) };
});

import { checkPeerStateMd } from '@lib/state-md-peer-guard.mjs';

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
    pid: 0, // registry entries default to 0 when no pid recorded (all discoverActiveSessions entries → 'discovered')
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
  it('A1: lock-only (live lock, empty registry, no STATE.md) → 1 peer tagged "discovered"', async () => {
    writeLock(repoRoot, lockBody({ session_id: 'sess-lock-A1', pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].source).toBe('discovered');
    expect(result.peers[0].sessionId).toBe('sess-lock-A1');
    expect(result.peers[0].mode).toBe('deep');
    expect(result.peers[0].host).toBe(hostname());
    expect(result.peers[0].pid).toBe(process.pid);
    expect(result.peers[0].worktreePath).toBe(repoRoot);
  });

  it('A2: registry-only (no lock, registry entry, no STATE.md) → 1 peer tagged "discovered"', async () => {
    // No lock written. Registry has one fresh entry — all discoverActiveSessions
    // results are tagged 'discovered' regardless of pid value (#594 Option A).
    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: 'sess-reg-A2', pid: 0 })],
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].source).toBe('discovered');
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
    // lock + registry both become 'discovered' (#594 Option A); STATE.md stays 'state-md'.
    writeLock(repoRoot, lockBody({ session_id: 'sess-lock-B1', pid: process.pid }));
    writeActivePeerStateMd('sess-statemd-B1', { wave: 2 });

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: 'sess-reg-B1', pid: 0 })],
    });

    expect(result.peers).toHaveLength(3);
    // Two 'discovered' entries (lock + registry), one 'state-md' entry.
    const discoveredIds = result.peers
      .filter((p) => p.source === 'discovered')
      .map((p) => p.sessionId)
      .sort();
    expect(discoveredIds).toEqual(['sess-lock-B1', 'sess-reg-B1'].sort());
    const stateMdPeer = result.peers.find((p) => p.source === 'state-md');
    expect(stateMdPeer).toBeDefined();
    expect(stateMdPeer.sessionId).toBe('sess-statemd-B1');
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
    expect(sources).toEqual(['discovered', 'state-md']);
    for (const p of result.peers) {
      expect(p.sessionId).toBe(shared);
    }
  });

  it('B3: lock + registry (distinct sessions), no STATE.md → 2 peers, no "state-md" entry', async () => {
    // Both lock and registry entries become 'discovered' (#594 Option A).
    writeLock(repoRoot, lockBody({ session_id: 'sess-lock-B3', pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: 'sess-reg-B3', pid: 0 })],
    });

    expect(result.peers).toHaveLength(2);
    const sources = result.peers.map((p) => p.source).sort();
    expect(sources).toEqual(['discovered', 'discovered']);
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
    expect(result.peers[0].source).toBe('discovered');
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
  it('D1: all discoverActiveSessions entries (live pid or pid:0) are tagged "discovered"', async () => {
    // #594 Option A: lock + registry distinction is NOT recoverable from the
    // discoverActiveSessions return value (irreversibly merged upstream). Both
    // a live-pid lock entry AND a pid:0 registry-only entry must yield 'discovered'.
    writeLock(repoRoot, lockBody({ session_id: 'sess-livepid-D1', pid: process.pid }));

    const lockResult = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });
    expect(lockResult.peers).toHaveLength(1);
    expect(lockResult.peers[0].source).toBe('discovered');

    // Fresh repo for the registry-only assertion (pid:0 also tagged 'discovered').
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
      expect(result.peers[0].source).toBe('discovered');
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

    const allowed = new Set(['discovered', 'state-md']);
    expect(result.peers.length).toBeGreaterThanOrEqual(3);
    for (const p of result.peers) {
      expect(allowed.has(p.source)).toBe(true);
      expect(typeof p.sessionId).toBe('string');
      expect(p.sessionId.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Group E — MED-4: both-surfaces-throw → resolves { peers: [] }
//
// Mechanism: vi.mock (hoisted at top of file) wraps checkPeerStateMd in a
// vi.fn that delegates to the real implementation by default. For the test
// below, mockImplementationOnce is used to force a throw from the state-md
// surface. The discovered surface is broken via the DI seam (listWorktreesImpl
// throws), which triggers discoverActiveSessions's A1 fallback — and since no
// lock exists, A1 contributes nothing. Net result: both surfaces contribute
// nothing and findPeers resolves { peers: [] }.
//
// Surviving mutations this test kills:
//   M1: Remove the try/catch around discoverActiveSessions → findPeers rejects
//       (test fails because .resolves would reject)
//   M2: Remove the try/catch around checkPeerStateMd → findPeers rejects
//       (test fails because .resolves would reject)
// ---------------------------------------------------------------------------

describe('Group E — MED-4: both surfaces throw → findPeers RESOLVES { peers: [] }', () => {
  it('E1: listWorktreesImpl throws AND checkPeerStateMd throws → resolves { peers: [] } (never rejects)', async () => {
    // Break Surface C (STATE.md) via vi.mock — override for this call only.
    vi.mocked(checkPeerStateMd).mockImplementationOnce(() => {
      throw new Error('boom: checkPeerStateMd exploded');
    });

    // Break Surface A+B (discovered) via DI seam — no lock written, so the
    // A1 fallback contributes nothing even after the throw is caught.
    const promise = findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: async () => {
        throw new Error('boom: git worktree list failed');
      },
      registryReader: emptyRegistryReader,
    });

    // findPeers must RESOLVE (not reject) even when both surfaces throw.
    await expect(promise).resolves.toEqual({ peers: [] });
  });
});

// ---------------------------------------------------------------------------
// Group F — LOW: freshnessMin opts pass-through
//
// findPeers forwards opts.freshnessMin to discoverActiveSessions, which passes
// it into isRegistryEntryFresh. An entry whose last_heartbeat is ~20 min old
// passes the 60-min threshold but fails the 15-min threshold.
//
// Surviving mutation this test kills:
//   M: Change `freshnessMin: opts.freshnessMin` → `freshnessMin: undefined` in
//   findPeers (~L127). When undefined, discoverActiveSessions defaults to 15 min.
//   The F2 assertion (freshnessMin:60 → peer present) would still pass, but the
//   F1 assertion (freshnessMin:15 → peer absent) would fail because the 20-min-
//   old entry would be filtered out by the 15-min default instead of being
//   kept — violating the CONTROL property of the test. Specifically: F1 asserts
//   peers===0, which would ALSO hold when freshnessMin is defaulted to 15 — so
//   only F2 (peers===1 with freshnessMin:60) is the mutation-killing assertion.
//   The two sub-tests together form a control-treatment pair that kills the
//   mutation: F2 establishes the entry IS present when threshold is broad
//   enough, proving the forwarding matters.
// ---------------------------------------------------------------------------

describe('Group F — LOW: freshnessMin pass-through to discoverActiveSessions', () => {
  /** Registry entry whose last_heartbeat is exactly 20 minutes ago. */
  function staleEntry20min(repoRootPath) {
    const heartbeat20MinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    return {
      session_id: 'reg-fresh-F',
      pid: 0,
      platform: 'claude',
      repo_path_hash: repoPathHash(repoRootPath),
      repo_name: 'test-repo',
      branch: 'main',
      started_at: heartbeat20MinAgo,
      last_heartbeat: heartbeat20MinAgo,
      status: 'active',
      current_wave: 0,
      host_class: null,
      mode: 'feature',
    };
  }

  it('F1: registry entry aged 20 min is EXCLUDED when freshnessMin: 15', async () => {
    // With freshnessMin:15, a 20-min-old heartbeat is stale → filtered out.
    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [staleEntry20min(repoRoot)],
      freshnessMin: 15,
    });

    expect(result.peers.filter((p) => p.source === 'discovered')).toHaveLength(0);
  });

  it('F2: same registry entry aged 20 min IS INCLUDED when freshnessMin: 60', async () => {
    // Control: freshnessMin:60 is broader than 20 min → entry must survive.
    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [staleEntry20min(repoRoot)],
      freshnessMin: 60,
    });

    const discovered = result.peers.filter((p) => p.source === 'discovered');
    expect(discovered).toHaveLength(1);
    expect(discovered[0].sessionId).toBe('reg-fresh-F');
  });

  // -------------------------------------------------------------------------
  // F3 (#599): freshnessMin:0 boundary — a 0-minute window EXCLUDES even a
  // near-fresh entry. isRegistryEntryFresh uses `_ageMinutes <= freshnessMin`
  // (session-registry.mjs:268), and session-discovery.mjs:169 guards the
  // freshnessMin default with `typeof opts.freshnessMin === 'number' ? ... : 15`
  // — NOT a truthy-coercion. `now` is pinned and the heartbeat is set 1ms
  // EARLIER (age ≈ 0.0000167 min, strictly > 0), so:
  //   - freshnessMin:0 (correct): 0.0000167 <= 0 is FALSE → EXCLUDED (0 peers).
  //   - mutation `freshnessMin || 15` (0 coerced → 15): 0.0000167 <= 15 is TRUE
  //     → INCLUDED (1 peer) → the toHaveLength(0) assertion FAILS.
  // NOTE: the heartbeat MUST be strictly before `now` — an EXACTLY-equal
  // heartbeat gives age 0 and `0 <= 0` is TRUE (included), which would mask the
  // boundary. The 1ms offset makes the test deterministic regardless of the
  // wall clock (no reliance on the fixture-vs-call timing gap).
  // -------------------------------------------------------------------------
  it('F3: a near-fresh registry entry (heartbeat 1ms before now) is EXCLUDED when freshnessMin: 0', async () => {
    const nowMs = Date.parse('2026-05-27T12:00:00.000Z');
    const heartbeat1msBeforeNow = new Date(nowMs - 1).toISOString();
    const nearFreshEntry = {
      session_id: 'reg-nearfresh-F3',
      pid: 0,
      platform: 'claude',
      repo_path_hash: repoPathHash(repoRoot),
      repo_name: 'test-repo',
      branch: 'main',
      started_at: heartbeat1msBeforeNow,
      last_heartbeat: heartbeat1msBeforeNow,
      status: 'active',
      current_wave: 0,
      host_class: null,
      mode: 'feature',
    };

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [nearFreshEntry],
      freshnessMin: 0,
      now: nowMs,
    });

    expect(result.peers.filter((p) => p.source === 'discovered')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Group G — LOW R3-2: reason threaded onto state-md peer entry
//
// findPeers now includes `reason` from checkPeerStateMd on the emitted
// 'state-md' peer entry. checkPeerStateMd returns reason: 'ACTIVE peer detected'
// when an active foreign peer is found.
//
// Surviving mutation this test kills:
//   M: Remove `reason` from the emitted state-md entry in findPeers (~L160).
//   G1's `.toEqual` assertion on `reason: 'ACTIVE peer detected'` fails.
// ---------------------------------------------------------------------------

describe('Group G — LOW R3-2: reason field threaded onto state-md peer entry', () => {
  it('G1: state-md peer entry carries reason: "ACTIVE peer detected" from checkPeerStateMd', async () => {
    writeActivePeerStateMd('sess-statemd-G1', { wave: 2, mode: 'deep' });

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(result.peers).toHaveLength(1);
    const stateMdPeer = result.peers[0];
    expect(stateMdPeer.source).toBe('state-md');
    expect(stateMdPeer.sessionId).toBe('sess-statemd-G1');
    // reason must be threaded from checkPeerStateMd onto the emitted entry.
    expect(stateMdPeer.reason).toBe('ACTIVE peer detected');
  });

  it('G2: discovered peers do NOT carry a reason field (reason is state-md-only)', async () => {
    writeLock(repoRoot, lockBody({ session_id: 'sess-lock-G2', pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: 'main-2026-05-27-deep-6',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(result.peers).toHaveLength(1);
    const discoveredPeer = result.peers[0];
    expect(discoveredPeer.source).toBe('discovered');
    // 'discovered' peers have no reason field — checkPeerStateMd is not called for them.
    expect(discoveredPeer.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group H — self-exclusion (#798)
//
// Root cause: findPeers extracts `mySessionId` and threads it into Surface C
// (checkPeerStateMd, correctly self-excluding), but the Surface A+B loop
// (discoverActiveSessions results) never compares `s.sessionId` against
// `mySessionId` — every discovered entry, INCLUDING the caller's own
// session.lock / registry heartbeat, is unconditionally pushed as a
// source:'discovered' peer. Live repro: a session's own SessionStart-hook
// heartbeat comes back as a peer of itself.
//
// Prior art for the same guard elsewhere in the repo:
//   - session-registry.mjs detectPeers(): `if (sessionId && e.session_id ===
//     sessionId) return false;`
//   - hooks/on-session-start.mjs: `allActive.filter((s) => s.sessionId !==
//     sessionId)`
// ---------------------------------------------------------------------------

describe('Group H — self-exclusion (#798)', () => {
  const MY_SESSION_ID = 'dd3ebe61-6095-409f-8f60-6581dee998b9';

  it('H1: lock-sourced entry with session_id === mySessionId (live pid, fresh heartbeat) → excluded from peers', async () => {
    writeLock(repoRoot, lockBody({ session_id: MY_SESSION_ID, pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: MY_SESSION_ID,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    // No STATE.md written, no foreign entries — self-lock must not surface as a peer.
    expect(result.peers).toEqual([]);
  });

  it('H2: registry-only entry with session_id === mySessionId (exact #798 repro shape) → excluded from peers', async () => {
    // No lock written — registry is the sole discovered-surface contributor,
    // matching the live #798 repro (own registry heartbeat, source:'discovered').
    const result = await findPeers(repoRoot, {
      mySessionId: MY_SESSION_ID,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: MY_SESSION_ID })],
    });

    expect(result.peers).toEqual([]);
  });

  it('H3 (regression guard): a foreign live peer via lock AND via registry remains present (no over-filtering)', async () => {
    writeLock(repoRoot, lockBody({ session_id: 'sess-foreign-lock-H3', pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: MY_SESSION_ID,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: 'sess-foreign-reg-H3' })],
    });

    expect(result.peers).toHaveLength(2);
    const discoveredIds = result.peers
      .filter((p) => p.source === 'discovered')
      .map((p) => p.sessionId)
      .sort();
    expect(discoveredIds).toEqual(['sess-foreign-lock-H3', 'sess-foreign-reg-H3'].sort());
  });

  it('H4: lock and registry entries both share session_id === mySessionId → 0 discovered self-entries in the result', async () => {
    writeLock(repoRoot, lockBody({ session_id: MY_SESSION_ID, pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: MY_SESSION_ID,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [regEntry({ session_id: MY_SESSION_ID })],
    });

    expect(result.peers.filter((p) => p.source === 'discovered')).toHaveLength(0);
    expect(result.peers).toEqual([]);
  });

  it('H5: mySessionId: null → a foreign discovered entry comes back unfiltered (guard against over-eager null handling)', async () => {
    writeLock(repoRoot, lockBody({ session_id: 'sess-foreign-H5', pid: process.pid }));

    const result = await findPeers(repoRoot, {
      mySessionId: null,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].source).toBe('discovered');
    expect(result.peers[0].sessionId).toBe('sess-foreign-H5');
  });
});

// ---------------------------------------------------------------------------
// Group I — checkLiveForeignSession (#908)
//
// One question, three ways to answer it wrongly — each of the first three
// tests pins one of them:
//
//   I1  id-space: findPeers self-excludes on Surface A+B against the lock UUID
//       only. A caller passing its SEMANTIC id gets its own heartbeat back as a
//       "peer" of itself (observed live). checkLiveForeignSession must derive
//       the ids from the lock and ignore what the caller passes.
//   I2/I3 liveness: heartbeat, never PID. A dead lease is NOT live (I2); a
//       fresh heartbeat with a DEAD pid IS live (I3) — session-discovery.mjs
//       module header, #799 "explicit NO-GO, do not re-attempt".
//   I5/I6 double-count: findPeers deliberately does not dedupe across sources,
//       so one session can appear as both 'discovered' and 'state-md'. A raw
//       peers.length over-counts (I5) and treats a leftover STATE.md as a
//       running session (I6).
//
// I4 pins that a foreign repo takes the cheap two-sync-call path (no git),
// I7/I8/I9 pin the fail-safe direction: unmeasurable ⇒ live:true, while a
// successful measurement that found nothing ⇒ live:false.
// ---------------------------------------------------------------------------

describe('Group I — checkLiveForeignSession (#908)', () => {
  const MY_UUID = 'dd3ebe61-6095-409f-8f60-6581dee998b9';
  const MY_SEMANTIC = 'main-2026-07-29-deep-1';

  /** Pinned clock — all lock-path assertions are time-controlled, never waited out. */
  const NOW = Date.parse('2026-07-29T12:00:00.000Z');

  /** A pid that can never be live: above pid_max on both macOS and Linux. */
  const DEAD_PID = 2147483647;

  /** ISO timestamp `h` hours before `ms`. */
  function hoursBefore(ms, h) {
    return new Date(ms - h * 3600 * 1000).toISOString();
  }

  /** A cwd OUTSIDE repoRoot — makes repoRoot a foreign working copy. */
  let foreignCwd;

  beforeEach(() => {
    foreignCwd = mkdtempSync(join(tmpdir(), 'peer-discovery-cwd-'));
  });

  afterEach(() => {
    rmSync(foreignCwd, { recursive: true, force: true });
  });

  /**
   * Registry entry keyed to the CANONICAL (realpath'd) repo root. The real
   * registry writer hashes the path it got from process.cwd(), which is
   * symlink-free — on macOS the tmp path (/var/…) and its realpath
   * (/private/var/…) hash differently, so the fixture must use the canonical
   * form to mirror a production record.
   */
  function ownRepoRegEntry(overrides = {}) {
    return {
      ...regEntry(),
      repo_path_hash: repoPathHash(realpathSync(repoRoot)),
      ...overrides,
    };
  }

  it('I1: own repo — caller passes its SEMANTIC id (wrong id-space); own UUID lock AND own semantic-id registry entry are both self-excluded', async () => {
    // The live #798/#908 shape: the lock carries the UUID, the caller only has
    // the semantic id. Additionally a registry entry recorded under the
    // SEMANTIC id (as a non-Claude harness would write it) — findPeers cannot
    // exclude that one from the UUID alone, so the post-filter must.
    writeLock(repoRoot, lockBody({
      session_id: MY_UUID,
      semantic_session_id: MY_SEMANTIC,
      pid: process.pid,
    }));

    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: repoRoot,
      mySessionId: MY_SEMANTIC, // ← exactly the mistake made live
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [ownRepoRegEntry({ session_id: MY_SEMANTIC })],
    });

    expect(verdict.probe).toBe('full');
    expect(verdict.live).toBe(false);
    expect(verdict.reason).toBe('no-peers');
    expect(verdict.peerCount).toBe(0);
    expect(verdict.peer).toBeNull();
  });

  it('I1b: own repo — a caller-supplied id can NEVER suppress a real peer (mySessionId is ignored, not trusted)', async () => {
    // Control for I1: proves the self-exclusion is not just "filter everything".
    // The caller claims the FOREIGN session's id as its own; an implementation
    // that forwarded mySessionId would drop the peer and report live:false.
    writeLock(repoRoot, lockBody({
      session_id: MY_UUID,
      semantic_session_id: MY_SEMANTIC,
      pid: process.pid,
    }));

    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: repoRoot,
      mySessionId: 'sess-foreign-I1b',
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [ownRepoRegEntry({ session_id: 'sess-foreign-I1b' })],
    });

    expect(verdict.live).toBe(true);
    expect(verdict.reason).toBe('live-peer-discovered');
    expect(verdict.peerCount).toBe(1);
    expect(verdict.peer.sessionId).toBe('sess-foreign-I1b');
  });

  it('I2: foreign repo — lock whose heartbeat is older than ttl_hours is NOT live (time-controlled, same fixture live under an earlier clock)', async () => {
    writeLock(repoRoot, lockBody({
      session_id: 'sess-foreign-I2',
      started_at: hoursBefore(NOW, 6),
      last_heartbeat: hoursBefore(NOW, 5),
      ttl_hours: 4,
      pid: process.pid,
    }));

    const expired = await checkLiveForeignSession(repoRoot, { cwd: foreignCwd, now: NOW });
    expect(expired.live).toBe(false);
    expect(expired.reason).toBe('lock-expired');
    expect(expired.peerCount).toBe(0);

    // Control: identical lock, clock rewound 4h → heartbeat is 1h old → live.
    // Proves the fixture is otherwise valid and the verdict tracks the clock.
    const live = await checkLiveForeignSession(repoRoot, {
      cwd: foreignCwd,
      now: NOW - 4 * 3600 * 1000,
    });
    expect(live.live).toBe(true);
    expect(live.reason).toBe('live-peer-lock');
  });

  it('I3: foreign repo — fresh heartbeat + DEAD pid counts as LIVE (#799 NO-GO: pid is the hook pid, not the session pid)', async () => {
    // Precondition: the pid really is dead, so the assertion below is faithful
    // rather than a lucky coincidence.
    expect(() => process.kill(DEAD_PID, 0)).toThrow();

    writeLock(repoRoot, lockBody({
      session_id: 'sess-deadpid-I3',
      started_at: hoursBefore(NOW, 2),
      last_heartbeat: hoursBefore(NOW, 0.5),
      ttl_hours: 4,
      pid: DEAD_PID,
    }));

    const verdict = await checkLiveForeignSession(repoRoot, { cwd: foreignCwd, now: NOW });

    expect(verdict.live).toBe(true);
    expect(verdict.reason).toBe('live-peer-lock');
    expect(verdict.peer.pid).toBe(DEAD_PID);
    // ageHours is session age (from started_at) — the string a consumer needs
    // for "live foreign session, 2h old" without measuring a second time.
    expect(verdict.peer.ageHours).toBeCloseTo(2, 6);
  });

  it('I4: foreign repo takes the cheap path — findPeers is never invoked and the verdict still comes from the lock', async () => {
    writeLock(repoRoot, lockBody({
      session_id: 'sess-foreign-I4',
      started_at: hoursBefore(NOW, 3),
      last_heartbeat: hoursBefore(NOW, 1),
      pid: process.pid,
    }));

    const findPeersCalls = [];

    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: foreignCwd,
      now: NOW,
      // Returns an EMPTY peer list: if the full path were taken, the verdict
      // would be live:false — so live:true proves the lock answered it.
      findPeersImpl: async (...args) => {
        findPeersCalls.push(args);
        return { peers: [] };
      },
      listWorktreesImpl: async () => {
        throw new Error('git worktree list must not run on the cheap path');
      },
    });

    expect(findPeersCalls).toHaveLength(0);
    expect(verdict.probe).toBe('lock-only');
    expect(verdict.live).toBe(true);
    expect(verdict.peer.sessionId).toBe('sess-foreign-I4');
  });

  it('I5: own repo — one session seen by BOTH surfaces counts ONCE (raw peers.length would be 2)', async () => {
    // findPeers emits the same sessionId twice by design (defense-in-depth
    // provenance, see module header) — the source filter is what keeps the
    // count honest.
    writeLock(repoRoot, lockBody({ session_id: MY_UUID, pid: process.pid }));
    writeActivePeerStateMd('sess-dup-I5', { wave: 3 });

    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: repoRoot,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [ownRepoRegEntry({ session_id: 'sess-dup-I5' })],
    });

    expect(verdict.live).toBe(true);
    expect(verdict.peerCount).toBe(1);
    expect(verdict.peer.source).toBe('discovered');
    expect(verdict.peer.sessionId).toBe('sess-dup-I5');
  });

  it('I6: own repo — an active STATE.md with no live lock behind it is NOT a running session', async () => {
    // A committed STATE.md outlives the session that wrote it (crash → stale
    // artifact). Only 'discovered' (live lock / fresh registry heartbeat) is
    // evidence of a RUNNING peer.
    writeLock(repoRoot, lockBody({ session_id: MY_UUID, pid: process.pid }));
    writeActivePeerStateMd('sess-statemd-only-I6', { wave: 2 });

    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: repoRoot,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(verdict.live).toBe(false);
    expect(verdict.reason).toBe('no-peers');
    expect(verdict.peerCount).toBe(0);
  });

  it('I7: fail-safe — every state that PREVENTS measurement yields live:true', async () => {
    // (a) lock present but unparseable: something wrote it, liveness unknowable.
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoRoot, '.orchestrator', 'session.lock'), '{ truncated', 'utf8');
    const corrupt = await checkLiveForeignSession(repoRoot, { cwd: foreignCwd, now: NOW });
    expect(corrupt).toMatchObject({ live: true, reason: 'lock-unreadable', probe: 'none' });

    // (b) repo root gone (unmounted / renamed / racing worktree removal).
    const missing = await checkLiveForeignSession(join(repoRoot, 'no-such-dir'), {
      cwd: foreignCwd,
      now: NOW,
    });
    expect(missing).toMatchObject({ live: true, reason: 'repo-root-missing', probe: 'none' });

    // (c) unusable argument.
    const invalid = await checkLiveForeignSession('', { cwd: foreignCwd, now: NOW });
    expect(invalid).toMatchObject({ live: true, reason: 'invalid-repo-root', probe: 'none' });
  });

  it('I8: absence of a lock is a MEASUREMENT, not an unknown → live:false (guards against a fail-safe that always says true)', async () => {
    const verdict = await checkLiveForeignSession(repoRoot, { cwd: foreignCwd, now: NOW });

    expect(verdict).toEqual({
      live: false,
      reason: 'no-lock',
      probe: 'lock-only',
      peerCount: 0,
      peer: null,
    });
  });

  it('I9: never throws — a throwing findPeers resolves to the fail-safe verdict', async () => {
    writeLock(repoRoot, lockBody({ session_id: MY_UUID, pid: process.pid }));

    const promise = checkLiveForeignSession(repoRoot, {
      cwd: repoRoot,
      findPeersImpl: async () => {
        throw new Error('boom: findPeers regressed');
      },
    });

    await expect(promise).resolves.toMatchObject({ live: true, reason: 'probe-error' });
  });

  // -------------------------------------------------------------------------
  // I10 / I10b — own-vs-foreign is REPO IDENTITY, not path containment.
  //
  // The full probe's peer enumeration runs `git worktree list` in
  // process.cwd() (worktree/listing.mjs:31 — `dollar({ cwd: process.cwd() })`),
  // so it only ever measures the working copy the PROCESS is in. Selecting it
  // for a repo that merely CONTAINS (or is contained by) the cwd measures the
  // wrong repository and reports its emptiness as the target's verdict.
  //
  // Reachable on a real host (verified 2026-07-29): the portfolio workspace
  // directory one level above this repo is itself a git repo with its own
  // `.orchestrator/` state — `ls -d <workspace>/.git` and
  // `ls <workspace>/.orchestrator` both succeed — and it is an ancestor of the
  // process cwd, so pure containment classified it as "my working copy".
  // -------------------------------------------------------------------------

  it('I10: an ANCESTOR directory that is a DIFFERENT repo is foreign — its live lock must be seen (containment ≠ identity)', async () => {
    // ancestor/ is its own working copy with a live lock; child/ is a separate
    // working copy nested inside it and is the cwd.
    const ancestor = mkdtempSync(join(tmpdir(), 'peer-ancestor-'));
    try {
      mkdirSync(join(ancestor, '.git'));
      writeLock(ancestor, lockBody({
        session_id: 'sess-ancestor-I10',
        started_at: hoursBefore(NOW, 2),
        last_heartbeat: hoursBefore(NOW, 0.5),
        ttl_hours: 4,
        pid: process.pid,
      }));

      const child = join(ancestor, 'child-repo');
      mkdirSync(child);
      mkdirSync(join(child, '.git'));

      // Models what the full probe actually yields here: it enumerates the
      // CHILD's worktrees, finds nothing about the ancestor, and would report
      // `no-peers` / live:false while the ancestor's lock is fresh.
      const findPeersCalls = [];

      const verdict = await checkLiveForeignSession(ancestor, {
        cwd: child,
        now: NOW,
        findPeersImpl: async (...args) => {
          findPeersCalls.push(args);
          return { peers: [] };
        },
      });

      expect(findPeersCalls).toHaveLength(0);
      expect(verdict.probe).toBe('lock-only');
      expect(verdict.live).toBe(true);
      expect(verdict.reason).toBe('live-peer-lock');
      expect(verdict.peer.sessionId).toBe('sess-ancestor-I10');
    } finally {
      rmSync(ancestor, { recursive: true, force: true });
    }
  });

  it('I10b: control — a SUBDIRECTORY of the same working copy still selects the full probe (the fix is identity, not "always lock-only")', async () => {
    mkdirSync(join(repoRoot, '.git'));
    const sub = join(repoRoot, 'scripts', 'lib');
    mkdirSync(sub, { recursive: true });
    writeLock(repoRoot, lockBody({ session_id: MY_UUID, pid: process.pid }));

    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: sub,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: async () => [ownRepoRegEntry({ session_id: 'sess-foreign-I10b' })],
    });

    expect(verdict.probe).toBe('full');
    expect(verdict.live).toBe(true);
    expect(verdict.peer.sessionId).toBe('sess-foreign-I10b');
  });

  // -------------------------------------------------------------------------
  // I11 — the full path must not report "nobody home" when the discovered
  // surface produced literally nothing although our OWN live lock had to be in
  // it (A1 fallback guarantees the own worktree is read even when git fails).
  // -------------------------------------------------------------------------

  it('I11: own repo — discovered surface returns nothing although our own live lock exists → degraded, not "no peers"', async () => {
    writeLock(repoRoot, lockBody({
      session_id: MY_UUID,
      started_at: hoursBefore(NOW, 2),
      last_heartbeat: hoursBefore(NOW, 0.5),
      ttl_hours: 4,
      pid: process.pid,
    }));

    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: repoRoot,
      now: NOW,
      // Both surfaces broke internally: findPeers fails open per surface and
      // can only ever say `{ peers: [] }` — indistinguishable from "measured,
      // found nothing" WITHOUT the own-lock canary.
      findPeersImpl: async () => ({ peers: [] }),
    });

    expect(verdict.live).toBe(true);
    expect(verdict.reason).toBe('probe-degraded');
    expect(verdict.probe).toBe('full-degraded');
    expect(verdict.peerCount).toBe(0);
  });

  it('I11b: control — the canary is satisfied by our own entry, so a genuinely quiet repo still reports live:false', async () => {
    // Same live own lock as I11; this time the surface DOES return it. The
    // verdict must stay `no-peers` — otherwise the canary would be a
    // "fail-safe that always says true" (the I8 failure mode, full-path twin).
    writeLock(repoRoot, lockBody({
      session_id: MY_UUID,
      started_at: hoursBefore(NOW, 2),
      last_heartbeat: hoursBefore(NOW, 0.5),
      ttl_hours: 4,
      pid: process.pid,
    }));

    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: repoRoot,
      now: NOW,
      listWorktreesImpl: singleWtImpl(repoRoot, 'main'),
      registryReader: emptyRegistryReader,
    });

    expect(verdict.live).toBe(false);
    expect(verdict.reason).toBe('no-peers');
    expect(verdict.probe).toBe('full');
  });

  // -------------------------------------------------------------------------
  // I12 — #919.3 residual-gap closure. The I11 canary needs a live own lock to
  // assert against; with NO lock, "total surface failure" and "quiet repo"
  // used to be the same empty list → `no-peers` / live:false after measuring
  // NOTHING (the documented residual gap, W5/F3). Now the full path confirms
  // via the listWorktrees error signal that `git worktree list` actually RAN
  // before it is allowed to say "nobody home".
  // -------------------------------------------------------------------------

  it('I12: own repo, NO own lock — git worktree list FAILS → degraded (fail-safe), not "no peers"', async () => {
    // No lock written: the canary cannot assert. The git surface is broken via
    // the same DI seam findPeers forwards — exactly the state the bare
    // listWorktrees swallows into [].
    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: repoRoot,
      now: NOW,
      listWorktreesImpl: async () => {
        throw new Error('git exploded (#919.3)');
      },
      registryReader: emptyRegistryReader,
    });

    expect(verdict.live).toBe(true);
    expect(verdict.reason).toBe('probe-degraded');
    expect(verdict.probe).toBe('full-degraded');
    expect(verdict.peerCount).toBe(0);
  });

  it('I12b: control — own repo, NO own lock, git RAN and found nothing → still live:false (a measurement, not an unknown)', async () => {
    // Same lockless fixture; this time the git surface WORKS and is genuinely
    // empty. The verdict must stay `no-peers` — otherwise the confirmation
    // would be a "fail-safe that always says true" (the I8/I11b failure mode).
    const verdict = await checkLiveForeignSession(repoRoot, {
      cwd: repoRoot,
      now: NOW,
      listWorktreesImpl: async () => [],
      registryReader: emptyRegistryReader,
    });

    expect(verdict.live).toBe(false);
    expect(verdict.reason).toBe('no-peers');
    expect(verdict.probe).toBe('full');
    expect(verdict.peerCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group J — CLI entry (#908 Befund 3)
//
// The staleness-annotation rule (skills/wave-executor/wave-loop.md, Trigger 3)
// is executed by a coordinator LLM, which has Bash and cannot run an ESM
// `import`. Without an executable entry point the rule is inert. Contract
// mirrors scripts/lib/fetch-baseline.mjs (a lib module with a documented CLI):
// data → stdout, diagnostics → stderr, exit 0 = probe ran, 1 = usage error.
// ---------------------------------------------------------------------------

describe('Group J — checkLiveForeignSession CLI entry (#908)', () => {
  const CLI = fileURLToPath(new URL('../../scripts/lib/peer-discovery.mjs', import.meta.url));

  /** Run the CLI with the test's registry isolation intact. */
  function runCli(args) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, SO_SESSION_REGISTRY_DIR: registryDir },
    });
  }

  it('J1: --check-live --json on a lock-free repo → exit 0 and a parseable verdict on stdout', () => {
    const foreignCwd = mkdtempSync(join(tmpdir(), 'peer-cli-cwd-'));
    try {
      const res = runCli(['--check-live', repoRoot, '--cwd', foreignCwd, '--json']);

      expect(res.status).toBe(0);
      const verdict = JSON.parse(res.stdout);
      expect(verdict).toEqual({
        live: false,
        reason: 'no-lock',
        probe: 'lock-only',
        peerCount: 0,
        peer: null,
      });
    } finally {
      rmSync(foreignCwd, { recursive: true, force: true });
    }
  });

  it('J2: --check-live --json on a repo with a live lock → live:true (exit stays 0 — the verdict is the payload, not the exit code)', () => {
    const foreignCwd = mkdtempSync(join(tmpdir(), 'peer-cli-cwd-'));
    try {
      writeLock(repoRoot, lockBody({ session_id: 'sess-cli-J2', pid: process.pid }));

      const res = runCli(['--check-live', repoRoot, '--cwd', foreignCwd, '--json']);

      expect(res.status).toBe(0);
      const verdict = JSON.parse(res.stdout);
      expect(verdict.live).toBe(true);
      expect(verdict.reason).toBe('live-peer-lock');
      expect(verdict.peer.sessionId).toBe('sess-cli-J2');
    } finally {
      rmSync(foreignCwd, { recursive: true, force: true });
    }
  });

  it('J3: missing <repoRoot> operand → exit 1, message on stderr, stdout stays empty (pipe-safe)', () => {
    const res = runCli(['--check-live']);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--check-live');
  });

  it('J4: no mode flag → exit 1 usage error (the module is a library first; the CLI is opt-in)', () => {
    const res = runCli([]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
  });

  it('J5: human (non---json) output names the verdict fields on stdout', () => {
    const foreignCwd = mkdtempSync(join(tmpdir(), 'peer-cli-cwd-'));
    try {
      const res = runCli(['--check-live', repoRoot, '--cwd', foreignCwd]);

      expect(res.status).toBe(0);
      expect(res.stdout).toContain('live=false');
      expect(res.stdout).toContain('reason=no-lock');
      expect(res.stdout).toContain('probe=lock-only');
    } finally {
      rmSync(foreignCwd, { recursive: true, force: true });
    }
  });
});
