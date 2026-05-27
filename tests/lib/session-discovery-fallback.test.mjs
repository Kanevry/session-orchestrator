/**
 * tests/lib/session-discovery-fallback.test.mjs
 *
 * Vitest suite for the FALLBACK paths of scripts/lib/session-discovery.mjs
 * (P1.1, Issue #569).
 *
 * Scope (this file): timeout fallback, git-fail fallback, A1 single-worktree
 * mode edge cases, and default-timeoutMs verification.
 *
 * Happy-path tests (W3 listWorktrees returns sessions) are owned by Q2 in
 * tests/lib/session-discovery.test.mjs — do NOT add those here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
let stderrSpy;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'session-discovery-fallback-test-'));
  // Isolate registry from the user's real ~/.config/session-orchestrator/sessions
  // (Epic #583, W2-I3: discoverActiveSessions now consults the registry).
  registryDir = mkdtempSync(join(tmpdir(), 'session-discovery-fallback-registry-'));
  prevRegistryEnv = process.env.SO_SESSION_REGISTRY_DIR;
  process.env.SO_SESSION_REGISTRY_DIR = registryDir;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
  if (prevRegistryEnv === undefined) {
    delete process.env.SO_SESSION_REGISTRY_DIR;
  } else {
    process.env.SO_SESSION_REGISTRY_DIR = prevRegistryEnv;
  }
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a valid session.lock under <repoRoot>/.orchestrator/session.lock */
function writeLocalLock(body) {
  const dir = join(repoRoot, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.lock'), JSON.stringify(body, null, 2) + '\n');
}

/** Build a valid lock body with sensible defaults. */
function lockBody(overrides = {}) {
  return {
    session_id: 'test-fallback',
    started_at: new Date().toISOString(),
    mode: 'deep',
    pid: process.pid,
    host: hostname(),
    ttl_hours: 4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group A — Git-fail fallback
// ---------------------------------------------------------------------------

describe('Group A — git-fail fallback (listWorktreesImpl throws sync)', () => {
  it('emits WARN with "failed:" reason when listWorktreesImpl throws', async () => {
    writeLocalLock(lockBody());
    await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => { throw new Error('fake-fail'); },
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[session-discovery\] WARN: git worktree list failed: fake-fail/),
    );
  });

  it('returns the local lock session (A1 result) when listWorktreesImpl throws', async () => {
    writeLocalLock(lockBody());
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => { throw new Error('fake-fail'); },
    });
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('test-fallback');
  });

  it('A1 fallback result has branch="" (empty string — A1 does not know branch)', async () => {
    writeLocalLock(lockBody());
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => { throw new Error('fake-fail'); },
    });
    expect(result[0].branch).toBe('');
  });

  it('returns empty array + WARN when listWorktreesImpl throws and no local lock exists', async () => {
    // No writeLocalLock call — .orchestrator/ directory does not exist.
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => { throw new Error('fake-fail'); },
    });
    expect(result).toHaveLength(0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[session-discovery\] WARN: git worktree list failed: fake-fail/),
    );
  });

  it('handles async (Promise.reject) from listWorktreesImpl — emits WARN with async-fail', async () => {
    writeLocalLock(lockBody());
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => Promise.reject(new Error('async-fail')),
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[session-discovery\] WARN: git worktree list failed: async-fail/),
    );
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('test-fallback');
  });
});

// ---------------------------------------------------------------------------
// Group B — Timeout fallback
// ---------------------------------------------------------------------------

describe('Group B — timeout fallback (listWorktreesImpl slower than opts.timeoutMs)', () => {
  it('emits timeout WARN with the configured timeoutMs when slow impl exceeds timeout', async () => {
    // Slow impl resolves in 1000ms but timeoutMs is 50ms — timeout fires first.
    // The .unref() on the internal timer means the slow setTimeout does not
    // keep the process (or test worker) alive after the test completes.
    await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => new Promise((resolve) => {
        const t = setTimeout(() => resolve([]), 1000);
        // Do NOT unref here — tests must be deterministic; the production code's
        // race timer uses .unref(), so the slow promise's timer is the one that
        // might linger. In test we just let it be collected by the fork pool.
        t;
      }),
      timeoutMs: 50,
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[session-discovery\] WARN: git worktree list timed out at 50ms/),
    );
  });

  it('returns A1 local session when timeout fires and a valid lock is present', async () => {
    writeLocalLock(lockBody());
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => new Promise((resolve) => setTimeout(() => resolve([]), 1000)),
      timeoutMs: 50,
    });
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('test-fallback');
  });

  it('returns empty array + WARN when timeout fires and no local lock exists', async () => {
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => new Promise((resolve) => setTimeout(() => resolve([]), 1000)),
      timeoutMs: 50,
    });
    expect(result).toHaveLength(0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[session-discovery\] WARN: git worktree list timed out at 50ms/),
    );
  });

  it('timeoutMs:1 (very short) causes immediate timeout WARN', async () => {
    await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
      timeoutMs: 1,
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[session-discovery\] WARN: git worktree list timed out at 1ms/),
    );
  });
});

// ---------------------------------------------------------------------------
// Group C — A1 fallback edge cases (dead-PID + cross-host filtering)
// ---------------------------------------------------------------------------

describe('Group C — A1 fallback dead-PID and cross-host filtering', () => {
  it('excludes stale-heartbeat lock from A1 result (Epic #583, W2-I3 — heartbeat IS the liveness signal)', async () => {
    // Pre-#583 this test exercised PID-liveness exclusion. The liveness rule
    // changed to heartbeat-freshness; a fresh-heartbeat lock is INCLUDED even
    // with a dead PID (the writer-process is transient). To exercise the
    // exclusion path now, give the lock a heartbeat older than ttl_hours.
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    writeLocalLock(lockBody({
      pid:            DEAD_PID,
      host:           hostname(),
      started_at:     fiveHoursAgo,
      last_heartbeat: fiveHoursAgo,
      ttl_hours:      4,
    }));
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => { throw new Error('fail'); },
    });
    // Stale heartbeat → excluded under the new liveness rule.
    expect(result).toHaveLength(0);
  });

  it('includes cross-host lock even when PID would be dead if local (unverifiable)', async () => {
    writeLocalLock(lockBody({ pid: DEAD_PID, host: 'remote-host' }));
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => { throw new Error('fail'); },
    });
    // Cross-host: PID liveness is unverifiable — include per the decision table.
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('test-fallback');
  });

  it('A1 result always has branch="" regardless of lock content', async () => {
    // branch field is intentionally absent from the lock body shape.
    writeLocalLock(lockBody({ session_id: 'branch-check-session' }));
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => { throw new Error('fail'); },
    });
    expect(result[0].branch).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Group D — Default timeoutMs behavior
// ---------------------------------------------------------------------------

describe('Group D — default timeoutMs (DEFAULT_DISCOVERY_TIMEOUT_MS = 2000)', () => {
  it('DEFAULT_DISCOVERY_TIMEOUT_MS is 2000', () => {
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(2000);
  });

  it('does NOT trigger timeout when listWorktreesImpl resolves in 50ms (well under 2000ms default)', async () => {
    // A 50ms resolve is well within the 2000ms default timeout window.
    // If no timeout fires, no WARN is emitted to stderr.
    const result = await discoverActiveSessions(repoRoot, {
      listWorktreesImpl: () => new Promise((resolve) => setTimeout(() => resolve([]), 50)),
    });
    // The mock returned [] — no worktrees → no sessions.
    expect(result).toHaveLength(0);
    // No WARN should have been emitted (default 2000ms > 50ms).
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/\[session-discovery\] WARN:/),
    );
  });
});
