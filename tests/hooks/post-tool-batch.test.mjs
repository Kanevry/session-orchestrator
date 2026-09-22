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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';
import { mkdtempSync, rmSync, writeFileSync as writeFileSyncNode } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance as perfHooks } from 'node:perf_hooks';
import { join as joinPath } from 'node:path';
const perfNow = () => perfHooks.now();
import { maybeTriggerOrphanScan } from '../../hooks/post-tool-batch-wave-signal.mjs';

const HOOK = new URL('../../hooks/post-tool-batch-wave-signal.mjs', import.meta.url).pathname;
const SESSION_REL = join('.orchestrator', 'current-session.json');

let tmp;

beforeEach(() => {
  tmp = makeTmpDir('ptb-test-');
});

afterEach(() => {
  if (tmp && existsSync(tmp)) removeTree(tmp);
});

function runHook(stdinJson, extraEnv = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: stdinJson,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmp,
      SO_HOOK_PROFILE: 'full',
      SO_DISABLED_HOOKS: '',
      ...extraEnv,
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
// orchestrator.wave.completed{prev} on a STRICT INCREASE (wave > last_wave AND
// wave > 0). It then persists the new high-water mark so the next batch on the
// same wave does NOT re-emit; that mark IS the opening of the new wave (the
// `started` event was removed 2026-09-19). The in-session idempotency contract:
//   - same wave as last_wave        → ZERO new wave events (re-emit suppressed)
//   - strict increase               → completed{prev}, persist last_wave
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
      e.event.startsWith('orchestrator.wave.'),
    );
    expect(waveEvents).toEqual([]);
    // last_wave is unchanged (still 3).
    expect(readSessionFile().last_wave).toBe(3);
  });

  it('emits completed{prev} — and no event for the new wave — and persists last_wave on a strict increase', () => {
    writeWaveScope(2);
    writeCurrentSession({ session_id: 's', last_wave: 1 });

    const result = runHook(JSON.stringify({ session_id: 's', batch_id: 'b2', batch_size: 4 }));
    expect(result.status).toBe(0);

    // Exactly one wave record: the close of wave 1.
    const waveEvents = readEvents().filter((e) => e.event.startsWith('orchestrator.wave.'));
    expect(waveEvents.map((e) => [e.event, e.wave_number])).toEqual([['orchestrator.wave.completed', 1]]);

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
    // time. No wave event is legitimate here — the boundary only advances last_wave.
    writeWaveScope(4);
    writeCurrentSession({ session_id: 's', last_wave: 3, last_wave_completed: 3 });

    const result = runHook(JSON.stringify({ session_id: 's', batch_id: 'b-dup', batch_size: 1 }));
    expect(result.status).toBe(0);

    expect(readEvents().filter((e) => e.event === 'orchestrator.wave.completed')).toEqual([]);
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
      e.event.startsWith('orchestrator.wave.'),
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
    // mechanical wave-lifecycle fallback was structurally dead — no wave
    // transition was ever recorded on those platforms, with nothing to
    // distinguish it from an idle session. last_wave advancing 0 → 3 is only
    // reachable by reading the manifest (absent → wave 0 → no transition).
    mkdirSync(join(tmp, '.codex'), { recursive: true });
    writeFileSync(join(tmp, '.codex', 'wave-scope.json'), JSON.stringify({ wave: 3 }), 'utf8');
    writeCurrentSession({ session_id: 's', last_wave: 0 });

    const result = runHook(JSON.stringify({ session_id: 's', batch_id: 'b-codex', batch_size: 2 }));
    expect(result.status).toBe(0);

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

    expect(readEvents().filter((e) => e.event === 'orchestrator.wave.completed')).toEqual([]);
    const session = readSessionFile();
    expect(session.last_wave).toBe(6);
    expect(session.last_wave_completed).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Diff-size measurement on wave.completed (GitLab #980)
// ---------------------------------------------------------------------------
// The `shrinking_diff` convergence signal compares `files_changed` across two
// consecutive `orchestrator.wave.completed` records. Measured 2026-09-05: 144
// such records in this repo's ledger, none carrying a measurement key — the
// signal was structurally dead because NO emitter wrote one. These tests pin
// the emitter half: a `wave_start_sha` stamped at each wave OPEN, and the
// deduped worktree-vs-that-sha count attached to that wave's `completed`.

/** `git` in the sandbox, routed through {@link fixtureGit} — see that module's header. */
function git(cwd, args) {
  return fixtureGit(args, cwd).trim();
}

/** Turn the sandbox into a git repo with two tracked files and one commit. */
function initRepo() {
  git(tmp, ['init', '-q', '-b', 'main']);
  git(tmp, ['config', 'user.email', 'test@example.invalid']);
  git(tmp, ['config', 'user.name', 'Test']);
  // The hook's own artefacts live under these two dirs — a real repo ignores
  // them, and counting them as untracked "wave work" would be wrong.
  writeFileSync(join(tmp, '.gitignore'), '.orchestrator/\n.claude/\n', 'utf8');
  writeFileSync(join(tmp, 'a.txt'), 'a\n', 'utf8');
  writeFileSync(join(tmp, 'b.txt'), 'b\n', 'utf8');
  git(tmp, ['add', '.gitignore', 'a.txt', 'b.txt']);
  git(tmp, ['commit', '-q', '-m', 'init']);
  return git(tmp, ['rev-parse', 'HEAD']);
}

describe('post-tool-batch wave diff-size measurement (#980)', () => {
  const MINE = '33333333-3333-4333-8333-333333333333';

  it('persists wave_start_sha at the wave-OPEN transition', () => {
    const head = initRepo();
    writeWaveScope(1);
    writeCurrentSession({ session_id: MINE, last_wave: 0 });

    expect(runHook(JSON.stringify({ session_id: MINE, batch_id: 'b-open' })).status).toBe(0);

    const session = readSessionFile();
    expect(session.last_wave).toBe(1);
    expect(session.wave_start_sha).toBe(head);
  });

  it('attaches files_changed (tracked edits + untracked, deduped) to completed{N}', () => {
    // The fake-regression target: without the emitter half, the completed
    // record carries no measurement key at all and shrinking_diff never fires.
    const head = initRepo();
    writeFileSync(join(tmp, 'a.txt'), 'a changed\n', 'utf8');
    writeFileSync(join(tmp, 'b.txt'), 'b changed\n', 'utf8');
    writeFileSync(join(tmp, 'c.txt'), 'new\n', 'utf8'); // untracked
    writeWaveScope(2);
    writeCurrentSession({ session_id: MINE, last_wave: 1, wave_start_sha: head });

    expect(runHook(JSON.stringify({ session_id: MINE, batch_id: 'b-diff' })).status).toBe(0);

    const completed = readEvents().filter((e) => e.event === 'orchestrator.wave.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].wave_number).toBe(1);
    expect(completed[0].files_changed).toBe(3);
    expect(completed[0].files_changed_source).toBe('worktree-vs-wave-start-sha');
    // The NEW wave gets its own start sha (HEAD is unchanged — nothing committed).
    expect(readSessionFile().wave_start_sha).toBe(head);
  });

  it('measures the PROJECT repo even under an ambient GIT_DIR/GIT_WORK_TREE redirect', () => {
    // The bug: `git` honours GIT_DIR over `cwd`, so an ambient redirect (the
    // 2026-08-19 incident class) made these probes read a FOREIGN repository —
    // a clean one reports 0 changed files, so the wave silently measures zero
    // while the operator's own worktree is full of edits.
    const head = initRepo();
    writeFileSync(join(tmp, 'a.txt'), 'a changed\n', 'utf8');
    writeFileSync(join(tmp, 'b.txt'), 'b changed\n', 'utf8');
    writeFileSync(join(tmp, 'c.txt'), 'new\n', 'utf8'); // untracked
    writeWaveScope(2);
    writeCurrentSession({ session_id: MINE, last_wave: 1, wave_start_sha: head });

    // A second, CLEAN repo the ambient env points at.
    const foreign = makeTmpDir('ptb-foreign-');
    try {
      git(foreign, ['init', '-q', '-b', 'main']);
      git(foreign, ['config', 'user.email', 'foreign@example.invalid']);
      git(foreign, ['config', 'user.name', 'Foreign']);
      writeFileSync(join(foreign, 'z.txt'), 'z\n', 'utf8');
      git(foreign, ['add', 'z.txt']);
      git(foreign, ['commit', '-q', '-m', 'foreign']);
      const foreignHead = git(foreign, ['rev-parse', 'HEAD']);
      expect(foreignHead).not.toBe(head);

      const res = runHook(JSON.stringify({ session_id: MINE, batch_id: 'b-redirect' }), {
        GIT_DIR: join(foreign, '.git'),
        GIT_WORK_TREE: foreign,
      });
      expect(res.status).toBe(0);

      const completed = readEvents().filter((e) => e.event === 'orchestrator.wave.completed');
      expect(completed).toHaveLength(1);
      expect(completed[0].files_changed).toBe(3); // the fixture repo, not the clean foreign one
      // …and the NEW wave's start sha is the fixture repo's HEAD, not the foreign HEAD.
      expect(readSessionFile().wave_start_sha).toBe(head);
    } finally {
      removeTree(foreign);
    }
  });

  it('omits both keys when no wave_start_sha was ever persisted', () => {
    const head = initRepo();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    writeWaveScope(2);
    writeCurrentSession({ session_id: MINE, last_wave: 1 }); // no wave_start_sha

    expect(runHook(JSON.stringify({ session_id: MINE, batch_id: 'b-nosha' })).status).toBe(0);

    const completed = readEvents().filter((e) => e.event === 'orchestrator.wave.completed');
    expect(completed).toHaveLength(1);
    expect(Object.hasOwn(completed[0], 'files_changed')).toBe(false);
    expect(Object.hasOwn(completed[0], 'files_changed_source')).toBe(false);
  });

  it('git failure (sandbox is not a repo): keys absent, event still emitted, exit 0', () => {
    // No initRepo() — tmp is a bare tmpdir, so every git probe fails.
    writeWaveScope(2);
    writeCurrentSession({
      session_id: MINE,
      last_wave: 1,
      wave_start_sha: '0'.repeat(40),
    });

    const result = runHook(JSON.stringify({ session_id: MINE, batch_id: 'b-nogit' }));
    expect(result.status).toBe(0);

    const events = readEvents();
    const completed = events.filter((e) => e.event === 'orchestrator.wave.completed');
    expect(completed).toHaveLength(1);
    expect(Object.hasOwn(completed[0], 'files_changed')).toBe(false);
    // The stale sha is cleared rather than left to inflate the next count.
    expect(readSessionFile().wave_start_sha).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// orphan-reaper trigger (#1432 B4)
// ---------------------------------------------------------------------------

describe('maybeTriggerOrphanScan — PostToolBatch', () => {
  let rtmp;

  beforeEach(() => { rtmp = mkdtempSync(joinPath(tmpdir(), 'reaper-trigger-')); });
  afterEach(() => { rmSync(rtmp, { recursive: true, force: true }); });

  /** Record every spawn the trigger attempts, without ever spawning. */
  function recordingSpawn(calls) {
    return (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { unref() {} };
    };
  }

  function writeClaudeMd(body) {
    writeFileSyncNode(joinPath(rtmp, 'CLAUDE.md'), body, 'utf8');
  }

  it('does nothing when no CLAUDE.md/AGENTS.md exists', async () => {
    // Bug: an unreadable config defaulting to ENABLED would arm a signal-sending
    // watchdog on every repo that has no Session Config at all.
    const calls = [];
    const r = await maybeTriggerOrphanScan({ projectDir: rtmp, spawnFn: recordingSpawn(calls) });
    expect(r).toEqual({ spawned: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('reaper.enabled: false → no stat, no spawn', async () => {
    // Bug: the default-off block still paying for a marker stat on every hook.
    writeClaudeMd('reaper:\n  enabled: false\n');
    const calls = [];
    const stats = [];
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: recordingSpawn(calls),
      statFn: (p) => { stats.push(p); throw new Error('nope'); },
    });
    expect(r).toEqual({ spawned: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
    expect(stats).toHaveLength(0);
  });

  it('spawns exactly one detached child when armed and the marker is absent', async () => {
    writeClaudeMd('reaper:\n  enabled: true\n');
    const calls = [];
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: recordingSpawn(calls),
      writeFn: () => {},
    });
    expect(r).toEqual({ spawned: true, reason: 'spawned' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.cmd).toBe(process.execPath);
    expect(call.opts).toMatchObject({ detached: true, stdio: 'ignore' });
    // argv shape: <scriptPath> --repo-root <p> --mode <m> --min-age-seconds …
    // The script path is argv[0] — no `--input-type=module -e <program>` any
    // more, so nothing this hook builds is executable source at all.
    expect(call.args[0]).toMatch(/orphan-reaper\.mjs$/);
    expect(call.args[0].startsWith('file://')).toBe(false);
    expect(call.args.slice(1, 5)).toEqual(['--repo-root', rtmp, '--mode', 'report']);
    // Bug: a checkout path reaching the child as anything but its OWN argv
    // value (an interpolated `-e` program, a concatenated `--repo-root=<p>`)
    // is code or an unparseable flag, not a value.
    expect(call.args).not.toContain('-e');
    expect(call.args.filter((a) => a.includes(rtmp))).toEqual([rtmp]);
  });

  it('the throttle skips the spawn when the marker is fresh', async () => {
    // Bug (PRD FA4, second scenario): without the throttle a PostToolBatch storm
    // spawns one ps-running child per tool call.
    writeClaudeMd('reaper:\n  enabled: true\n  min-scan-interval-seconds: 30\n');
    const calls = [];
    const now = 1_000_000;
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      now,
      spawnFn: recordingSpawn(calls),
      statFn: () => ({ mtimeMs: now - 5_000 }),
      writeFn: () => {},
    });
    expect(r).toEqual({ spawned: false, reason: 'throttled' });
    expect(calls).toHaveLength(0);
  });

  it('spawns again once the interval has elapsed', async () => {
    writeClaudeMd('reaper:\n  enabled: true\n  min-scan-interval-seconds: 30\n');
    const calls = [];
    const now = 1_000_000;
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      now,
      spawnFn: recordingSpawn(calls),
      statFn: () => ({ mtimeMs: now - 31_000 }),
      writeFn: () => {},
    });
    expect(r).toEqual({ spawned: true, reason: 'spawned' });
    expect(calls).toHaveLength(1);
  });

  it('passes mode: kill through to the child', async () => {
    writeClaudeMd('reaper:\n  enabled: true\n  mode: kill\n  min-age-seconds: 600\n');
    const calls = [];
    await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: recordingSpawn(calls),
      writeFn: () => {},
    });
    expect(calls[0].args.slice(3, 7))
      .toEqual(['--mode', 'kill', '--min-age-seconds', '600']);
  });

  it('passes reaper.false-alarm-window through to the child — the key had NO consumer before 2026-09-22', async () => {
    // Bug: `false-alarm-window` was parsed, defaulted, documented and never
    // sent anywhere. `runOrphanScan` hard-coded REAPER_DEFAULTS, so configuring
    // it changed nothing at all — a config key that only its parser knows.
    writeClaudeMd('reaper:\n  enabled: true\n  false-alarm-window: 25\n');
    const calls = [];
    await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: recordingSpawn(calls),
      writeFn: () => {},
    });
    const i = calls[0].args.indexOf('--false-alarm-window');
    expect(i).toBeGreaterThan(0);
    expect(calls[0].args[i + 1]).toBe('25');
  });

  it('WARNS on stderr when the trigger overran reaper.max-hook-latency-ms, and stays silent inside it', async () => {
    // Bug: `max-hook-latency-ms` was a documented budget nothing measured
    // against — the only "enforcement" was the prose claim that the scan runs
    // detached. A budget with no measurement cannot be exceeded OR held.
    writeClaudeMd('reaper:\n  enabled: true\n  max-hook-latency-ms: 5\n');
    const written = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      // A clock that jumps 12 ms between entry and the post-spawn check.
      let t = 0;
      await maybeTriggerOrphanScan({
        projectDir: rtmp,
        spawnFn: () => ({ unref() {} }),
        writeFn: () => {},
        clockFn: () => { const v = t; t += 12; return v; },
      });
      expect(written.join('')).toMatch(/hook latency 12\.0 ms exceeded reaper\.max-hook-latency-ms \(5 ms\)/);

      written.length = 0;
      let t2 = 0;
      await maybeTriggerOrphanScan({
        projectDir: rtmp,
        spawnFn: () => ({ unref() {} }),
        writeFn: () => {},
        clockFn: () => { const v = t2; t2 += 1; return v; },
      });
      expect(written).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('degrades silently when the spawn throws', async () => {
    // Bug (PRD FA4): the hook must never fail because the reaper did.
    writeClaudeMd('reaper:\n  enabled: true\n');
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: () => { throw new Error('EAGAIN'); },
      writeFn: () => {},
    });
    expect(r).toEqual({ spawned: false, reason: 'error' });
  });

  it('returns within reaper.max-hook-latency-ms (50 ms)', async () => {
    // Bug: running the scan inline. One ps round-trip out of Node was measured
    // at ~47 ms over 287 KB — alone enough to blow the budget.
    writeClaudeMd('reaper:\n  enabled: true\n');
    const spawnFn = () => ({ unref() {} });
    // Warm the dynamic import so the measurement is the STEADY-STATE cost the
    // hook pays, not the one-off module load of the very first tool batch.
    await maybeTriggerOrphanScan({ projectDir: rtmp, spawnFn, writeFn: () => {} });
    const started = perfNow();
    await maybeTriggerOrphanScan({ projectDir: rtmp, spawnFn, writeFn: () => {} });
    expect(perfNow() - started).toBeLessThan(50);
  });
});

describe('orphan-reaper wiring — the hook actually calls the trigger (#1432 B4)', () => {
  let wtmp;

  beforeEach(() => { wtmp = mkdtempSync(joinPath(tmpdir(), 'reaper-wiring-ptb-')); });
  afterEach(() => { rmSync(wtmp, { recursive: true, force: true }); });

  function runIn(projectDir) {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ batch_id: 'b1', batch_size: 1 }),
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        SO_HOOK_PROFILE: 'full',
        SO_DISABLED_HOOKS: '',
      },
      timeout: 15_000,
    });
  }

  it('stamps the throttle marker when reaper.enabled: true', () => {
    // Bug: the exported trigger works but NO call site invokes it — the unit
    // tests above would stay green while the watchdog never runs in production.
    // `mode: report` keeps the detached child in dry-run: it sends no signals.
    writeFileSync(joinPath(wtmp, 'CLAUDE.md'), 'reaper:\n  enabled: true\n  mode: report\n', 'utf8');
    const marker = joinPath(wtmp, '.orchestrator', 'tmp', 'reaper-last-scan');
    expect(existsSync(marker)).toBe(false);

    const res = runIn(wtmp);
    expect(res.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it('writes no marker when the reaper is not armed', () => {
    writeFileSync(joinPath(wtmp, 'CLAUDE.md'), 'reaper:\n  enabled: false\n', 'utf8');
    const res = runIn(wtmp);
    expect(res.status).toBe(0);
    expect(existsSync(joinPath(wtmp, '.orchestrator', 'tmp', 'reaper-last-scan'))).toBe(false);
  });
});
