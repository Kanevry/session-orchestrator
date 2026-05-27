/**
 * tests/lib/session-discovery.test.mjs
 *
 * Vitest suite for scripts/lib/session-discovery.mjs (issue #569 P1.1).
 *
 * Covers: happy-path discovery (live sessions, dead-PID filtering, cross-host
 * policy, multi-worktree enumeration, edge cases, branch propagation, TTL
 * ignorance, exported constant).
 *
 * Timeout and fallback paths are covered separately in
 * tests/lib/session-discovery-fallback.test.mjs (Q3 scope — do NOT add
 * fallback tests here).
 *
 * All listWorktrees calls are replaced via opts.listWorktreesImpl — no real
 * `git worktree list` is ever invoked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  discoverActiveSessions,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
} from '@lib/session-discovery.mjs';

// A PID guaranteed to be dead on any machine (kernel would never assign this).
const DEAD_PID = 999999;

let repoRoot;
let registryDir;
let prevRegistryEnv;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'session-discovery-test-'));
  // Isolate the session-registry to a tmp dir so tests are not affected by
  // entries in the user's real `~/.config/session-orchestrator/sessions/`.
  // The registry fallback path (Epic #583, W2-I3) consults readRegistry()
  // for every discoverActiveSessions() call; without isolation, real
  // entries can leak into test results.
  registryDir = mkdtempSync(join(tmpdir(), 'session-discovery-registry-'));
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
// Helpers
// ---------------------------------------------------------------------------

/** Write a session.lock at a given worktree path. */
function writeLock(wtPath, body) {
  const dir = join(wtPath, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.lock'), JSON.stringify(body, null, 2) + '\n');
}

/** Write raw bytes to the session.lock (for malformed-body tests). */
function writeLockRaw(wtPath, raw) {
  const dir = join(wtPath, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.lock'), raw);
}

/** Lock body factory — all required fields with sensible defaults. */
function lockBody(overrides = {}) {
  return {
    session_id: 'test-session',
    started_at: new Date().toISOString(),
    mode:       'deep',
    pid:        process.pid,   // alive by default (current process)
    host:       hostname(),    // same-host by default
    ttl_hours:  4,
    ...overrides,
  };
}

/** Build a one-element listWorktreesImpl that returns the given worktree path. */
function singleWtImpl(path, branch = 'main', head = 'abc123') {
  return async () => [{ path, branch, head }];
}

// ---------------------------------------------------------------------------
// Group A — Happy path
// ---------------------------------------------------------------------------

describe('Group A — happy path', () => {
  it('single worktree with live session returns 1 entry with all 7 fields populated', async () => {
    writeLock(repoRoot, lockBody({ session_id: 'sess-A1' }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot, 'main', 'abc123'),
    });

    expect(result).toHaveLength(1);
    expect(result[0].worktreePath).toBe(repoRoot);
    expect(result[0].sessionId).toBe('sess-A1');
    expect(result[0].mode).toBe('deep');
    expect(typeof result[0].startedAt).toBe('string');
    expect(result[0].pid).toBe(process.pid);
    expect(result[0].host).toBe(hostname());
    expect(result[0].branch).toBe('main');
  });

  it('discoverActiveSessions returns a Promise (is thenable)', () => {
    const returned = discoverActiveSessions(repoRoot, {
      listWorktreesImpl: async () => [],
    });

    expect(typeof returned.then).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Group B — Heartbeat-freshness filter (Epic #583, W2-I3)
// ---------------------------------------------------------------------------
//
// Liveness rule changed from PID-liveness to heartbeat-freshness: a lock
// is live when (now - last_heartbeat) < ttl_hours. Dead PIDs no longer
// filter the lock — what filters is a stale heartbeat. See Epic #583
// audit D2 (writer-PID is the hook PID, not the session PID).

describe('Group B — heartbeat-freshness filter (Epic #583, W2-I3)', () => {
  it('fresh heartbeat + dead PID is INCLUDED (PID is no longer the liveness signal)', async () => {
    writeLock(repoRoot, lockBody({
      pid: DEAD_PID,                              // hook PID (transient, dead)
      host: hostname(),
      started_at: new Date().toISOString(),       // fresh
      last_heartbeat: new Date().toISOString(),   // fresh — schema v2
    }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(DEAD_PID); // PID is preserved for forensics
  });

  it('stale heartbeat (older than ttl_hours) is EXCLUDED even with alive PID', async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    writeLock(repoRoot, lockBody({
      pid: process.pid,                        // alive
      host: hostname(),
      started_at: fiveHoursAgo,
      last_heartbeat: fiveHoursAgo,            // stale — beyond ttl_hours=4
      ttl_hours: 4,
    }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(0);
  });

  it('fresh heartbeat + alive PID is INCLUDED (normal happy path)', async () => {
    writeLock(repoRoot, lockBody({ pid: process.pid, host: hostname() }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Group C — Cross-host
// ---------------------------------------------------------------------------

describe('Group C — cross-host policy', () => {
  it('cross-host + dead PID is kept (liveness unverifiable)', async () => {
    writeLock(repoRoot, lockBody({ pid: DEAD_PID, host: 'fake-remote-host-xyz' }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(1);
    expect(result[0].host).toBe('fake-remote-host-xyz');
  });

  it('cross-host + alive PID is kept', async () => {
    writeLock(repoRoot, lockBody({ pid: process.pid, host: 'fake-remote-host-xyz' }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(1);
    expect(result[0].host).toBe('fake-remote-host-xyz');
  });
});

// ---------------------------------------------------------------------------
// Group D — Cross-worktree enumeration
// ---------------------------------------------------------------------------

describe('Group D — multi-worktree enumeration', () => {
  it('2 worktrees with live locks → 2 results with distinct sessionIds', async () => {
    const wt2 = mkdtempSync(join(tmpdir(), 'session-discovery-wt2-'));
    try {
      writeLock(repoRoot, lockBody({ session_id: 'sess-D1', pid: process.pid }));
      writeLock(wt2,      lockBody({ session_id: 'sess-D2', pid: process.pid }));

      const result = await discoverActiveSessions(repoRoot, {
        listWorktreesImpl: async () => [
          { path: repoRoot, branch: 'main',    head: 'aaa' },
          { path: wt2,      branch: 'feature', head: 'bbb' },
        ],
      });

      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.sessionId).sort();
      expect(ids).toEqual(['sess-D1', 'sess-D2']);
    } finally {
      rmSync(wt2, { recursive: true, force: true });
    }
  });

  it('2 worktrees: stale-heartbeat filtered, fresh-heartbeat kept → 1 result', async () => {
    const wt2 = mkdtempSync(join(tmpdir(), 'session-discovery-wt2b-'));
    try {
      const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
      // Fresh heartbeat → INCLUDED. Heartbeat defaults to fresh (now) via lockBody.
      writeLock(repoRoot, lockBody({ session_id: 'sess-fresh', pid: process.pid, host: hostname() }));
      // Stale heartbeat (5h ago, ttl=4h) → EXCLUDED, even though PID is alive.
      writeLock(wt2, lockBody({
        session_id: 'sess-stale',
        pid: process.pid,                  // alive (does not save it under new rule)
        host: hostname(),
        started_at: fiveHoursAgo,
        last_heartbeat: fiveHoursAgo,
        ttl_hours: 4,
      }));

      const result = await discoverActiveSessions(repoRoot, {
        listWorktreesImpl: async () => [
          { path: repoRoot, branch: 'main',  head: 'aaa' },
          { path: wt2,      branch: 'stale', head: 'bbb' },
        ],
      });

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('sess-fresh');
    } finally {
      rmSync(wt2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Group E — Edge cases
// ---------------------------------------------------------------------------

describe('Group E — edge cases', () => {
  it('no lock file present → empty result (silent skip, no crash)', async () => {
    // Do NOT write any lock file — the .orchestrator dir does not exist.
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(0);
  });

  it('empty worktree list → empty result (no crash)', async () => {
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: async () => [],
    });

    expect(result).toEqual([]);
  });

  it('malformed lock JSON → empty result (readLock returns null, silently skipped)', async () => {
    writeLockRaw(repoRoot, 'not valid json }{');

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Group F — Branch propagation, TTL ignorance, exported constant
// ---------------------------------------------------------------------------

describe('Group F — branch & shape', () => {
  it('branch field is taken from the worktree object, not the lock', async () => {
    writeLock(repoRoot, lockBody({ pid: process.pid, host: hostname() }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: async () => [
        { path: repoRoot, branch: 'feature/foo', head: 'abc' },
      ],
    });

    expect(result[0].branch).toBe('feature/foo');
  });

  it('Heartbeat-expired even with alive PID is EXCLUDED (Epic #583, W2-I3 — heartbeat IS the liveness signal)', async () => {
    // Pre-#583 this test asserted "TTL does not filter sessions" — that rule
    // is replaced: heartbeat freshness is now THE filter. PID-liveness is
    // forensic-only. A heartbeat older than ttl_hours excludes the lock.
    writeLock(repoRoot, lockBody({
      started_at:     '2020-01-01T00:00:00.000Z',
      last_heartbeat: '2020-01-01T00:00:00.000Z',
      ttl_hours:      4,
      pid:            process.pid,
      host:           hostname(),
    }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(0);
  });

  it('DEFAULT_DISCOVERY_TIMEOUT_MS is exported and equals 2000', () => {
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Group G — Registry-fallback merge (Epic #583, W2-I3 — Merged Source-of-Truth)
// ---------------------------------------------------------------------------
//
// When a worktree has no live lock, the discovery path consults the host
// registry (filtered by repo_path_hash + freshness) and merges those entries
// into the result. Tests use the `registryReader` DI hook to inject a
// deterministic registry without touching the real ~/.config/ dir.

describe('Group G — registry-fallback merge (Epic #583, W2-I3)', () => {
  // Helper: build a registry entry that targets the test's repoRoot.
  function regEntryForRepo(_repoPath, overrides = {}) {
    return {
      session_id:     'reg-default',
      pid:            process.pid,
      platform:       'claude',
      repo_path_hash: '', // filled in below
      repo_name:      'test-repo',
      branch:         'main',
      started_at:     new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      status:         'active',
      current_wave:   0,
      host_class:     null,
      mode:           'deep',
      ...overrides,
    };
  }

  it('D-i1: registry entry present + NO worktree lock → discoverActiveSessions returns the registry session', async () => {
    // No lock written to repoRoot. The registry has one fresh entry for our path.
    const { repoPathHash } = await import('@lib/session-registry.mjs');
    const myHash = repoPathHash(repoRoot);
    const entry = regEntryForRepo(repoRoot, {
      session_id: 'reg-D-i1',
      repo_path_hash: myHash,
    });

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
      registryReader: async () => [entry],
    });

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('reg-D-i1');
    expect(result[0].mode).toBe('deep');
    expect(result[0].branch).toBe('main');
  });

  it('D-i2: stale lock (heartbeat > ttl) + fresh registry entry for same session → registry wins (1 result)', async () => {
    const { repoPathHash } = await import('@lib/session-registry.mjs');
    const myHash = repoPathHash(repoRoot);

    // Stale lock — heartbeat 5h ago, ttl_hours=4 → not live by heartbeat rule.
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    writeLock(repoRoot, lockBody({
      session_id:     'sess-D-i2',
      started_at:     fiveHoursAgo,
      last_heartbeat: fiveHoursAgo,
      ttl_hours:      4,
      pid:            process.pid,
      host:           hostname(),
    }));

    // Fresh registry entry for the SAME session_id.
    const entry = regEntryForRepo(repoRoot, {
      session_id: 'sess-D-i2',
      repo_path_hash: myHash,
    });

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
      registryReader: async () => [entry],
    });

    // Lock is stale (excluded); registry entry is fresh (included).
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('sess-D-i2');
  });

  it('D-i3: cross-repo registry entry (different repo_path_hash) is filtered out', async () => {
    // No lock; registry entry has a DIFFERENT path-hash (different repo).
    const entry = regEntryForRepo(repoRoot, {
      session_id: 'reg-D-i3-other-repo',
      repo_path_hash: 'b'.repeat(64), // different from this repoRoot's hash
    });

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
      registryReader: async () => [entry],
    });

    expect(result).toHaveLength(0);
  });

  it('D-i4: dedupe — lock + registry have same session_id → 1 result, prefers lock detail', async () => {
    const { repoPathHash } = await import('@lib/session-registry.mjs');
    const myHash = repoPathHash(repoRoot);

    // Live lock (fresh heartbeat) for session sess-D-i4.
    writeLock(repoRoot, lockBody({
      session_id: 'sess-D-i4',
      mode:       'feature',
      pid:        process.pid,
      host:       hostname(),
    }));

    // Registry entry with the SAME sessionId, but different mode/branch.
    const entry = regEntryForRepo(repoRoot, {
      session_id:     'sess-D-i4',
      repo_path_hash: myHash,
      mode:           'deep',     // would override if registry won
      branch:         'registry-branch',
    });

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: async () => [
        { path: repoRoot, branch: 'lock-branch', head: 'aaa' },
      ],
      registryReader: async () => [entry],
    });

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('sess-D-i4');
    // Lock wins — mode comes from the lock body, branch comes from git/worktree.
    expect(result[0].mode).toBe('feature');
    expect(result[0].branch).toBe('lock-branch');
  });

  it('registry-fallback: stale registry entry (heartbeat > freshnessMin) is filtered out', async () => {
    const { repoPathHash } = await import('@lib/session-registry.mjs');
    const myHash = repoPathHash(repoRoot);

    // Registry entry with a 60-min-old heartbeat (freshnessMin default = 15).
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const entry = regEntryForRepo(repoRoot, {
      session_id:     'reg-stale-G2',
      repo_path_hash: myHash,
      started_at:     oneHourAgo,
      last_heartbeat: oneHourAgo,
    });

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
      registryReader: async () => [entry],
    });

    expect(result).toHaveLength(0);
  });
});
