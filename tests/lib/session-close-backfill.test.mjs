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

import { backfillAbandonedSession, isUuid } from '@lib/session-close-backfill.mjs';
import { validateSession } from '@lib/session-schema/validator.mjs';

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
