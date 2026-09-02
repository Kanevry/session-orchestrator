/**
 * tests/lib/session-close-backfill.test.mjs
 *
 * Tests for scripts/lib/session-close-backfill.mjs — the SessionEnd
 * close-through backfill core (Epic #724 C1).
 *
 * Strategy: build an isolated tmp repoRoot with fixture events.jsonl +
 * sessions.jsonl, drive backfillAbandonedSession() against it, and assert on
 * the returned action + the record actually appended to sessions.jsonl. Uses
 * the REAL readLock / isLockLive (reading the tmp session.lock) so the
 * foreign-live-lock guard is exercised end-to-end, not mocked away.
 *
 * Testing-rule compliance (testing.md):
 *   - Behaviour, not implementation: assertions target the returned action and
 *     the on-disk record shape.
 *   - Hardcoded expected values (session_type, status, flags).
 *   - Error path proves the no-throw contract (would-be-fatal append is caught).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { backfillAbandonedSession, backfillCompletedFromStateMd, isUuid } from '@lib/session-close-backfill.mjs';
import { validateSession } from '@lib/session-schema/validator.mjs';
import { serializeStateMd } from '@lib/state-md/yaml-parser.mjs';

const UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const STARTED_AT = '2026-05-27T14:00:00.000Z';
// A fixed "now" comfortably AFTER started_at → deterministic completed_at.
const NOW_MS = Date.parse('2026-05-27T18:30:00.000Z');

let repoRoot;
const tmpDirs = [];

function metricsDir() {
  return path.join(repoRoot, '.orchestrator', 'metrics');
}

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function readSessions() {
  const file = path.join(metricsDir(), 'sessions.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function seedEvents(records) {
  writeJsonl(path.join(metricsDir(), 'events.jsonl'), records);
}

function seedSessions(records) {
  writeJsonl(path.join(metricsDir(), 'sessions.jsonl'), records);
}

/**
 * Write a STATE.md at a fixed, DI-injected path (bypasses the real
 * `resolveStateMdPath()`'s env-dependent platform detection — deterministic
 * regardless of ambient `SO_PLATFORM`/`SO_STATE_DIR`, mirroring the other
 * `deps` overrides in this file).
 */
function stateMdPath() {
  return path.join(repoRoot, 'STATE.md');
}

function writeStateMd(frontmatter, body = '\n# STATE\n') {
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(stateMdPath(), serializeStateMd({ frontmatter, body }), 'utf8');
}

function stateMdDeps() {
  return { resolveStateMdPath: () => stateMdPath() };
}

/** Write a session.lock file at the tmp repoRoot with the given fields. */
function seedLock({ sessionId, semanticSessionId, lastHeartbeat }) {
  const lock = {
    session_id: sessionId,
    started_at: STARTED_AT,
    last_heartbeat: lastHeartbeat,
    mode: 'deep',
    pid: 999999,
    host: os.hostname(),
    ttl_hours: 4,
    ...(semanticSessionId ? { semantic_session_id: semanticSessionId } : {}),
  };
  fs.mkdirSync(path.join(repoRoot, '.orchestrator'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.orchestrator', 'session.lock'), JSON.stringify(lock, null, 2) + '\n');
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'close-backfill-'));
  tmpDirs.push(repoRoot);
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Happy path — abandoned backfill validates + appends
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — happy path', () => {
  it('backfills a validated status:abandoned record bridged via lock.acquired', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main', project: 'demo' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
      { timestamp: '2026-05-27T17:00:00.000Z', event: 'orchestrator.session.ended', session_id: UUID, reason: 'clear' },
    ]);

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    expect(res.sessionId).toBe('main-2026-05-27-session-1');

    const recorded = readSessions();
    expect(recorded).toHaveLength(1);
    const rec = recorded[0];
    expect(rec.session_id).toBe('main-2026-05-27-session-1');
    expect(rec.status).toBe('abandoned');
    expect(rec.session_type).toBe('feature'); // mode was a valid enum → not inferred
    expect(rec._session_type_inferred).toBeUndefined();
    expect(rec.branch).toBe('main');
    expect(rec._backfill_source).toBe('events-jsonl');
    expect(rec.waves).toEqual([]);
    expect(rec.agent_summary).toEqual({ complete: 0, partial: 0, failed: 0, spiral: 0 });
    // completed_at prefers the last terminal event (17:00), not the fixed now.
    expect(rec.completed_at).toBe('2026-05-27T17:00:00.000Z');
    // The appended line must itself re-validate (round-trip contract).
    expect(() => validateSession(rec)).not.toThrow();
    expect(rec._backfill_incomplete_fields).toContain('total_agents');
    // Counterpart to the no-terminal-event fallback below: a GENUINE
    // STOPPED/ENDED event means completed_at is measured, not reconstructed —
    // 'completed_at' must NOT be flagged incomplete here. A regression that
    // marks it incomplete unconditionally would silently blanket-flag every
    // record, including this one.
    expect(rec._backfill_incomplete_fields).not.toContain('completed_at');
  });
});

