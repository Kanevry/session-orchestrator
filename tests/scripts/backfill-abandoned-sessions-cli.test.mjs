/**
 * tests/scripts/backfill-abandoned-sessions-cli.test.mjs
 *
 * Vitest suite for scripts/backfill-abandoned-sessions.mjs — the one-time
 * historical migration CLI (#724 C1). Drives the REAL CLI subprocess against
 * an isolated tmp repo-root and asserts on the JSON summary, the on-disk
 * sessions.jsonl, exit codes, and the load-bearing idempotency contract.
 *
 * Testing-rule compliance (testing.md):
 *   - Behaviour over implementation: assertions target the summary + on-disk
 *     records + process exit codes, never internal call shapes.
 *   - Hardcoded expected values (counts, modes, statuses).
 *   - Real fixtures in tmp — NEVER the live .orchestrator store.
 *   - Error path (bad-arg) proves the exit-code contract from cli-design.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSession } from '@lib/session-schema/validator.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'backfill-abandoned-sessions.mjs');

const UUID_1 = '11111111-2222-4333-8444-555555555555';
const UUID_2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SEM_1 = 'main-2026-07-02-session-1';
const SEM_2 = 'main-2026-07-02-session-2';
const STARTED_AT = '2026-07-02T09:00:00.000Z';

let tmp;

/** Two started+lock-acquired sessions with NO sessions.jsonl records. */
const TWO_ABANDONED_EVENTS = [
  { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID_1, branch: 'main', project: 'demo' },
  {
    timestamp: '2026-07-02T09:01:00.000Z',
    event: 'orchestrator.session.lock.acquired',
    session_id: UUID_1,
    semantic_session_id: SEM_1,
    mode: 'deep',
  },
  { timestamp: '2026-07-02T11:00:00.000Z', event: 'orchestrator.session.started', session_id: UUID_2, branch: 'main' },
  {
    timestamp: '2026-07-02T11:01:00.000Z',
    event: 'orchestrator.session.lock.acquired',
    session_id: UUID_2,
    semantic_session_id: SEM_2,
    mode: 'feature',
  },
];

// Fixed far-in-the-past fixture (#731 dead-by-age tests) — deliberately dated
// well before ANY plausible test-run wall-clock, so "older than the 4h TTL"
// holds regardless of when CI actually executes this suite (no reliance on
// the fixture being "yesterday" relative to a moving `now`).
const UUID_OLD_1 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const UUID_OLD_2 = 'cccccccc-dddd-4eee-8fff-000000000000';
const SEM_OLD_1 = 'main-2026-01-01-session-1';
const SEM_OLD_2 = 'main-2026-01-01-session-2';
const OLD_STARTED_AT = '2026-01-01T09:00:00.000Z';

const TWO_OLD_ABANDONED_EVENTS = [
  { timestamp: OLD_STARTED_AT, event: 'orchestrator.session.started', session_id: UUID_OLD_1, branch: 'main', project: 'demo' },
  {
    timestamp: '2026-01-01T09:01:00.000Z',
    event: 'orchestrator.session.lock.acquired',
    session_id: UUID_OLD_1,
    semantic_session_id: SEM_OLD_1,
    mode: 'deep',
  },
  { timestamp: '2026-01-01T11:00:00.000Z', event: 'orchestrator.session.started', session_id: UUID_OLD_2, branch: 'main' },
  {
    timestamp: '2026-01-01T11:01:00.000Z',
    event: 'orchestrator.session.lock.acquired',
    session_id: UUID_OLD_2,
    semantic_session_id: SEM_OLD_2,
    mode: 'feature',
  },
];

function metricsFile(name) {
  return join(tmp, '.orchestrator', 'metrics', name);
}

/**
 * Seed a LIVE foreign `.orchestrator/session.lock` — reproduces the
 * structural self-block (#731): every real CLI run happens FROM an active
 * session, so the current lock is always fresh at run-time regardless of how
 * old the historical candidates are.
 */
