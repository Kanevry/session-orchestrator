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

const EVENTS_REL = join('.orchestrator', 'metrics', 'events.jsonl');

/**
 * Read and parse all JSONL event records the hook emitted via emitEvent()
 * (which resolves to CLAUDE_PROJECT_DIR/.orchestrator/metrics/events.jsonl).
 * Returns [] when the file is absent (no events emitted).
 */
function readEvents() {
  const filePath = join(tmp, EVENTS_REL);
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** Write .claude/wave-scope.json with the given wave number. */
function writeWaveScope(wave) {
  const claudeDir = join(tmp, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'wave-scope.json'), JSON.stringify({ wave }), 'utf8');
}

/** Write .orchestrator/current-session.json with the given fields. */
function writeCurrentSession(obj) {
  const orchDir = join(tmp, '.orchestrator');
  mkdirSync(orchDir, { recursive: true });
  writeFileSync(join(orchDir, 'current-session.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
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

// ---------------------------------------------------------------------------
// Mechanical wave-lifecycle fallback (#612, Option b)
// ---------------------------------------------------------------------------
//
// When the harness does NOT inject an explicit wave_signal (the common case),
// the hook detects wave boundaries by diffing .claude/wave-scope.json `.wave`
// against `last_wave` persisted in current-session.json, emitting
// orchestrator.wave.{started,completed} on a STRICT INCREASE (wave > last_wave
// AND wave > 0). It then persists the new high-water mark so the next batch on
// the same wave does NOT re-emit. The in-session idempotency contract:
//   - same wave as last_wave        → ZERO new wave events (re-emit suppressed)
//   - strict increase               → completed{prev} + started{new}, persist
//   - drop to 0 / non-increase       → ignored (wave-scope deleted mid-phase)
// These payloads carry NO wave_signal, so they exercise the fallback branch.

describe('post-tool-batch mechanical wave-lifecycle fallback (#612)', () => {
  it('suppresses re-emit when wave == last_wave (same wave, no boundary)', () => {
    writeWaveScope(3);
    writeCurrentSession({ session_id: 's', last_wave: 3 });

    // Batch payload with NO wave_signal → exercises the fallback branch.
    const result = runHook(JSON.stringify({ session_id: 's', batch_id: 'b1', batch_size: 6 }));
    expect(result.status).toBe(0);

    const waveEvents = readEvents().filter((e) =>
      e.event === 'orchestrator.wave.started' || e.event === 'orchestrator.wave.completed',
    );
    expect(waveEvents).toEqual([]);
    // last_wave is unchanged (still 3).
    expect(readSessionFile().last_wave).toBe(3);
  });

  it('emits completed{prev}+started{new} and persists last_wave on a strict increase', () => {
    writeWaveScope(2);
    writeCurrentSession({ session_id: 's', last_wave: 1 });

    const result = runHook(JSON.stringify({ session_id: 's', batch_id: 'b2', batch_size: 4 }));
    expect(result.status).toBe(0);

    const events = readEvents();
    const completed = events.filter((e) => e.event === 'orchestrator.wave.completed');
    const started = events.filter((e) => e.event === 'orchestrator.wave.started');

    expect(completed).toHaveLength(1);
    expect(completed[0].wave_number).toBe(1);
    expect(started).toHaveLength(1);
    expect(started[0].wave_number).toBe(2);

    // High-water mark advanced to the new wave and persisted.
    expect(readSessionFile().last_wave).toBe(2);
  });

  it('persists last_wave_completed = N-1 alongside last_wave = N on a transition (#1193)', () => {
    // The bug this catches: with only `last_wave` persisted, a SessionEnd could
    // not tell whether the current wave had already been closed here by an N+1
    // transition — so the new final-wave emitter in hooks/on-session-end.mjs
    // would emit a SECOND completed for a wave this hook already closed.
    writeWaveScope(4);
    writeCurrentSession({ session_id: 's', last_wave: 3 });

    const result = runHook(JSON.stringify({ session_id: 's', batch_id: 'b-hwm', batch_size: 1 }));
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(session.last_wave).toBe(4);
    expect(session.last_wave_completed).toBe(3);
  });

  it('does NOT re-close a wave already marked last_wave_completed (F2 duplicate)', () => {
    // The bug this catches: /clear mid-wave fires SessionEnd, which closes the
    // LIVE wave 3 and stamps last_wave_completed: 3; on-session-start.mjs then
    // PRESERVES that marker across the restart. With the transition guarded on
    // `wave > last_wave` alone, the 3→4 boundary emitted completed{3} a SECOND
    // time. Only started{4} is legitimate here.
    writeWaveScope(4);
    writeCurrentSession({ session_id: 's', last_wave: 3, last_wave_completed: 3 });

    const result = runHook(JSON.stringify({ session_id: 's', batch_id: 'b-dup', batch_size: 1 }));
    expect(result.status).toBe(0);

    const events = readEvents();
    expect(events.filter((e) => e.event === 'orchestrator.wave.completed')).toEqual([]);
    const started = events.filter((e) => e.event === 'orchestrator.wave.started');
    expect(started).toHaveLength(1);
    expect(started[0].wave_number).toBe(4);
    // The marker does not regress, and last_wave still advances.
    const session = readSessionFile();
    expect(session.last_wave).toBe(4);
    expect(session.last_wave_completed).toBe(3);
  });

  it('persists last_wave_completed from the EXPLICIT wave_signal branch too (F2)', () => {
    // The bug this catches: the explicit `wave-complete` signal is a THIRD
    // emitter of orchestrator.wave.completed that wrote no marker, so
    // hooks/on-session-end.mjs would close the very wave this signal closed.
    writeCurrentSession({ session_id: 's', last_wave: 5 });

    const result = runHook(JSON.stringify({
      session_id: 's', wave_signal: 'wave-complete', wave_number: 5, batch_id: 'b-sig', batch_size: 1,
    }));
    expect(result.status).toBe(0);

    const completed = readEvents().filter((e) => e.event === 'orchestrator.wave.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].wave_number).toBe(5);
    expect(readSessionFile().last_wave_completed).toBe(5);
  });

  it('writes NO marker for a wave-start signal, nor for an unnumbered wave-complete (F2)', () => {
    // Catches a marker stamped for something that was never completed: a
    // wave-START, or a completion carrying no wave number to record.
    writeCurrentSession({ session_id: 's', last_wave: 5 });
    expect(runHook(JSON.stringify({ session_id: 's', wave_signal: 'wave-start', wave_number: 6 })).status).toBe(0);
    expect(Object.hasOwn(readSessionFile(), 'last_wave_completed')).toBe(false);

    expect(runHook(JSON.stringify({ session_id: 's', wave_signal: 'wave-complete' })).status).toBe(0);
    expect(Object.hasOwn(readSessionFile(), 'last_wave_completed')).toBe(false);
  });

  it('emits NO wave events when wave drops to 0 (wave-scope deleted mid-phase)', () => {
    // wave-scope.json absent → resolveWaveNumber() returns 0; current-session
    // still holds last_wave: 3. A non-increase (3 → 0) MUST be ignored.
    writeCurrentSession({ session_id: 's', last_wave: 3 });

    const result = runHook(JSON.stringify({ session_id: 's', batch_id: 'b3', batch_size: 2 }));
    expect(result.status).toBe(0);

    const waveEvents = readEvents().filter((e) =>
      e.event === 'orchestrator.wave.started' || e.event === 'orchestrator.wave.completed',
    );
    expect(waveEvents).toEqual([]);
    // last_wave is untouched — the drop did not rewrite the high-water mark.
    expect(readSessionFile().last_wave).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Manifest location follows findScopeFile() precedence (#1082)
// ---------------------------------------------------------------------------

describe('post-tool-batch wave manifest lookup (#1082)', () => {
  it('reads the wave number from .codex/wave-scope.json, not only .claude/', () => {
    // The bug: this hook hard-coded `.claude/wave-scope.json` while every other
    // consumer resolves the manifest via findScopeFile() (.pi > .cursor > .codex
    // > .claude). On Codex CLI, Cursor and pi the manifest therefore read as
    // ABSENT on every batch, resolveWaveNumber() returned 0, and the whole
    // mechanical wave-lifecycle fallback was structurally dead — no
    // orchestrator.wave.started/completed event was ever emitted on those
    // platforms, with nothing to distinguish it from an idle session.
    mkdirSync(join(tmp, '.codex'), { recursive: true });
    writeFileSync(join(tmp, '.codex', 'wave-scope.json'), JSON.stringify({ wave: 3 }), 'utf8');
    writeCurrentSession({ session_id: 's', last_wave: 0 });

    const result = runHook(JSON.stringify({ session_id: 's', batch_id: 'b-codex', batch_size: 2 }));
    expect(result.status).toBe(0);

    const started = readEvents().filter((e) => e.event === 'orchestrator.wave.started');
    expect(started).toHaveLength(1);
    expect(started[0].wave_number).toBe(3);
    expect(readSessionFile().last_wave).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Ownership + monotonicity of the wave keys (#1193 W4c Q1-MED / Q3-MED-3)
// ---------------------------------------------------------------------------

describe('post-tool-batch wave-key ownership (#1193 W4c Q1-MED)', () => {
  const MINE = '11111111-1111-4111-8111-111111111111';
  const PEER = '22222222-2222-4222-8222-222222222222';

  it('does NOT write last_wave/last_wave_completed into a PEER session record (fallback branch)', () => {
    // Catches: session A's batch stamping A's wave into live session B's
    // repo-global record. Two damages, both reproduced with the real binaries:
    // B's own SessionEnd then reads lastWave === marker and emits nothing (the
    // #1193 gap preserved on B), and A's last_wave makes B's SessionEnd emit
    // wave.completed for A's wave under B's identity.
    writeWaveScope(5);
    writeCurrentSession({ session_id: PEER, last_wave: 4 });

    const result = runHook(JSON.stringify({ session_id: MINE, batch_id: 'b-peer', batch_size: 1 }));
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(session.last_wave).toBe(4);
    expect(Object.hasOwn(session, 'last_wave_completed')).toBe(false);
  });

  it('does NOT write the marker into a PEER session record (explicit wave-complete branch)', () => {
    writeCurrentSession({ session_id: PEER, last_wave: 4 });

    const result = runHook(JSON.stringify({
      session_id: MINE, wave_signal: 'wave-complete', wave_number: 5,
    }));
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(session.last_wave).toBe(4);
    expect(Object.hasOwn(session, 'last_wave_completed')).toBe(false);
  });

  it('DOES write both keys when the stdin session_id matches the record', () => {
    // The other half of the gate: a matching owner is not blocked by it.
    writeWaveScope(5);
    writeCurrentSession({ session_id: MINE, last_wave: 4 });

    expect(runHook(JSON.stringify({ session_id: MINE, batch_id: 'b-own' })).status).toBe(0);

    const session = readSessionFile();
    expect(session.last_wave).toBe(5);
    expect(session.last_wave_completed).toBe(4);
  });

  it('allows the write when the record carries NO session_id (legacy file)', () => {
    writeWaveScope(2);
    writeCurrentSession({ last_wave: 1 });

    expect(runHook(JSON.stringify({ session_id: MINE, batch_id: 'b-legacy' })).status).toBe(0);
    expect(readSessionFile().last_wave).toBe(2);
  });

  it('advances last_wave too on an explicit wave-complete, and never lowers either key', () => {
    // Catches Q2-F1: the explicit branch wrote only the marker, leaving it
    // AHEAD of last_wave (marker 5 > last_wave 4) — after which SessionEnd read
    // `4 !== 5`, emitted a duplicate completed(4) and walked the marker BACK
    // to 4. Both keys are monotone through maxWave().
    writeCurrentSession({ session_id: MINE, last_wave: 4, last_wave_completed: 7 });

    expect(runHook(JSON.stringify({
      session_id: MINE, wave_signal: 'wave-complete', wave_number: 5,
    })).status).toBe(0);

    const session = readSessionFile();
    expect(session.last_wave).toBe(5);
    // 7 is higher than this completion — the mark may only ever rise.
    expect(session.last_wave_completed).toBe(7);
  });

  it('does not re-close a wave when the marker is AHEAD of last_wave', () => {
    // Sequence: explicit wave-complete{5} landed while last_wave was 4, so the
    // marker is 5. The 4→6 fallback transition must NOT emit completed(4).
    writeWaveScope(6);
    writeCurrentSession({ session_id: MINE, last_wave: 4, last_wave_completed: 5 });

    expect(runHook(JSON.stringify({ session_id: MINE, batch_id: 'b-ahead' })).status).toBe(0);

    const events = readEvents();
    expect(events.filter((e) => e.event === 'orchestrator.wave.completed')).toEqual([]);
    const started = events.filter((e) => e.event === 'orchestrator.wave.started');
    expect(started).toHaveLength(1);
    expect(started[0].wave_number).toBe(6);
    expect(readSessionFile().last_wave_completed).toBe(5);
  });
});