// ---------------------------------------------------------------------------
// #731 — completed_at reconstruction from lastEventMs when NO terminal event
// (STOPPED/ENDED) exists. Before this fix, terminalMs fell back straight to
// nowMs — the BACKFILL RUN's own wall-clock — silently inventing a completion
// time far in the future of when the session actually went quiet (measured
// against the live ledger: 91.0h and 74.7h phantom runtimes on two real
// records, one of which retroactively silenced sessions-staleness-banner by
// dragging its ledger anchor forward).
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — completed_at reconstruction from lastEventMs (#731, no terminal event)', () => {
  it('reconstructs completed_at from the last KNOWN event, not from `now`, and flags it incomplete when no terminal event exists', async () => {
    const lastKnownEventIso = '2026-05-27T14:01:00.000Z';
    // `now` is 91h AFTER the last known event — mirrors the measured
    // production phantom-runtime incident (91.0h). If terminalMs fell back to
    // nowMs instead of lastEventMs, completed_at would silently be 91h later
    // than the session's actual last activity.
    const farFutureNowMs = Date.parse(lastKnownEventIso) + 91 * 3600 * 1000;
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: lastKnownEventIso,
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
      // No 'stopped'/'ended' event — genuinely abandoned.
    ]);

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: farFutureNowMs });

    expect(res.action).toBe('backfilled');
    const rec = readSessions()[0];
    expect(rec.completed_at).toBe(lastKnownEventIso);
    expect(rec._backfill_incomplete_fields).toContain('completed_at');
  });
});

// ---------------------------------------------------------------------------
// #914 R1 — completed_at is events-attested, never the backfill-run wall-clock.
// A missing terminal event previously fabricated `nowMs` → ~64h phantom runtime
// on real records. Fix: fall back to lastEventMs (flagged as an estimate), never
// the run time; the record must round-trip through the schema (null is illegal).
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — completed_at attribution (#914 R1)', () => {
  // No terminal event: only started + lock.acquired (last life-sign at 14:01).
  const noTerminalEvents = () => [
    { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    {
      timestamp: '2026-05-27T14:01:00.000Z',
      event: 'orchestrator.session.lock.acquired',
      session_id: UUID,
      semantic_session_id: 'main-2026-05-27-session-1',
      mode: 'feature',
    },
  ];

  it('uses lastEventMs (14:01), NOT the backfill-run now (18:30), when no terminal event exists', async () => {
    seedEvents(noTerminalEvents());

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    const rec = readSessions()[0];
    // The exact anti-regression: nowMs was '2026-05-27T18:30:00.000Z' (fabricated
    // ~4.5h runtime). The real last life-sign is 14:01 — a 1-minute session.
    expect(rec.completed_at).toBe('2026-05-27T14:01:00.000Z');
    expect(rec.completed_at).not.toBe(new Date(NOW_MS).toISOString());
  });

  it('flags the estimate: _completed_at_estimated + completed_at in _backfill_incomplete_fields', async () => {
    seedEvents(noTerminalEvents());

    await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });
    const rec = readSessions()[0];
    expect(rec._completed_at_estimated).toBe(true);
    expect(rec._backfill_incomplete_fields).toContain('completed_at');
    // Still a legal ISO string — the schema rejects a null completed_at.
    expect(() => validateSession(rec)).not.toThrow();
  });

  it('does NOT flag completed_at when a real terminal event is present', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
      { timestamp: '2026-05-27T17:00:00.000Z', event: 'orchestrator.session.ended', session_id: UUID, reason: 'clear' },
    ]);

    await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });
    const rec = readSessions()[0];
    expect(rec.completed_at).toBe('2026-05-27T17:00:00.000Z');
    expect(rec._completed_at_estimated).toBeUndefined();
    expect(rec._backfill_incomplete_fields).not.toContain('completed_at');
  });
});