function seedLiveForeignLock() {
  mkdirSync(join(tmp, '.orchestrator'), { recursive: true });
  writeFileSync(
    join(tmp, '.orchestrator', 'session.lock'),
    JSON.stringify(
      {
        session_id: 'foreign-uuid-live',
        started_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
        mode: 'deep',
        pid: 999999,
        host: 'some-other-host',
        ttl_hours: 4,
        semantic_session_id: 'foreign-sem-live',
      },
      null,
      2
    ) + '\n'
  );
}

function seedEvents(records) {
  mkdirSync(join(tmp, '.orchestrator', 'metrics'), { recursive: true });
  writeFileSync(metricsFile('events.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function readSessions() {
  const file = metricsFile('sessions.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Parse the single-line JSON summary emitted with --json. */
function summaryOf(r) {
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'backfill-abandoned-cli-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) dry-run is the default — counts candidates, writes NOTHING
// ---------------------------------------------------------------------------

describe('backfill-abandoned-sessions CLI — dry-run (default)', () => {
  it('counts the abandoned candidates and writes no sessions.jsonl', () => {
    seedEvents(TWO_ABANDONED_EVENTS);

    const r = runCli(['--repo-root', tmp, '--json']);

    expect(r.status).toBe(0);
    const summary = summaryOf(r);
    expect(summary.mode).toBe('dry-run');
    expect(summary.total).toBe(2);
    expect(summary.would_backfill).toBe(2);
    expect(summary.backfilled).toBe(0);
    // Nothing written on disk.
    expect(existsSync(metricsFile('sessions.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) --apply writes N validated stubs
// ---------------------------------------------------------------------------

describe('backfill-abandoned-sessions CLI — --apply', () => {
  it('appends one validated status:abandoned stub per candidate', () => {
    seedEvents(TWO_ABANDONED_EVENTS);

    const r = runCli(['--repo-root', tmp, '--apply', '--json']);

    expect(r.status).toBe(0);
    const summary = summaryOf(r);
    expect(summary.mode).toBe('apply');
    expect(summary.backfilled).toBe(2);
    expect(summary.errors).toBe(0);

    const records = readSessions();
    expect(records).toHaveLength(2);
    const ids = records.map((rec) => rec.session_id).sort();
    expect(ids).toEqual([SEM_1, SEM_2]);
    for (const rec of records) {
      expect(rec.status).toBe('abandoned');
      // Every written stub must itself re-validate (round-trip contract).
      expect(() => validateSession(rec)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) idempotency — a second --apply writes nothing new
// ---------------------------------------------------------------------------

describe('backfill-abandoned-sessions CLI — idempotency', () => {
  it('re-running --apply performs 0 new writes (dedupe against recorded ids)', () => {
    seedEvents(TWO_ABANDONED_EVENTS);

    const first = runCli(['--repo-root', tmp, '--apply', '--json']);
    expect(first.status).toBe(0);
    expect(summaryOf(first).backfilled).toBe(2);
    expect(readSessions()).toHaveLength(2);

    const second = runCli(['--repo-root', tmp, '--apply', '--json']);
    expect(second.status).toBe(0);
    const summary = summaryOf(second);
    // Load-bearing contract: stable semantic ids are already recorded → skipped.
    expect(summary.backfilled).toBe(0);
    expect(summary.skipped['skipped-already-recorded']).toBe(2);
    // The store is unchanged — no duplicate abandoned stubs.
    expect(readSessions()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (e) dead-by-age relaxation past a LIVE foreign session.lock (#731)
// ---------------------------------------------------------------------------

describe('backfill-abandoned-sessions CLI — dead-by-age relaxation past a LIVE foreign lock (#731)', () => {
  it('reproduces + fixes the structural self-block: a LIVE foreign lock no longer blocks stale-by-age candidates (dry-run default)', () => {
    seedEvents(TWO_OLD_ABANDONED_EVENTS);
    seedLiveForeignLock();

    const r = runCli(['--repo-root', tmp, '--json']);

    expect(r.status).toBe(0);
    const summary = summaryOf(r);
    expect(summary.mode).toBe('dry-run');
    expect(summary.total).toBe(2);
    expect(summary.would_backfill).toBe(2);
    expect(summary.dead_by_age).toBe(2);
    expect(summary.skipped['skipped-foreign-live-lock']).toBeUndefined();
    // Nothing written on disk — dry-run never mutates.
    expect(existsSync(metricsFile('sessions.jsonl'))).toBe(false);
  });

  it('--apply writes the relaxed stubs to sessions.jsonl despite the live foreign lock', () => {
    seedEvents(TWO_OLD_ABANDONED_EVENTS);
    seedLiveForeignLock();

    const r = runCli(['--repo-root', tmp, '--apply', '--json']);

    expect(r.status).toBe(0);
    const summary = summaryOf(r);
    expect(summary.mode).toBe('apply');
    expect(summary.backfilled).toBe(2);
    expect(summary.dead_by_age).toBe(2);
    expect(summary.errors).toBe(0);

    const records = readSessions();
    expect(records.map((rec) => rec.session_id).sort()).toEqual([SEM_OLD_1, SEM_OLD_2]);
  });

  it('--assume-dead-before <ISO> also bypasses the live foreign lock for a candidate whose last event predates the cutoff', () => {
    seedEvents(TWO_OLD_ABANDONED_EVENTS);
    seedLiveForeignLock();

    const r = runCli(['--repo-root', tmp, '--json', '--assume-dead-before', '2026-01-02T00:00:00.000Z']);

    expect(r.status).toBe(0);
    const summary = summaryOf(r);
    expect(summary.would_backfill).toBe(2);
    expect(summary.dead_by_age).toBe(2);
  });

  it('running --apply twice with the live foreign lock still present performs 0 new writes (idempotent)', () => {
    seedEvents(TWO_OLD_ABANDONED_EVENTS);
    seedLiveForeignLock();

    const first = runCli(['--repo-root', tmp, '--apply', '--json']);
    expect(first.status).toBe(0);
    expect(summaryOf(first).backfilled).toBe(2);
    expect(readSessions()).toHaveLength(2);

    const second = runCli(['--repo-root', tmp, '--apply', '--json']);
    expect(second.status).toBe(0);
    const summary = summaryOf(second);
    expect(summary.backfilled).toBe(0);
    expect(summary.skipped['skipped-already-recorded']).toBe(2);
    expect(readSessions()).toHaveLength(2);
  });

  it('exits 1 on an invalid --assume-dead-before value', () => {
    const r = runCli(['--repo-root', tmp, '--assume-dead-before', 'not-a-real-date']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/assume-dead-before/i);
  });
});

// ---------------------------------------------------------------------------
// (f) SessionStart entry point (#926) — backfill decoupled from /close
//
// Bugs these pin (TV-001), none of which the pre-#926 suite could catch:
//   - a RUNNING session (ours or a foreign one) recorded as 'abandoned'
//   - duplicate stubs when the backfill runs on EVERY session start
//   - the latency cap spending its budget on ancient already-recorded
//     candidates and never reaching the recent abandoned ones
//   - a backfill failure propagating into (and thus blocking) session start
// ---------------------------------------------------------------------------

/** Seed a LIVE lock OWNED BY one of the candidates in events.jsonl. */
function seedLiveLockFor({ sessionId, semanticSessionId }) {
  mkdirSync(join(tmp, '.orchestrator'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(tmp, '.orchestrator', 'session.lock'),
    JSON.stringify(
      { session_id: sessionId, started_at: now, last_heartbeat: now, mode: 'deep', pid: 999999, host: 'h', ttl_hours: 4, semantic_session_id: semanticSessionId },
      null,
      2
    ) + '\n'
  );
}

describe('backfillOnSessionStart (#926) — liveness protection', () => {
  it('never records a candidate that HOLDS a live lock, even when it is stale enough for the dead-by-age relaxation', async () => {
    // The candidate's events are from 2026-01-01 (far past the 4h lock TTL), so
    // relaxDeadByAge WOULD bypass a foreign live lock. It must not bypass the
    // candidate's OWN live lock — that session is running right now.
    seedEvents(TWO_OLD_ABANDONED_EVENTS);
    seedLiveLockFor({ sessionId: UUID_OLD_2, semanticSessionId: SEM_OLD_2 });

    const { backfillOnSessionStart } = await import('../../scripts/backfill-abandoned-sessions.mjs');
    const summary = await backfillOnSessionStart({ repoRoot: tmp });

    expect(summary.skipped['skipped-own-live-lock']).toBe(1);
    // The genuinely-dead sibling is still recovered — this is a liveness gate,
    // not a blanket off-switch.
    expect(summary.backfilled).toBe(1);
    expect(readSessions().map((r) => r.session_id)).toEqual([SEM_OLD_1]);
  });

  it('never records a RECENT foreign session whose lock is live (no relaxation applies)', async () => {
    // Recent events (now-ish) + a live foreign lock → the dead-by-age
    // relaxation must NOT fire, so every candidate is blocked.
    const nowIso = new Date().toISOString();
    seedEvents([
      { timestamp: nowIso, event: 'orchestrator.session.started', session_id: UUID_1, branch: 'main' },
      { timestamp: nowIso, event: 'orchestrator.session.lock.acquired', session_id: UUID_1, semantic_session_id: SEM_1, mode: 'deep' },
    ]);
    seedLiveForeignLock();

    const { backfillOnSessionStart } = await import('../../scripts/backfill-abandoned-sessions.mjs');
    const summary = await backfillOnSessionStart({ repoRoot: tmp });

    expect(summary.backfilled).toBe(0);
    expect(summary.skipped['skipped-foreign-live-lock']).toBe(1);
    expect(existsSync(metricsFile('sessions.jsonl'))).toBe(false);
  });
});

describe('backfillOnSessionStart (#926) — idempotency across repeated starts', () => {
  it('writes the stubs once; a second and third start write nothing new', async () => {
    seedEvents(TWO_ABANDONED_EVENTS);
    const { backfillOnSessionStart } = await import('../../scripts/backfill-abandoned-sessions.mjs');

    const first = await backfillOnSessionStart({ repoRoot: tmp });
    expect(first.backfilled).toBe(2);
    expect(readSessions()).toHaveLength(2);

    const second = await backfillOnSessionStart({ repoRoot: tmp });
    expect(second.backfilled).toBe(0);
    expect(readSessions()).toHaveLength(2);

    const third = await backfillOnSessionStart({ repoRoot: tmp });
    expect(third.backfilled).toBe(0);
    expect(readSessions()).toHaveLength(2);
  });
});

describe('backfillOnSessionStart (#926) — latency cap spends its budget on the NEWEST candidates', () => {
  it('reaches a recent abandoned candidate even when many older recorded ones precede it', async () => {
    // REGRESSION GUARD for a defect measured against a copy of the live store:
    // bare-UUID candidates (no lock.acquired bridge) cannot be pre-filtered, so
    // each spends a core call only to be told "already recorded". Walking the
    // plan in first-seen order burned the entire budget on them and backfilled
    // NOTHING. Walking newest-first fixes it.
    const events = [];
    // Six OLD candidates that are deliberately UN-pre-filterable: bare UUIDs
    // with NO lock.acquired bridge, so their record id is only derivable from
    // events and each one costs a full core call.
    for (let i = 0; i < 6; i += 1) {
      const uuid = `dddddddd-0000-4000-8000-00000000000${i}`;
      events.push({ timestamp: `2026-02-0${i + 1}T09:00:00.000Z`, event: 'orchestrator.session.started', session_id: uuid, branch: 'main' });
    }
    // The NEWEST candidate is the one that matters — it has a semantic id.
    events.push({ timestamp: '2026-03-01T09:00:00.000Z', event: 'orchestrator.session.started', session_id: UUID_1, branch: 'main' });
    events.push({ timestamp: '2026-03-01T09:01:00.000Z', event: 'orchestrator.session.lock.acquired', session_id: UUID_1, semantic_session_id: SEM_1, mode: 'deep' });
    seedEvents(events);

    const { backfillOnSessionStart } = await import('../../scripts/backfill-abandoned-sessions.mjs');
    const summary = await backfillOnSessionStart({ repoRoot: tmp, limit: 1 });

    // With a budget of exactly ONE core call, only newest-first ordering can
    // reach SEM_1. First-seen order spends it on the oldest bare-UUID candidate
    // and never gets here (verified by fake-regression: flipping newestFirst to
    // false turns this assertion RED).
    expect(summary.backfilled).toBe(1);
    expect(readSessions().map((r) => r.session_id)).toEqual([SEM_1]);
  });
});

describe('backfillOnSessionStart (#926) — never throws', () => {
  it('returns a result instead of throwing when the events store is unreadable', async () => {
    mkdirSync(metricsFile('events.jsonl'), { recursive: true }); // EISDIR on read
    const { backfillOnSessionStart } = await import('../../scripts/backfill-abandoned-sessions.mjs');

    await expect(backfillOnSessionStart({ repoRoot: tmp })).resolves.toBeDefined();
  });

  it('returns null (writes nothing) when SO_DISABLE_STARTUP_BACKFILL=1', async () => {
    seedEvents(TWO_ABANDONED_EVENTS);
    const { backfillOnSessionStart } = await import('../../scripts/backfill-abandoned-sessions.mjs');

    process.env.SO_DISABLE_STARTUP_BACKFILL = '1';
    try {
      const summary = await backfillOnSessionStart({ repoRoot: tmp });
      expect(summary).toBeNull();
      expect(existsSync(metricsFile('sessions.jsonl'))).toBe(false);
    } finally {
      delete process.env.SO_DISABLE_STARTUP_BACKFILL;
    }
  });
});

// ---------------------------------------------------------------------------
// (d) exit codes — bad-arg (1) and unreadable/absent store (graceful 0)
// ---------------------------------------------------------------------------

describe('backfill-abandoned-sessions CLI — exit codes', () => {
  it('exits 1 on an unknown flag (user/input error)', () => {
    const r = runCli(['--not-a-real-flag']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown option/);
  });

  it('degrades gracefully (exit 0, zero candidates) when the events store is unreadable', () => {
    // events.jsonl seeded as a DIRECTORY → readFileSync would EISDIR; the CLI's
    // readJsonl swallows fs errors by design (never a partial-migration crash),
    // so an unreadable store yields an empty plan rather than a system error.
    mkdirSync(metricsFile('events.jsonl'), { recursive: true });

    const r = runCli(['--repo-root', tmp, '--json']);

    expect(r.status).toBe(0);
    const summary = summaryOf(r);
    expect(summary.total).toBe(0);
    expect(summary.would_backfill).toBe(0);
    expect(existsSync(metricsFile('sessions.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) #1167 — the second semantic bridge, the raw-uuid join, and the event
//
// Root cause of the 8 duplicate stub pairs measured in the live ledger
// (2026-09-02 @ c3ab480): this CLI resolved UUID -> semantic ONLY via
// lock.acquired, so a session that lost the lock-acquire race minted a
// SYNTHETIC id and wrote a second stub for a session already recorded under
// its real semantic id.
// ---------------------------------------------------------------------------

const UUID_ENDED_ONLY = 'dddddddd-eeee-4fff-8000-111111111111';
const SEM_ENDED_ONLY = 'main-2026-07-02-session-7';

/** A session with NO lock.acquired — only a session.ended carrying the semantic id. */
const ENDED_BRIDGE_EVENTS = [
  {
    timestamp: STARTED_AT,
    event: 'orchestrator.session.started',
    session_id: UUID_ENDED_ONLY,
    branch: 'main',
  },
  {
    timestamp: '2026-07-02T10:30:00.000Z',
    event: 'orchestrator.session.ended',
    session_id: UUID_ENDED_ONLY,
    semantic_session_id: SEM_ENDED_ONLY,
    reason: 'other',
  },
];

describe('backfill-abandoned-sessions — #1167 duplicate-stub root cause', () => {
  it('planSessions resolves the semantic id from session.ended when no lock.acquired exists', async () => {
    seedEvents(ENDED_BRIDGE_EVENTS);
    const { planSessions } = await import('../../scripts/backfill-abandoned-sessions.mjs');

    expect(planSessions({ repoRoot: tmp })).toEqual([
      { sessionId: UUID_ENDED_ONLY, semanticSessionId: SEM_ENDED_ONLY },
    ]);
  });

  it('writes a semantically-keyed record instead of a synthetic duplicate stub', () => {
    seedEvents(ENDED_BRIDGE_EVENTS);

    const r = runCli(['--repo-root', tmp, '--apply', '--json']);

    expect(r.status).toBe(0);
    const records = readSessions();
    expect(records.map((x) => x.session_id)).toEqual([SEM_ENDED_ONLY]);
    expect(records[0]._synthetic_session_id).toBeUndefined();
    expect(records[0].raw_session_id).toBe(UUID_ENDED_ONLY);
    expect(() => validateSession(records[0])).not.toThrow();
  });

  it('skips a candidate whose ONLY id is the uuid when a record carries it as raw_session_id', () => {
    // The join that was structurally impossible before: the record is keyed
    // semantically, the candidate is a bare uuid with no bridge at all — and
    // without raw_session_id the run would mint a synthetic SECOND stub.
    seedEvents([
      {
        timestamp: STARTED_AT,
        event: 'orchestrator.session.started',
        session_id: UUID_1,
        branch: 'main',
      },
    ]);
    mkdirSync(join(tmp, '.orchestrator', 'metrics'), { recursive: true });
    writeFileSync(
      metricsFile('sessions.jsonl'),
      JSON.stringify({
        session_id: SEM_1,
        session_type: 'deep',
        started_at: STARTED_AT,
        completed_at: '2026-07-02T10:00:00.000Z',
        total_waves: 0,
        waves: [],
        agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
        total_agents: 0,
        total_files_changed: 0,
        status: 'abandoned',
        raw_session_id: UUID_1,
      }) + '\n',
      'utf8'
    );

    const r = runCli(['--repo-root', tmp, '--apply', '--json']);

    expect(r.status).toBe(0);
    expect(summaryOf(r).skipped['skipped-already-recorded']).toBe(1);
    expect(readSessions()).toHaveLength(1);
  });

  it('emits one orchestrator.session.backfill_completed event per written record', () => {
    seedEvents(ENDED_BRIDGE_EVENTS);

    const r = runCli(['--repo-root', tmp, '--apply', '--json']);
    expect(r.status).toBe(0);

    const emitted = readFileSync(metricsFile('events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === 'orchestrator.session.backfill_completed');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('abandoned');
    expect(emitted[0].action).toBe('backfilled');
    expect(emitted[0].session_id).toBe(UUID_ENDED_ONLY);
    expect(emitted[0].record_id).toBe(SEM_ENDED_ONLY);
  });

  it('emits NO backfill_completed event on a dry-run (nothing was written)', () => {
    seedEvents(ENDED_BRIDGE_EVENTS);

    runCli(['--repo-root', tmp, '--json']);

    const raw = readFileSync(metricsFile('events.jsonl'), 'utf8');
    expect(raw).not.toContain('backfill_completed');
  });
});
