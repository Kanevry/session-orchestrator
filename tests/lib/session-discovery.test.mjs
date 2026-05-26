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

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'session-discovery-test-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
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
// Group B — Dead-PID filter (same-host)
// ---------------------------------------------------------------------------

describe('Group B — dead-PID filter (same-host)', () => {
  it('same-host + dead PID is excluded (filtered out)', async () => {
    writeLock(repoRoot, lockBody({ pid: DEAD_PID, host: hostname() }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(0);
  });

  it('same-host + alive PID is included', async () => {
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

  it('2 worktrees: dead-PID same-host filtered, alive-PID same-host kept → 1 result', async () => {
    const wt2 = mkdtempSync(join(tmpdir(), 'session-discovery-wt2b-'));
    try {
      writeLock(repoRoot, lockBody({ session_id: 'sess-alive', pid: process.pid, host: hostname() }));
      writeLock(wt2,      lockBody({ session_id: 'sess-dead',  pid: DEAD_PID,    host: hostname() }));

      const result = await discoverActiveSessions(repoRoot, {
        listWorktreesImpl: async () => [
          { path: repoRoot, branch: 'main', head: 'aaa' },
          { path: wt2,      branch: 'dead', head: 'bbb' },
        ],
      });

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('sess-alive');
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

  it('TTL-expired but alive PID is INCLUDED (TTL does not filter sessions)', async () => {
    writeLock(repoRoot, lockBody({
      started_at: '2020-01-01T00:00:00.000Z',
      ttl_hours:  4,
      pid:        process.pid,
      host:       hostname(),
    }));

    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: singleWtImpl(repoRoot),
    });

    expect(result).toHaveLength(1);
  });

  it('DEFAULT_DISCOVERY_TIMEOUT_MS is exported and equals 2000', () => {
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(2000);
  });
});