// ---------------------------------------------------------------------------
// #773 — carryover sentinel: an abandoned stub never ran Phase 1.65, so its
// carryover is genuinely UNKNOWN and must be emitted as null (not 0).
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — carryover sentinel (#773)', () => {
  const gatedEvents = () => [
    { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    {
      timestamp: '2026-05-27T14:01:00.000Z',
      event: 'orchestrator.session.lock.acquired',
      session_id: UUID,
      semantic_session_id: 'main-2026-05-27-session-1',
      mode: 'feature',
    },
  ];

  it('synthesizes effectiveness.carryover as null (unknown), never 0 (measured)', async () => {
    seedEvents(gatedEvents());

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    const rec = readSessions()[0];
    // toEqual({ carryover: null }) is exact — a coerced-to-0 regression fails it,
    // and it survives the JSONL append + re-read round-trip (null is not dropped).
    expect(rec.effectiveness).toEqual({ carryover: null });
  });

  it('the stub carrying effectiveness.carryover:null still re-validates against the schema', async () => {
    seedEvents(gatedEvents());

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    const rec = readSessions()[0];
    // Premise — confirm the null sentinel is actually present on the record...
    expect(rec.effectiveness.carryover).toBeNull();
    // ...then prove the { carryover: null } shape passes the schema's
    // effectiveness object-or-null gate (round-trip contract).
    expect(() => validateSession(rec)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Dedupe skip
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — dedupe', () => {
  it('skips when the semantic id is already recorded in sessions.jsonl', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
    ]);
    seedSessions([
      {
        session_id: 'main-2026-05-27-session-1',
        session_type: 'feature',
        started_at: STARTED_AT,
        completed_at: '2026-05-27T15:00:00.000Z',
        total_waves: 1,
        waves: [{ wave: 1, role: 'coordinator' }],
        agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
        total_agents: 1,
        total_files_changed: 2,
      },
    ]);

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('skipped-already-recorded');
    expect(res.sessionId).toBe('main-2026-05-27-session-1');
    // The pre-existing record is untouched (still exactly one record).
    expect(readSessions()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Foreign live lock skip
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — foreign live lock guard', () => {
  it('refuses to backfill while a FOREIGN live session.lock is held', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
    ]);
    // Lock owned by a DIFFERENT session, heartbeat = now → live.
    seedLock({
      sessionId: OTHER_UUID,
      semanticSessionId: 'main-2026-05-27-session-2',
      lastHeartbeat: new Date(NOW_MS).toISOString(),
    });

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('skipped-foreign-live-lock');
    expect(res.lockSessionId).toBe(OTHER_UUID);
    expect(readSessions()).toHaveLength(0);
  });

  it('still backfills when the foreign lock is STALE (heartbeat older than TTL)', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
    ]);
    // Heartbeat 10h before now, ttl 4h → dead → does not block backfill.
    seedLock({
      sessionId: OTHER_UUID,
      semanticSessionId: 'main-2026-05-27-session-2',
      lastHeartbeat: new Date(NOW_MS - 10 * 3600 * 1000).toISOString(),
    });

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    expect(readSessions()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Dead-by-age relaxation past a live foreign lock (#731)
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — dead-by-age relaxation (#731)', () => {
  it('bypasses a LIVE foreign lock when the candidate is older than the default TTL and relaxDeadByAge is set', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
    ]);
    // Foreign lock, heartbeat = now → live. The candidate's last known event
    // (14:01) is 4h29m before NOW_MS — older than DEFAULT_TTL_HOURS (4h).
    seedLock({
      sessionId: OTHER_UUID,
      semanticSessionId: 'main-2026-05-27-session-2',
      lastHeartbeat: new Date(NOW_MS).toISOString(),
    });

    const res = await backfillAbandonedSession({
      repoRoot,
      sessionId: UUID,
      now: NOW_MS,
      relaxDeadByAge: true,
    });

    expect(res.action).toBe('backfilled');
    expect(res.deadByAge).toBe(true);
    expect(readSessions()).toHaveLength(1);
  });

  it('still blocks on a LIVE foreign lock when the candidate is WITHIN the default TTL, even with relaxDeadByAge set', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        // 30 minutes before NOW_MS — well within the 4h TTL window.
        timestamp: '2026-05-27T18:00:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
    ]);
    seedLock({
      sessionId: OTHER_UUID,
      semanticSessionId: 'main-2026-05-27-session-2',
      lastHeartbeat: new Date(NOW_MS).toISOString(),
    });

    const res = await backfillAbandonedSession({
      repoRoot,
      sessionId: UUID,
      now: NOW_MS,
      relaxDeadByAge: true,
    });

    expect(res.action).toBe('skipped-foreign-live-lock');
    expect(readSessions()).toHaveLength(0);
  });

  it('assumeDeadBeforeMs boundary — exactly AT the cutoff stays blocked, 1ms before it backfills', async () => {
    const lastEventMs = Date.parse(STARTED_AT);
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    ]);
    seedLock({
      sessionId: OTHER_UUID,
      semanticSessionId: 'main-2026-05-27-session-2',
      lastHeartbeat: new Date(NOW_MS).toISOString(),
    });

    // Exactly at the candidate's last-event timestamp → NOT strictly before → blocked.
    const atCutoff = await backfillAbandonedSession({
      repoRoot,
      sessionId: UUID,
      semanticSessionId: 'boundary-at-cutoff',
      now: NOW_MS,
      assumeDeadBeforeMs: lastEventMs,
    });
    expect(atCutoff.action).toBe('skipped-foreign-live-lock');

    // 1ms after the candidate's last-event timestamp (i.e. the candidate is
    // 1ms before the cutoff) → strictly before → backfills.
    const beforeCutoff = await backfillAbandonedSession({
      repoRoot,
      sessionId: UUID,
      semanticSessionId: 'boundary-before-cutoff',
      now: NOW_MS,
      assumeDeadBeforeMs: lastEventMs + 1,
    });
    expect(beforeCutoff.action).toBe('backfilled');
    expect(beforeCutoff.deadByAge).toBe(true);

    expect(readSessions()).toHaveLength(1); // only the "before cutoff" one wrote
  });

  it('WITHOUT relaxDeadByAge/assumeDeadBeforeMs, a stale-by-age candidate still gets blocked by a LIVE foreign lock (regression)', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
    ]);
    // Same shape as the first test in this block (dead-by-age eligible),
    // but called with the DEFAULT params — must reproduce pre-#731 behaviour.
    seedLock({
      sessionId: OTHER_UUID,
      semanticSessionId: 'main-2026-05-27-session-2',
      lastHeartbeat: new Date(NOW_MS).toISOString(),
    });

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('skipped-foreign-live-lock');
    expect(res.deadByAge).toBeUndefined();
    expect(readSessions()).toHaveLength(0);
  });

  it('delta exactly == ttlMs stays blocked (strict >)', async () => {
    // isCandidateDeadByAge uses `nowMs - lastEventMs > ttlMs` — a STRICT
    // inequality. A candidate whose last known event sits EXACTLY at the
    // DEFAULT_TTL_HOURS (4h) boundary must NOT be relaxed.
    const ttlMs = 4 * 3600 * 1000; // DEFAULT_TTL_HOURS
    const lastEventIso = new Date(NOW_MS - ttlMs).toISOString();
    seedEvents([
      { timestamp: lastEventIso, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    ]);
    seedLock({
      sessionId: OTHER_UUID,
      semanticSessionId: 'main-2026-05-27-session-2',
      lastHeartbeat: new Date(NOW_MS).toISOString(),
    });

    const res = await backfillAbandonedSession({
      repoRoot,
      sessionId: UUID,
      now: NOW_MS,
      relaxDeadByAge: true,
    });

    expect(res.action).toBe('skipped-foreign-live-lock');
    expect(res.deadByAge).toBeUndefined();
  });

  it('null lastEventMs (unparseable timestamps) never unlocks relaxDeadByAge', async () => {
    // Every event timestamp is unparseable → collectSessionEvents never sets
    // lastEventMs (it stays null). isCandidateDeadByAge's very first guard
    // (`typeof lastEventMs !== 'number'`) must return false unconditionally —
    // relaxDeadByAge:true must not somehow bypass a lock when the candidate's
    // age cannot even be determined (erring toward the conservative/block
    // behaviour per the module's own documented contract).
    seedEvents([
      { timestamp: 'not-a-real-timestamp', event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    ]);
    seedLock({
      sessionId: OTHER_UUID,
      semanticSessionId: 'main-2026-05-27-session-2',
      lastHeartbeat: new Date(NOW_MS).toISOString(),
    });

    const res = await backfillAbandonedSession({
      repoRoot,
      sessionId: UUID,
      now: NOW_MS,
      relaxDeadByAge: true,
    });

    expect(res.action).toBe('skipped-foreign-live-lock');
    expect(res.deadByAge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #863 — own-live-lock self-exclusion (defect 1: a live OWN session was
// getting recorded 'abandoned' because the pre-#863 guard only ever checked
// `foreign`, never `own`).
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — own-live-lock guard (#863)', () => {
  it('refuses to backfill its OWN candidate while that session\'s own lock is still live', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
      // No 'stopped'/'ended' event — this session is genuinely still running.
    ]);
    // Own lock (UUID + semantic match), heartbeat = now → live.
    seedLock({
      sessionId: UUID,
      semanticSessionId: 'main-2026-05-27-session-1',
      lastHeartbeat: new Date(NOW_MS).toISOString(),
    });

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('skipped-own-live-lock');
    expect(res.sessionId).toBe('main-2026-05-27-session-1');
    expect(readSessions()).toHaveLength(0);
  });

  it('negative twin — still backfills its OWN candidate when that session\'s own lock is STALE (not a blanket off-switch)', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
    ]);
    // Own lock, heartbeat 10h before now, ttl 4h → stale/dead.
    seedLock({
      sessionId: UUID,
      semanticSessionId: 'main-2026-05-27-session-1',
      lastHeartbeat: new Date(NOW_MS - 10 * 3600 * 1000).toISOString(),
    });

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    expect(readSessions()).toHaveLength(1);
  });

  it('lock-shape trap (d) — a live OWN candidate is still recognised when the lock stores the semantic id directly in `session_id` (no `semantic_session_id` field), even bridged via events + relaxDeadByAge', async () => {
    // Mirrors the real CLI usage pattern flagged in the task: relaxDeadByAge
    // is passed unconditionally by the migration CLI. Without the (d) shape
    // fallback, this OWN live lock is misclassified `foreign`, and its age
    // (last known event 4h29m before NOW_MS, older than the 4h TTL) makes
    // isCandidateDeadByAge relax right past the (wrongly-foreign) live-lock
    // guard — incorrectly backfilling a session that is live RIGHT NOW.
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'feature',
      },
    ]);
    // Shape-trap lock: session_id IS the semantic id; no semantic_session_id
    // field at all. Heartbeat = now → live.
    seedLock({
      sessionId: 'main-2026-05-27-session-1',
      semanticSessionId: undefined,
      lastHeartbeat: new Date(NOW_MS).toISOString(),
    });

    const res = await backfillAbandonedSession({
      repoRoot,
      sessionId: UUID,
      now: NOW_MS,
      relaxDeadByAge: true,
    });

    expect(res.action).toBe('skipped-own-live-lock');
    expect(res.deadByAge).toBeUndefined();
    expect(readSessions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TOCTOU marker skip
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — TOCTOU marker', () => {
  it('skips when the marker already exists (lost the atomic claim)', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    ]);
    // Pre-create the marker keyed by the semantic id we pass explicitly.
    fs.mkdirSync(metricsDir(), { recursive: true });
    fs.writeFileSync(path.join(metricsDir(), '.backfilled-main-2026-05-27-session-9.marker'), '');

    const res = await backfillAbandonedSession({
      repoRoot,
      sessionId: UUID,
      semanticSessionId: 'main-2026-05-27-session-9',
      now: NOW_MS,
    });

    expect(res.action).toBe('skipped-marker-exists');
    expect(res.sessionId).toBe('main-2026-05-27-session-9');
    expect(readSessions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mode → session_type coercion
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — session_type coercion', () => {
  it('coerces an invalid lock.mode ("session") to housekeeping + flags it inferred', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'feat/x' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-5',
        mode: 'session', // NOT a valid session_type enum
      },
    ]);

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    const rec = readSessions()[0];
    expect(rec.session_type).toBe('housekeeping');
    expect(rec._session_type_inferred).toBe(true);
    expect(() => validateSession(rec)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Synthetic id
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — synthetic id', () => {
  it('mints a synthetic id when no lock.acquired bridge exists', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      { timestamp: '2026-05-27T17:00:00.000Z', event: 'orchestrator.session.stopped', session_id: UUID, wave: 0 },
    ]);

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    const rec = readSessions()[0];
    expect(rec._synthetic_session_id).toBe(true);
    // Pattern: <branch>-<YYYY-MM-DD>-abandoned-<8 hex>
    expect(rec.session_id).toMatch(/^main-2026-05-27-abandoned-[0-9a-f]{8}$/);
    // No lock.acquired → mode absent → session_type inferred housekeeping.
    expect(rec.session_type).toBe('housekeeping');
    expect(rec._session_type_inferred).toBe(true);
    expect(() => validateSession(rec)).not.toThrow();
    // The minted id must NOT be a UUID.
    expect(isUuid(rec.session_id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No-throw contract
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — never throws', () => {
  it('returns { action: "error" } instead of throwing when the append fails', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    ]);

    const boom = () => {
      throw new Error('disk full');
    };

    const res = await backfillAbandonedSession({
      repoRoot,
      sessionId: UUID,
      semanticSessionId: 'main-2026-05-27-session-7',
      now: NOW_MS,
      deps: { appendJsonl: boom },
    });

    expect(res.action).toBe('error');
    expect(res.error).toMatch(/disk full/);
    // Nothing was appended.
    expect(readSessions()).toHaveLength(0);
  });

  it('returns skipped-no-identifier when neither id is provided', async () => {
    seedEvents([]);
    const res = await backfillAbandonedSession({ repoRoot, sessionId: null, semanticSessionId: null, now: NOW_MS });
    expect(res.action).toBe('skipped-no-identifier');
  });

  it('does not write in dryRun mode but reports the record it WOULD write', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'deep',
      },
    ]);

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS, dryRun: true });

    expect(res.action).toBe('would-backfill');
    expect(res.record.session_type).toBe('deep');
    expect(res.record.status).toBe('abandoned');
    // dryRun writes nothing (no sessions.jsonl, no marker).
    expect(readSessions()).toHaveLength(0);
    expect(fs.existsSync(path.join(metricsDir(), '.backfilled-main-2026-05-27-session-1.marker'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #429 — backfillCompletedFromStateMd: STATE.md `status: completed` without a
// matching sessions.jsonl record (the /close Pre-Check gap). Three cases per
// the task: (a) completed + record present -> no-op, (b) completed + no
// record -> backfilled with `_backfill_source: 'state-md-completed'`,
// (c) a second run after (b) -> no-op (idempotent).
// ---------------------------------------------------------------------------

describe('backfillCompletedFromStateMd — #429', () => {
  const COMPLETED_FRONTMATTER = {
    'schema-version': 1,
    'session-type': 'deep',
    branch: 'main',
    issues: [],
    started_at: STARTED_AT,
    status: 'completed',
    'current-wave': 3,
    'total-waves': 3,
    session: 'main-2026-05-27-session-1',
  };

  it('(a) no-op when a record for the STATE.md session id already exists', async () => {
    writeStateMd(COMPLETED_FRONTMATTER);
    seedSessions([
      {
        session_id: 'main-2026-05-27-session-1',
        session_type: 'deep',
        started_at: STARTED_AT,
        completed_at: '2026-05-27T15:00:00.000Z',
        total_waves: 3,
        waves: [{ wave: 1, role: 'coordinator' }],
        agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 },
        total_agents: 3,
        total_files_changed: 5,
        status: 'completed',
      },
    ]);

    const res = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(res.action).toBe('skipped-already-recorded');
    expect(res.sessionId).toBe('main-2026-05-27-session-1');
    // The pre-existing record is untouched (still exactly one record).
    expect(readSessions()).toHaveLength(1);
  });

  it('(b) backfills a status:completed record tagged _backfill_source:state-md-completed when none exists', async () => {
    writeStateMd(COMPLETED_FRONTMATTER);
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'deep',
      },
      { timestamp: '2026-05-27T17:00:00.000Z', event: 'orchestrator.session.ended', session_id: UUID, reason: 'clear' },
    ]);
    // No sessions.jsonl at all yet.

    const res = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(res.action).toBe('backfilled');
    expect(res.sessionId).toBe('main-2026-05-27-session-1');

    const recorded = readSessions();
    expect(recorded).toHaveLength(1);
    const rec = recorded[0];
    expect(rec.session_id).toBe('main-2026-05-27-session-1');
    // The load-bearing distinction vs. backfillAbandonedSession: 'completed',
    // never 'abandoned' — STATE.md itself claims the session finished normally.
    expect(rec.status).toBe('completed');
    expect(rec._backfill_source).toBe('state-md-completed');
    expect(rec.session_type).toBe('deep');
    // events.jsonl-derived counters (same machinery as the abandoned path).
    expect(rec.completed_at).toBe('2026-05-27T17:00:00.000Z');
    expect(() => validateSession(rec)).not.toThrow();
  });

  it('(b2) stamps raw_session_id from the single bridged uuid — the abandoned path is not the only writer', async () => {
    // The bug: only backfillAbandonedSession stamped `raw_session_id`, so the
    // AUTHORITATIVE half of a pair carried no join key back to its harness
    // UUID — exactly the blind spot #1167 exists to close, reproduced on the
    // stronger record.
    writeStateMd(COMPLETED_FRONTMATTER);
    seedEvents([
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'deep',
      },
    ]);

    const res = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(res.action).toBe('backfilled');
    expect(readSessions()[0].raw_session_id).toBe(UUID);
  });

  it('(b3) omits raw_session_id when no uuid is bridged at all', async () => {
    // The other half of the contract: guessing a uuid is worse than omitting
    // it, so an events-less run must leave the key ABSENT (not null, not '').
    writeStateMd(COMPLETED_FRONTMATTER);
    seedEvents([]);

    const res = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(res.action).toBe('backfilled');
    expect('raw_session_id' in readSessions()[0]).toBe(false);
  });

  it('(c) a second run after (b) is a no-op (idempotent — dedupe against the just-written record)', async () => {
    writeStateMd(COMPLETED_FRONTMATTER);
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    ]);

    const first = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });
    expect(first.action).toBe('backfilled');
    expect(readSessions()).toHaveLength(1);

    const second = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(second.action).toBe('skipped-already-recorded');
    expect(second.sessionId).toBe('main-2026-05-27-session-1');
    // No duplicate record.
    expect(readSessions()).toHaveLength(1);
  });

  it('skips silently when STATE.md status is not completed (active/paused/idle)', async () => {
    writeStateMd({ ...COMPLETED_FRONTMATTER, status: 'active' });

    const res = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(res.action).toBe('skipped-not-completed');
    expect(res.status).toBe('active');
    expect(readSessions()).toHaveLength(0);
  });

  it('skips when STATE.md has no `session` field to key the record by', async () => {
    const { session, ...withoutSession } = COMPLETED_FRONTMATTER;
    void session;
    writeStateMd(withoutSession);

    const res = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(res.action).toBe('skipped-no-session-id');
    expect(readSessions()).toHaveLength(0);
  });

  it('skips when STATE.md does not exist at the resolved path', async () => {
    // repoRoot exists but nothing was ever written at stateMdPath().
    const res = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(res.action).toBe('skipped-no-state-md');
    expect(readSessions()).toHaveLength(0);
  });

  it('never throws when the append fails (no-throw contract, mirrors backfillAbandonedSession)', async () => {
    writeStateMd(COMPLETED_FRONTMATTER);
    // Pre-create .orchestrator/metrics/ (normally done by seeding events/sessions)
    // so the failure under test is the injected append, not an incidental ENOENT
    // on the TOCTOU marker's own directory.
    fs.mkdirSync(metricsDir(), { recursive: true });
    const boom = () => {
      throw new Error('disk full');
    };

    const res = await backfillCompletedFromStateMd({
      repoRoot,
      now: NOW_MS,
      deps: { ...stateMdDeps(), appendJsonl: boom },
    });

    expect(res.action).toBe('error');
    expect(res.error).toMatch(/disk full/);
    expect(readSessions()).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// #1068 AC3/AC4 — supersede a backfill stub with the identity-complete record
// ---------------------------------------------------------------------------

describe('backfillCompletedFromStateMd — supersedes a backfill stub (#1068 AC3/AC4)', () => {
  const SEMANTIC = 'main-2026-05-27-session-1';
  const COMPLETED_FRONTMATTER = {
    'schema-version': 1,
    'session-type': 'deep',
    branch: 'main',
    issues: [],
    started_at: STARTED_AT,
    status: 'completed',
    'current-wave': 3,
    'total-waves': 3,
    session: SEMANTIC,
  };

  /** The exact stub `backfillAbandonedSession` writes for this identity. */
  function abandonedStub() {
    return {
      session_id: SEMANTIC,
      session_type: 'deep',
      started_at: STARTED_AT,
      completed_at: '2026-05-27T15:00:00.000Z',
      total_waves: 0,
      waves: [],
      agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
      total_agents: 0,
      total_files_changed: 0,
      status: 'abandoned',
      effectiveness: { carryover: null },
      _backfill_source: 'events-jsonl',
      _backfill_incomplete_fields: ['total_waves', 'waves', 'agent_summary', 'total_agents', 'total_files_changed'],
    };
  }

  // TV-001 — the bug: before #1068 the dedupe was unconditional, so the FIRST
  // record for an identity was canonical forever. A session whose SessionEnd
  // hook reconstructed an `abandoned` stub could never be corrected by the
  // later authoritative `status: completed` proof, and every downstream
  // consumer kept reading the stub's zeroes as the session's outcome.
  it('appends the completed record for an identity whose only entry is an abandoned stub', async () => {
    writeStateMd(COMPLETED_FRONTMATTER);
    seedSessions([abandonedStub()]);
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: SEMANTIC,
        mode: 'deep',
      },
      { timestamp: '2026-05-27T17:00:00.000Z', event: 'orchestrator.session.ended', session_id: UUID, reason: 'clear' },
    ]);

    const res = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(res.action).toBe('superseded');
    expect(res.supersedes).toBe(SEMANTIC);

    const recorded = readSessions();
    expect(recorded).toHaveLength(2);
    // AC4 — the stub survives VERBATIM: append-only, provenance preserved.
    expect(recorded[0]).toEqual(abandonedStub());
    // The newest record is the canonical one, and it names what it replaces.
    expect(recorded[1].status).toBe('completed');
    expect(recorded[1].supersedes).toBe(SEMANTIC);
    expect(recorded[1]._backfill_source).toBe('state-md-completed');
    expect(() => validateSession(recorded[1])).not.toThrow();
  });

  // TV-001 — the bug this second test catches is the one the fix itself could
  // introduce: a supersede that keeps firing. The record appended above is a
  // backfill too, so a predicate keyed on `_backfill_source` alone re-classifies
  // it as a stub on the next run. Measured with exactly that mutation: the
  // second run returns `skipped-marker-exists`, i.e. the only thing left
  // standing between a mis-classification and an unbounded supersede chain is
  // the TOCTOU marker FILE — a `.orchestrator/metrics/` artifact any cleanup
  // sweep may remove. The status half of the predicate is what makes the
  // termination a property of the data instead of the filesystem.
  it('does not supersede again once the stub has been superseded (no unbounded chain)', async () => {
    writeStateMd(COMPLETED_FRONTMATTER);
    seedSessions([abandonedStub()]);
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    ]);

    const first = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });
    expect(first.action).toBe('superseded');
    expect(readSessions()).toHaveLength(2);

    const second = await backfillCompletedFromStateMd({ repoRoot, now: NOW_MS, deps: stateMdDeps() });

    expect(second.action).toBe('skipped-already-recorded');
    expect(second.sessionId).toBe(SEMANTIC);
    expect(readSessions()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// #1091 follow-up — ONE UUID contract (isUuid delegates to parseSessionId)
// ---------------------------------------------------------------------------

describe('isUuid — one UUID contract with scripts/lib/session-id.mjs (#1091)', () => {
  // A 36-char lookalike with the right layout but an RFC-9562-INVALID variant
  // nibble (`c`, i.e. not one of 8/9/a/b). The module's former private regex
  // constrained neither version nor variant and accepted it; the writer in
  // hooks/on-session-start.mjs never did.
  const VARIANT_C_LOOKALIKE = '11111111-2222-4333-c444-555555555555';

  it('rejects a lookalike whose variant nibble is `c`', () => {
    expect(isUuid(VARIANT_C_LOOKALIKE)).toBe(false);
    // Control: the same string with a valid variant nibble IS accepted, so the
    // assertion above pins the variant check and not the whole layout.
    expect(isUuid('11111111-2222-4333-8444-555555555555')).toBe(true);
  });

  // TV-001 — the observable consequence, not just the predicate: a rejected
  // lookalike takes the SEMANTIC branch (the id keys the record directly)
  // instead of the UUID branch (lock-bridge lookup, then a synthetic
  // `<branch>-<date>-abandoned-<sha8>` mint). The two produce different
  // sessions.jsonl keys for the same input, which is exactly the class of
  // divergence a second UUID regex creates.
  it('routes a variant-`c` id down the semantic branch, keying the record by the id itself', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
    ]);

    const res = await backfillAbandonedSession({ repoRoot, sessionId: VARIANT_C_LOOKALIKE, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    expect(res.sessionId).toBe(VARIANT_C_LOOKALIKE);
    expect(res.record._synthetic_session_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #1167 — session.ended is the SECOND semantic bridge
//
// THE DUPLICATE-STUB BUG: a session that LOST the lock-acquire race emits no
// `lock.acquired`, so the only bridge this module read resolved null and the
// synthetic-id mint fired — writing a SECOND `abandoned` stub beside the one
// the SessionEnd hook had already written under the real semantic id. Measured
// 2026-09-02 @ c3ab480: 8 such pairs in the live ledger (16 records), each with
// millisecond-identical started_at + completed_at and no shared key.
// ---------------------------------------------------------------------------

describe('backfillAbandonedSession — semantic bridge via session.ended (#1167)', () => {
  it('adopts semantic_session_id from session.ended when NO lock.acquired exists (no synthetic mint)', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T17:00:00.000Z',
        event: 'orchestrator.session.ended',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-3',
        reason: 'other',
      },
    ]);

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.action).toBe('backfilled');
    expect(res.sessionId).toBe('main-2026-05-27-session-3');

    const recorded = readSessions();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].session_id).toBe('main-2026-05-27-session-3');
    // The synthetic mint must NOT have fired — that flag IS the duplicate class.
    expect(recorded[0]._synthetic_session_id).toBeUndefined();
    expect(recorded[0].session_id).not.toMatch(/-abandoned-[0-9a-f]{8}$/);
    // The raw uuid is stamped so a reader can join this record back to events.
    expect(recorded[0].raw_session_id).toBe(UUID);
    expect(() => validateSession(recorded[0])).not.toThrow();
  });

  it('keeps lock.acquired as the winning bridge when both events attest an id', async () => {
    seedEvents([
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-05-27T14:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-1',
        mode: 'deep',
      },
      {
        timestamp: '2026-05-27T17:00:00.000Z',
        event: 'orchestrator.session.ended',
        session_id: UUID,
        semantic_session_id: 'main-2026-05-27-session-9',
      },
    ]);

    const res = await backfillAbandonedSession({ repoRoot, sessionId: UUID, now: NOW_MS });

    expect(res.sessionId).toBe('main-2026-05-27-session-1');
  });
});
