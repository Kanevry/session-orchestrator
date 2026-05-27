/**
 * tests/hooks/post-tool-batch.test.mjs
 *
 * Tests for hooks/post-tool-batch-wave-signal.mjs (#342).
 *
 * Strategy: spawn the hook via node with stdin piped, CLAUDE_PROJECT_DIR
 * pointing to a tmp sandbox. Assert:
 *   1. Happy path — valid payload → writes last_batch signal to
 *      current-session.json, exits 0.
 *   2. Malformed stdin — exits 0 and writes a null-field last_batch.
 *   3. Idempotency — two invocations; last_batch reflects the second call.
 *   4. Epic #583 W3-P3: heartbeat refresh — when a session.lock exists and
 *      the hook is invoked with a matching session_id, last_heartbeat is
 *      refreshed; when no lock exists, the hook still exits 0 (best-effort).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../../hooks/post-tool-batch-wave-signal.mjs', import.meta.url).pathname;
const SESSION_REL = join('.orchestrator', 'current-session.json');

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ptb-test-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function runHook(stdinJson) {
  return spawnSync(process.execPath, [HOOK], {
    input: stdinJson,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmp,
      SO_HOOK_PROFILE: 'full',
      SO_DISABLED_HOOKS: '',
    },
    timeout: 10_000,
  });
}

function readSessionFile() {
  const filePath = join(tmp, SESSION_REL);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

describe('post-tool-batch-wave-signal hook', () => {
  it('happy path: valid payload writes last_batch signal and exits 0', () => {
    const payload = JSON.stringify({
      batch_id: 'wave3-batch1',
      batch_size: 6,
      batch_completed_at: '2026-05-08T10:05:00.000Z',
      agent_id: 'coordinator',
      parent_session_id: 'main-2026-05-08-deep',
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(typeof session.last_batch).toBe('object');
    expect(session.last_batch).not.toBeNull();

    const lb = session.last_batch;
    expect(lb.batch_id).toBe('wave3-batch1');
    expect(lb.batch_size).toBe(6);
    expect(lb.completed_at).toBe('2026-05-08T10:05:00.000Z');
    expect(lb.agent_id).toBe('coordinator');
    expect(lb.parent_session_id).toBe('main-2026-05-08-deep');
  });

  it('malformed stdin: exits 0 and writes a null-field last_batch', () => {
    const result = runHook('{{not valid json}}');
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(typeof session.last_batch).toBe('object');
    const lb = session.last_batch;
    expect(lb.batch_id).toBeNull();
    expect(lb.batch_size).toBeNull();
  });

  it('idempotency: second invocation overwrites last_batch with the new values', () => {
    const payload1 = JSON.stringify({ batch_id: 'batch-A', batch_size: 2 });
    const payload2 = JSON.stringify({ batch_id: 'batch-B', batch_size: 4 });

    runHook(payload1);
    runHook(payload2);

    const session = readSessionFile();
    // last_batch is always overwritten — only the second value survives
    expect(session.last_batch.batch_id).toBe('batch-B');
    expect(session.last_batch.batch_size).toBe(4);
    // The resulting file must be valid JSON (no corruption)
    expect(typeof session.last_batch.completed_at).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Heartbeat refresh (Epic #583 W3-P3 — wires W2-I3 OQ2)
// ---------------------------------------------------------------------------
//
// The post-tool-batch hook is the most frequent cadence available to the
// session-lock liveness machinery. Refreshing last_heartbeat here keeps
// every active session live to discoverActiveSessions() without requiring
// the coordinator-LLM to remember to call updateHeartbeat() between waves.
//
// Contract:
//   1. When the hook's session_id matches an existing session.lock, the
//      lock's last_heartbeat is updated to a fresh ISO timestamp.
//   2. When no session.lock exists, the hook still completes successfully —
//      the refresh is best-effort and must NEVER block.
//   3. When the session_id does NOT match the lock owner, last_heartbeat
//      is left untouched (same-session guard in updateHeartbeat).

describe('post-tool-batch heartbeat refresh (Epic #583 W3-P3)', () => {
  /**
   * Write a minimal valid session.lock body for the given sessionId with
   * a stale last_heartbeat so we can observe whether the hook refreshes it.
   * Returns the path of the written lock.
   */
  function writeStaleLock(sessionId) {
    const orchDir = join(tmp, '.orchestrator');
    mkdirSync(orchDir, { recursive: true });
    const lockPath = join(orchDir, 'session.lock');
    // Stale heartbeat: 30 minutes in the past. Still WITHIN the 4h TTL
    // so isLockLive() returns true, but observably old vs. a refresh.
    const staleIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const lock = {
      session_id: sessionId,
      started_at: staleIso,
      last_heartbeat: staleIso,
      mode: 'deep',
      pid: 999999, // arbitrary — hook ignores PID for refresh decisions
      host: 'test-host',
      ttl_hours: 4,
    };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    return { lockPath, staleIso };
  }

  function readLock() {
    const lockPath = join(tmp, '.orchestrator', 'session.lock');
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  }

  it('refreshes last_heartbeat on the session.lock when session_id matches via stdin', () => {
    const sessionId = 'test-session-heartbeat-refresh';
    const { staleIso } = writeStaleLock(sessionId);

    const payload = JSON.stringify({
      session_id: sessionId,
      batch_id: 'wave1-batch1',
      batch_size: 3,
    });
    const result = runHook(payload);
    expect(result.status).toBe(0);

    const lock = readLock();
    // last_heartbeat MUST have moved forward; started_at MUST be unchanged
    // (refresh only updates the heartbeat, not the started-at marker).
    expect(lock.last_heartbeat).not.toBe(staleIso);
    expect(lock.started_at).toBe(staleIso);
    // The new heartbeat must parse as a valid ISO timestamp newer than the stale one.
    const refreshedMs = Date.parse(lock.last_heartbeat);
    const staleMs = Date.parse(staleIso);
    expect(refreshedMs).toBeGreaterThan(staleMs);
  });

  it('refreshes last_heartbeat via fallback to current-session.json when stdin lacks session_id', () => {
    const sessionId = 'test-fallback-session-id';
    const { staleIso } = writeStaleLock(sessionId);

    // Pre-populate current-session.json so the hook can resolve session_id
    // when stdin omits it.
    const sessionFile = join(tmp, '.orchestrator', 'current-session.json');
    writeFileSync(sessionFile, JSON.stringify({ session_id: sessionId }), 'utf8');

    // Payload lacks session_id but carries batch info.
    const payload = JSON.stringify({ batch_id: 'fallback-batch', batch_size: 1 });
    const result = runHook(payload);
    expect(result.status).toBe(0);

    const lock = readLock();
    expect(lock.last_heartbeat).not.toBe(staleIso);
    expect(Date.parse(lock.last_heartbeat)).toBeGreaterThan(Date.parse(staleIso));
  });

  it('does NOT refresh when session_id does not match the lock owner (same-session guard)', () => {
    const lockOwner = 'lock-owner-session';
    const { staleIso } = writeStaleLock(lockOwner);

    const payload = JSON.stringify({
      session_id: 'different-session-impostor',
      batch_id: 'impostor-batch',
      batch_size: 1,
    });
    const result = runHook(payload);
    expect(result.status).toBe(0);

    const lock = readLock();
    // last_heartbeat must be UNCHANGED — updateHeartbeat() refuses to update
    // someone else's lock.
    expect(lock.last_heartbeat).toBe(staleIso);
    // session_id is preserved.
    expect(lock.session_id).toBe(lockOwner);
  });

  it('exits 0 cleanly when no session.lock exists (best-effort contract)', () => {
    // No lock pre-written. Hook must still succeed.
    const payload = JSON.stringify({
      session_id: 'no-lock-session',
      batch_id: 'no-lock-batch',
      batch_size: 2,
    });
    const result = runHook(payload);
    expect(result.status).toBe(0);
    // current-session.json is still written (the existing happy-path contract).
    const sessionFile = join(tmp, '.orchestrator', 'current-session.json');
    expect(existsSync(sessionFile)).toBe(true);
  });
});
