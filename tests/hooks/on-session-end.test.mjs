/**
 * tests/hooks/on-session-end.test.mjs
 *
 * Tests for hooks/on-session-end.mjs — SessionEnd hook emitting
 * `orchestrator.session.ended` (Track A, issue #609 / epic #608).
 *
 * Strategy: spawn `node hooks/on-session-end.mjs` with controlled stdin +
 * CLAUDE_PROJECT_DIR, then read the written events.jsonl to verify record shape.
 * Each test gets an isolated tmp project dir so parallel runs cannot interfere.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { permsEnforced } from '../_helpers/perms.mjs';
import { telemetryIsolationEnv } from '../_helpers/telemetry-isolation.mjs';

const HOOK = path.resolve(import.meta.dirname, '../../hooks/on-session-end.mjs');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');
const LOCK_REL = path.join('.orchestrator', 'session.lock');
const PROOF_REL = path.join('.orchestrator', 'runtime', 'lock-owner-proof.json');

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-session-end-'));
  tmpDirs.push(dir);
  return dir;
}

/** Seed .orchestrator/current-session.json (as on-session-start.mjs writes it). */
async function seedCurrentSession(projectDir, { sessionId, timestamp, semanticSessionId }) {
  const dir = path.join(projectDir, '.orchestrator');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'current-session.json'),
    JSON.stringify({
      session_id: sessionId,
      timestamp,
      ...(semanticSessionId ? { semantic_session_id: semanticSessionId } : {}),
    }),
  );
}

/** Seed a v2 session.lock file. */
async function seedLock(projectDir, { sessionId, semanticSessionId, lastHeartbeat }) {
  const dir = path.join(projectDir, '.orchestrator');
  await fs.mkdir(dir, { recursive: true });
  const lock = {
    session_id: sessionId,
    started_at: new Date(Date.now() - 3600_000).toISOString(),
    last_heartbeat: lastHeartbeat ?? new Date().toISOString(),
    mode: 'deep',
    pid: 999999,
    host: os.hostname(),
    ttl_hours: 4,
    ...(semanticSessionId ? { semantic_session_id: semanticSessionId } : {}),
  };
  await fs.writeFile(path.join(dir, 'session.lock'), JSON.stringify(lock, null, 2) + '\n');
}

/**
 * Seed .orchestrator/runtime/lock-owner-proof.json derived from the CURRENT
 * on-disk lock (#987) — mirrors writeOwnerProof()'s envelope shape exactly
 * (golden-record discipline: same field set + ordering as the producer).
 * `startedAtOffsetMs` shifts the proof's startedAt to fabricate a
 * foreign-collision mismatch while keeping pid/host identical.
 */
async function seedOwnerProofFromLock(projectDir, { startedAtOffsetMs = 0 } = {}) {
  const lock = JSON.parse(await fs.readFile(path.join(projectDir, LOCK_REL), 'utf8'));
  const proofPath = path.join(projectDir, PROOF_REL);
  await fs.mkdir(path.dirname(proofPath), { recursive: true });
  const startedAt = startedAtOffsetMs === 0
    ? lock.started_at
    : new Date(Date.parse(lock.started_at) + startedAtOffsetMs).toISOString();
  await fs.writeFile(
    proofPath,
    JSON.stringify({
      schema_version: 1,
      proof: { pid: lock.pid, host: lock.host, startedAt },
      lock_session_id: lock.session_id,
      semantic_session_id: lock.semantic_session_id ?? null,
      repo_root: projectDir,
      written_at: new Date().toISOString(),
    }, null, 2) + '\n',
  );
}

async function lockExists(projectDir) {
  try {
    await fs.access(path.join(projectDir, LOCK_REL));
    return true;
  } catch {
    return false;
  }
}

/** Write the given records to a JSONL file under .orchestrator/metrics/. */
async function writeMetricsJsonl(projectDir, relName, records) {
  const dir = path.join(projectDir, '.orchestrator', 'metrics');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, relName),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

const seedEvents = (projectDir, records) => writeMetricsJsonl(projectDir, 'events.jsonl', records);
const seedSessions = (projectDir, records) => writeMetricsJsonl(projectDir, 'sessions.jsonl', records);

/** Read + parse sessions.jsonl; missing file → []. */
async function readSessions(projectDir) {
  try {
    const raw = await fs.readFile(
      path.join(projectDir, '.orchestrator', 'metrics', 'sessions.jsonl'),
      'utf8',
    );
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function runHook({ projectDir, stdin = '', env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
        // #1138 — the hook now calls flush() on EVERY run, so a spawn helper
        // that merely inherits process.env turns each of the ~35 tests below
        // into a real telemetry sender against the developer's own consent
        // record. Measured 2026-08-23 before this line existed: one suite run
        // stamped `last_flush_at` on the operator's real
        // ~/.config/session-orchestrator/telemetry.json — i.e. a production
        // send — and rewrote their 50-entry offline queue. Fail-closed by
        // default; the flush tests override it deliberately via `env`.
        ...telemetryIsolationEnv(),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/**
 * The last `orchestrator.session.ended` record in events.jsonl.
 *
 * Selected BY EVENT NAME rather than by file position: since #1138 the hook
 * appends a terminal `orchestrator.telemetry.flush` breadcrumb after the
 * lifecycle event, so "last line" and "the session.ended record" are no longer
 * the same row. No production consumer depends on physical position either —
 * `scripts/lib/session-close-backfill.mjs` matches on `ev.event` (:165).
 */
async function readLastEvent(projectDir) {
  const ended = (await readAllEvents(projectDir))
    .filter((e) => e.event === 'orchestrator.session.ended');
  return ended[ended.length - 1];
}

/** Read + parse EVERY record in events.jsonl; missing file → []. */
async function readAllEvents(projectDir) {
  try {
    const content = await fs.readFile(path.join(projectDir, EVENTS_REL), 'utf8');
    return content.trim().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('on-session-end.mjs — SessionEnd event', { timeout: 15000 }, () => {
  // NOTE: no standalone "exits 0" test — hooks/on-session-end.mjs wires
  // `main().catch(() => {}).finally(() => process.exit(0))`, so the exit code
  // is unconditionally 0 by contract regardless of internal success/failure.
  // A test asserting only `result.code === 0` cannot fail no matter what bug
  // is introduced (falsification check: 0/0). Every remaining
  // `expect(result.code).toBe(0)` below is stripped for the same reason —
  // the side-effect assertion beside it is the real falsifier and stays.

  it('writes event="orchestrator.session.ended" to events.jsonl', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-1', reason: 'clear' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
  });

  it('records reason from stdin', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-1', reason: 'logout' }),
    });
    const record = await readLastEvent(dir);
    expect(record.reason).toBe('logout');
  });

  it('defaults reason to "other" when stdin omits it', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-1' }),
    });
    const record = await readLastEvent(dir);
    expect(record.reason).toBe('other');
  });

  it('records session_id from stdin', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-explicit' }),
    });
    const record = await readLastEvent(dir);
    expect(record.session_id).toBe('sess-explicit');
  });

  it('falls back to current-session.json session_id when stdin omits it', async () => {
    const dir = await mkProject();
    await seedCurrentSession(dir, { sessionId: 'recorded-1', timestamp: new Date(Date.now() - 5000).toISOString() });
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'exit' }),
    });
    const record = await readLastEvent(dir);
    expect(record.session_id).toBe('recorded-1');
  });

  it('computes duration_ms when the ending session is the recorded one', async () => {
    const dir = await mkProject();
    await seedCurrentSession(dir, { sessionId: 'sess-dur', timestamp: new Date(Date.now() - 5000).toISOString() });
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-dur' }),
    });
    const record = await readLastEvent(dir);
    expect(record.duration_ms).toBeGreaterThanOrEqual(4000);
    expect(record.duration_ms).toBeLessThan(60000);
  });

  it('duration_ms is 0 when ending session differs from recorded session', async () => {
    const dir = await mkProject();
    await seedCurrentSession(dir, { sessionId: 'OTHER', timestamp: new Date(Date.now() - 5000).toISOString() });
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-mismatch' }),
    });
    const record = await readLastEvent(dir);
    expect(record.duration_ms).toBe(0);
  });

  it('duration_ms is 0 when no current-session.json exists', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-nofile' }),
    });
    const record = await readLastEvent(dir);
    expect(record.duration_ms).toBe(0);
  });

  it('exits 0 and writes a record even with empty stdin (graceful degradation)', async () => {
    const dir = await mkProject();
    await runHook({ projectDir: dir, stdin: '' });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
    expect(record.reason).toBe('other');
  });

  it('degrades to duration_ms 0 when current-session.json is malformed JSON', async () => {
    const dir = await mkProject();
    const od = path.join(dir, '.orchestrator');
    await fs.mkdir(od, { recursive: true });
    await fs.writeFile(path.join(od, 'current-session.json'), '{ not valid json');
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-x' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
    expect(record.session_id).toBe('sess-x');
    expect(record.duration_ms).toBe(0);
  });

  it('degrades to duration_ms 0 when recorded timestamp is a non-string', async () => {
    const dir = await mkProject();
    await seedCurrentSession(dir, { sessionId: 'sess-ts', timestamp: 123456 });
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-ts' }),
    });
    const record = await readLastEvent(dir);
    expect(record.duration_ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C1 (#724) — deterministic lock release
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — deterministic lock release (#724)', { timeout: 15000 }, () => {
  it('does NOT release a LIVE lock matched only by the SEMANTIC id (UUID rotated across clear)', async () => {
    const dir = await mkProject();
    // Lock recorded under an older UUID but the same semantic id — seedLock
    // defaults last_heartbeat to now, so this lock is LIVE.
    await seedLock(dir, { sessionId: 'old-uuid', semanticSessionId: 'sem-shared' });
    await seedCurrentSession(dir, {
      sessionId: 'new-uuid',
      timestamp: new Date().toISOString(),
      semanticSessionId: 'sem-shared',
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-uuid' }),
    });

    // The semantic session id is NOT unique — the same id was observed twice in
    // one day across two different sessions. A self-rotation (this test) and a
    // foreign collision (the next test) therefore produce an IDENTICAL signature
    // at session-end: UUID mismatch + semantic match on a live lock. The two
    // cannot be told apart without an ownership proof persisted at acquire time
    // (escalated per RCR-007 — that would be a storage change), so the release
    // path treats both conservatively and leaves the lock alone.
    //
    // Accepted cost, verified against hooks/_lib/lock-bootstrap.mjs shouldForce:
    // the orphaned lock stops being heartbeated, goes stale after ttl_hours, and
    // the next session force-acquires it via the stale-pid-* branch — which does
    // NOT require a session_id match. Self-healing, bounded by the TTL.
    expect(await lockExists(dir)).toBe(true);
  });

  it('preserves a FOREIGN live lock and still emits session.ended (backfill/release are best-effort)', async () => {
    const dir = await mkProject();
    await seedLock(dir, {
      sessionId: 'other',
      semanticSessionId: 'other-sem',
      lastHeartbeat: new Date().toISOString(),
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'mine', reason: 'logout' }),
    });

    expect(await lockExists(dir)).toBe(true);
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
    expect(record.reason).toBe('logout');
  });
});

// ---------------------------------------------------------------------------
// C1 (#724) — close-through backfill (full-hook integration)
//
// The RELEASE half is already covered end-to-end above; this exercises the
// BACKFILL half through the real hook subprocess (not the lib in isolation):
// an abandoned session with no sessions.jsonl record must gain exactly one
// status:'abandoned' stub keyed by its SEMANTIC id, and its own lock must be
// released. If the `backfillAbandonedSession(...)` call in on-session-end.mjs
// were removed/mis-wired, the first test fails RED (0 records instead of 1).
//
// #863 — the lock in this fixture MUST be genuinely STALE (heartbeat past
// the default TTL), not live. A live own lock at hook-time means the session
// is actively running RIGHT NOW — backfilling it as 'abandoned' is exactly
// the #863 defect (confirmed on-disk: main-2026-07-21-session-2 was recorded
// abandoned 2.9 seconds after it started). The lock is still deterministically
// released regardless of staleness — that half of the hook has no liveness
// gate for a UUID-matched own lock.
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — close-through backfill (#724)', { timeout: 15000 }, () => {
  const UUID = '11111111-2222-4333-8444-555555555555';
  const SEMANTIC = 'main-2026-07-02-session-1';
  const STARTED_AT = '2026-07-02T09:00:00.000Z';

  it('backfills exactly one abandoned record (semantic id) and releases the own lock', async () => {
    const dir = await mkProject();
    // Session started + lock acquired (UUID↔semantic bridge), but never /close.
    await seedEvents(dir, [
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main', project: 'demo' },
      {
        timestamp: '2026-07-02T09:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: SEMANTIC,
        mode: 'deep',
      },
    ]);
    // current-session.json supplies the semantic id the hook forwards to backfill.
    await seedCurrentSession(dir, {
      sessionId: UUID,
      timestamp: new Date().toISOString(),
      semanticSessionId: SEMANTIC,
    });
    // Own STALE lock (UUID match, heartbeat past the 4h default TTL) — a
    // genuinely abandoned session. Backfill proceeds (own-live-lock guard
    // does not fire since isLockLive() is false); release then clears it.
    await seedLock(dir, {
      sessionId: UUID,
      semanticSessionId: SEMANTIC,
      lastHeartbeat: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: UUID, reason: 'clear' }),
    });


    const records = await readSessions(dir);
    expect(records).toHaveLength(1);
    expect(records[0].session_id).toBe(SEMANTIC);
    expect(records[0].status).toBe('abandoned');
    expect(records[0].session_type).toBe('deep'); // mode from lock.acquired

    // The own lock is released by the release-half after backfill.
    expect(await lockExists(dir)).toBe(false);
  });

  it('does NOT append a second record when the session is already recorded', async () => {
    const dir = await mkProject();
    await seedEvents(dir, [
      { timestamp: STARTED_AT, event: 'orchestrator.session.started', session_id: UUID, branch: 'main' },
      {
        timestamp: '2026-07-02T09:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID,
        semantic_session_id: SEMANTIC,
        mode: 'deep',
      },
    ]);
    await seedCurrentSession(dir, {
      sessionId: UUID,
      timestamp: new Date().toISOString(),
      semanticSessionId: SEMANTIC,
    });
    // A real, complete record already exists for this semantic id.
    await seedSessions(dir, [
      {
        session_id: SEMANTIC,
        session_type: 'deep',
        started_at: STARTED_AT,
        completed_at: '2026-07-02T10:00:00.000Z',
        total_waves: 1,
        waves: [{ wave: 1, role: 'coordinator' }],
        agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
        total_agents: 1,
        total_files_changed: 2,
      },
    ]);

    const before = await readSessions(dir);
    expect(before).toHaveLength(1);

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: UUID, reason: 'clear' }),
    });

    // Dedupe short-circuits — the record count is unchanged (no abandoned stub).
    const after = await readSessions(dir);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBeUndefined(); // untouched original, not an abandoned stub
  });
});

// ---------------------------------------------------------------------------
// #731 — dead-by-age relaxation must NEVER leak into the hook path
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — dead-by-age relaxation does NOT leak into the hook (#731)', { timeout: 15000 }, () => {
  it('still returns skipped-foreign-live-lock for a stale-by-age abandoned candidate when a FOREIGN lock is fresh at hook-time', async () => {
    const dir = await mkProject();
    const UUID_STALE = '22222222-3333-4444-8555-666666666666';
    const SEM_STALE = 'main-2026-01-01-session-stale';
    // The candidate's last known event is many hours in the past — old enough
    // that the CLI migration's relaxDeadByAge WOULD bypass a live foreign
    // lock (#731), but the hook must NEVER apply that relaxation:
    // hooks/on-session-end.mjs calls backfillAbandonedSession() with no
    // relaxDeadByAge/assumeDeadBeforeMs, so a lock that is live at hook-time
    // stays a hard block regardless of how old the candidate is.
    await seedEvents(dir, [
      { timestamp: '2026-01-01T09:00:00.000Z', event: 'orchestrator.session.started', session_id: UUID_STALE, branch: 'main' },
      {
        timestamp: '2026-01-01T09:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID_STALE,
        semantic_session_id: SEM_STALE,
        mode: 'deep',
      },
    ]);
    // A DIFFERENT session's lock, heartbeat = right now → live at hook-time.
    await seedLock(dir, {
      sessionId: 'foreign-fresh',
      semanticSessionId: 'foreign-fresh-sem',
      lastHeartbeat: new Date().toISOString(),
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: UUID_STALE, reason: 'clear' }),
    });

    // No abandoned stub written — the hook is still blocked by the live foreign lock.
    const records = await readSessions(dir);
    expect(records).toHaveLength(0);
    // The foreign lock is not ours — it must survive untouched.
    expect(await lockExists(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Epic #724 Wave 3 — hardened SessionEnd release path ("ended logged but lock
// survived"). Two failure modes closed:
//   (1) release() returns a non-delete result despite a matched ownership
//       (fs-error) — must surface as a breadcrumb, never vanish silently.
//   (2) neither ownership check matches (rotated harness UUID + null/stale
//       semantic_session_id) but the lease is already dead — the reaper is
//       invoked as a close-time reconciliation fallback instead of leaving the
//       orphan for the next session-start to discover.
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — hardened release path (#724 Wave 3)', { timeout: 15000 }, () => {
  it('reconciles a dead orphaned lock at close-time when the rotated UUID matches neither ownership check (load-bearing)', async () => {
    const dir = await mkProject();
    // The lease was acquired under an OLD uuid, with NO semantic_session_id
    // recorded at all (the exact #724 root-cause shape: a harness UUID
    // rotation racing ahead of current-session.json's semantic bridge).
    // last_heartbeat is far past the 4h default TTL — a dead lease.
    await seedLock(dir, {
      sessionId: 'old-rotated-uuid',
      lastHeartbeat: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    // No current-session.json seeded at all — semanticSessionId resolves to
    // null, so ownBySemantic can never be true either.

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-rotated-uuid', reason: 'clear' }),
    });

    // The reconciliation fallback archive-moved the dead orphaned lease even
    // though neither ownByUuid nor ownBySemantic matched.
    expect(await lockExists(dir)).toBe(false);
    // #748: the reconcile_attempted breadcrumb payload records the ACTUAL
    // reap outcome, not just that reconciliation was attempted.
    const events = await readAllEvents(dir);
    const reconcileEvent = events.find((e) => e.event === 'orchestrator.session.lock.reconcile_attempted');
    expect(reconcileEvent).toBeDefined();
    expect(reconcileEvent.action).toBe('reaped');
  });

  it('records action:"skipped" reason:"own-host-pid-alive" in the reconcile_attempted breadcrumb when the dead lease has a live PID (#748)', async () => {
    const dir = await mkProject();
    // Same rotated-UUID / no-semantic-bridge shape as the reap test above, but
    // the recorded pid is overwritten to a real, currently-alive PID (this
    // test process's own pid — a process can always signal itself) so
    // reapRepoLock's own-host-pid-alive invariant (b) skips the reap.
    await seedLock(dir, {
      sessionId: 'old-rotated-uuid-pid-alive',
      lastHeartbeat: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    const lockPath = path.join(dir, LOCK_REL);
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    lock.pid = process.pid;
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-rotated-uuid-pid-alive', reason: 'clear' }),
    });

    // Never reaped — the lease survives untouched.
    expect(await lockExists(dir)).toBe(true);
    const events = await readAllEvents(dir);
    const reconcileEvent = events.find((e) => e.event === 'orchestrator.session.lock.reconcile_attempted');
    expect(reconcileEvent).toBeDefined();
    expect(reconcileEvent.action).toBe('skipped');
    expect(reconcileEvent.reason).toBe('own-host-pid-alive');
  });

  it.skipIf(!permsEnforced())('emits a breadcrumb when release() fails despite a matched ownership (fs-error)', { timeout: 15000 }, async () => {
    const dir = await mkProject();
    await seedLock(dir, { sessionId: 'sess-own-fail', semanticSessionId: 'sem-own-fail' });
    // Pre-create metrics/ BEFORE locking down .orchestrator/ so the primary
    // session.ended emitEvent() write (which needs to mkdir the metrics/
    // directory on first use) is unaffected by the permission change below.
    await fs.mkdir(path.join(dir, '.orchestrator', 'metrics'), { recursive: true });

    const orchestratorDir = path.join(dir, '.orchestrator');
    // r-xr-xr-x: readLock() (read-only) still succeeds, but unlinkSync() of
    // session.lock (a direct child of .orchestrator/) needs WRITE permission
    // on this directory — removed here — so release() fails at the fs layer
    // with reason: 'fs-error', despite the ownership match succeeding.
    await fs.chmod(orchestratorDir, 0o555);
    try {
      await runHook({
        projectDir: dir,
        stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-own-fail', reason: 'clear' }),
      });

      // The unlink failed — the lock must still be on disk (nothing silently lost).
      expect(await lockExists(dir)).toBe(true);
      const events = await readAllEvents(dir);
      const breadcrumb = events.find((e) => e.event === 'orchestrator.session.lock.release_failed');
      expect(breadcrumb).toBeDefined();
      expect(breadcrumb.session_id).toBe('sess-own-fail');
      expect(breadcrumb.reason).toBe('fs-error');
    } finally {
      // Restore write permission so afterEach's recursive rm can clean up.
      await fs.chmod(orchestratorDir, 0o755);
    }
  });

  it('happy path unchanged: an owned live lock releases normally with no reconciliation and no failure breadcrumb', async () => {
    const dir = await mkProject();
    await seedLock(dir, { sessionId: 'sess-happy', semanticSessionId: 'sem-happy' });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-happy', reason: 'clear' }),
    });

    expect(await lockExists(dir)).toBe(false);
    const events = await readAllEvents(dir);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.release_failed')).toBe(false);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.reconcile_attempted')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #863 — semantic-id contamination releases a FOREIGN live lock, and a
// lock-shape trap (session_id IS the semantic id, no semantic_session_id
// field) that a fallback-only match must not trust while live.
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — semantic-id contamination guard (#863)', { timeout: 15000 }, () => {
  it('does NOT release a DIFFERENT, still-live session\'s lock when a foreign terminating window inherits the currently-recorded semantic id', async () => {
    const dir = await mkProject();
    // current-session.json reflects session B — the CURRENTLY recorded
    // session, still live right now (e.g. a second open window/tab).
    await seedCurrentSession(dir, {
      sessionId: 'uuid-b',
      timestamp: new Date().toISOString(),
      semanticSessionId: 'sem-b',
    });
    // B's own lock — genuinely live.
    await seedLock(dir, {
      sessionId: 'uuid-b',
      semanticSessionId: 'sem-b',
      lastHeartbeat: new Date().toISOString(),
    });

    // Window A's SessionEnd fires with its OWN, explicit, DIFFERENT uuid —
    // this has nothing to do with B.
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'uuid-a', reason: 'clear' }),
    });

    // B's live lock must survive untouched — A's termination is unrelated.
    expect(await lockExists(dir)).toBe(true);
  });

  it('lock-shape trap (d) — a fallback-only semantic match on a LIVE lock is never released (low-confidence, no stdin corroboration)', async () => {
    const dir = await mkProject();
    // The lock stores the semantic id directly in session_id; no separate
    // semantic_session_id field (the shape observed on-disk in this repo).
    // Its own id ('sem-b') differs from the CURRENT recorded session_id
    // ('new-id-b') — a rotation-shaped divergence, but without the strict
    // semantic_session_id field the strict comparison can't recognise it.
    await seedLock(dir, {
      sessionId: 'sem-b',
      semanticSessionId: undefined,
      lastHeartbeat: new Date().toISOString(),
    });
    await seedCurrentSession(dir, {
      sessionId: 'new-id-b',
      timestamp: new Date().toISOString(),
      semanticSessionId: 'sem-b',
    });

    // Explicit, genuinely-matching stdin — this really is the recorded
    // session ending (not an omitted-stdin ambiguity).
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-id-b', reason: 'clear' }),
    });

    // Fallback-only match on a LIVE lock — never released.
    expect(await lockExists(dir)).toBe(true);
  });

  it('lock-shape trap (d) — a fallback-only semantic match on a STALE lock is reaped by reconciliation', async () => {
    const dir = await mkProject();
    await seedLock(dir, {
      sessionId: 'sem-c',
      semanticSessionId: undefined,
      lastHeartbeat: new Date(Date.now() - 5 * 3600_000).toISOString(), // stale
    });
    await seedCurrentSession(dir, {
      sessionId: 'new-id-c',
      timestamp: new Date().toISOString(),
      semanticSessionId: 'sem-c',
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-id-c', reason: 'clear' }),
    });

    expect(await lockExists(dir)).toBe(false);
    const events = await readAllEvents(dir);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.reconcile_attempted')).toBe(true);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.released')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #863 (QA follow-up) — the contamination-guard fixture above never seeds
// events.jsonl, so backfillAbandonedSession()'s collectSessionEvents() walk
// is a trivial no-op regardless of whether the backfiller is broken. This
// block re-runs the SAME "Window A ends, Session B is recorded+live" shape
// WITH real events seeded for B (`started` + `lock.acquired`), so the
// backfill path genuinely traverses provenance data, and asserts on
// sessions.jsonl in addition to the lock — closing the gap the earlier test
// left open (see the RED/GREEN proof + DECISIONS note in the session report
// for what the revert actually demonstrates).
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — contamination guard covers backfill too, with a genuinely-reached events walk (#863 follow-up)', { timeout: 15000 }, () => {
  const UUID_A = '77777777-8888-4999-a000-111111111111'; // Window A — ending session, unrelated to B
  const UUID_B = '22222222-3333-4444-8555-666666666666'; // Session B — recorded + LIVE right now
  const SEM_B = 'main-2026-07-02-session-b';
  const STARTED_AT_B = '2026-07-02T09:00:00.000Z';

  it('does NOT release session B\'s live lock, and does NOT backfill any sessions.jsonl record, when B has real seeded provenance (started + lock.acquired)', async () => {
    const dir = await mkProject();
    // B has real history in events.jsonl — collectSessionEvents() genuinely
    // walks and matches these records (unlike the no-events fixture above),
    // so a green result here is not a vacuous "nothing to process" pass.
    await seedEvents(dir, [
      { timestamp: STARTED_AT_B, event: 'orchestrator.session.started', session_id: UUID_B, branch: 'main', project: 'demo' },
      {
        timestamp: '2026-07-02T09:01:00.000Z',
        event: 'orchestrator.session.lock.acquired',
        session_id: UUID_B,
        semantic_session_id: SEM_B,
        mode: 'deep',
      },
    ]);
    // current-session.json reflects B — the CURRENTLY recorded session,
    // still live right now (e.g. a second open window/tab).
    await seedCurrentSession(dir, { sessionId: UUID_B, timestamp: new Date().toISOString(), semanticSessionId: SEM_B });
    // B's own lock — genuinely live.
    await seedLock(dir, { sessionId: UUID_B, semanticSessionId: SEM_B, lastHeartbeat: new Date().toISOString() });

    // Window A's SessionEnd fires with its OWN, explicit, DIFFERENT uuid —
    // this has nothing to do with B.
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: UUID_A, reason: 'clear' }),
    });

    // B's live lock must survive untouched — A's termination is unrelated.
    expect(await lockExists(dir)).toBe(true);
    // No sessions.jsonl entry gets written as a side effect of A's unrelated
    // termination — neither attributed to B nor to anyone else.
    const records = await readSessions(dir);
    expect(records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #906-class — an unreadable/corrupt session.lock must surface as
// `orchestrator.session.lock.read_anomaly`, not silently collapse to "no
// lock, all clear". Before readLockDetailed(), a vanished/unparseable lock
// read identically to an absent one — a genuinely present-but-broken lock
// went completely unnoticed (neither released nor flagged).
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — unreadable/corrupt lock surfaces as read_anomaly (#906-class)', { timeout: 15000 }, () => {
  it('emits read_anomaly status:"corrupt" for an unparseable lock file, and never attempts release or reconciliation', async () => {
    const dir = await mkProject();
    const lockPath = path.join(dir, LOCK_REL);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, 'not valid json {{{');

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'whoever' }),
    });

    const events = await readAllEvents(dir);
    const anomaly = events.find((e) => e.event === 'orchestrator.session.lock.read_anomaly');
    expect(anomaly).toBeDefined();
    expect(anomaly.status).toBe('corrupt');
    // Never released or reconciled — the garbage content is untouched.
    expect(await fs.readFile(lockPath, 'utf8')).toBe('not valid json {{{');
    expect(events.some((e) => e.event === 'orchestrator.session.lock.reconcile_attempted')).toBe(false);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.release_failed')).toBe(false);
  });

  it('emits read_anomaly status:"unreadable" when the lock path is a directory (EISDIR — fails for every uid, no chmod/root pitfall)', async () => {
    // A directory at the lock path throws EISDIR on read for ANY uid — this
    // is a syscall-level restriction, not a permission bit, so it exercises
    // the 'unreadable' branch WITHOUT the chmod-based EACCES pitfall that CI's
    // root (uid 0) Hetzner runner bypasses (testing.md's root-as-uid-0 hazards
    // note; tests/_helpers/perms.mjs). Never use a /proc path here — that can
    // hang a sync syscall under root and stall the whole shard (#685).
    const dir = await mkProject();
    const lockPath = path.join(dir, LOCK_REL);
    await fs.mkdir(lockPath, { recursive: true });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'whoever' }),
    });

    const events = await readAllEvents(dir);
    const anomaly = events.find((e) => e.event === 'orchestrator.session.lock.read_anomaly');
    expect(anomaly).toBeDefined();
    expect(anomaly.status).toBe('unreadable');
    expect(typeof anomaly.error).toBe('string');
    expect(events.some((e) => e.event === 'orchestrator.session.lock.reconcile_attempted')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1085 — a strict semantic match never grants direct release ownership.
// The live case above must retain the lock; this counterpart proves that a
// stale lock remains eligible for the reaper's separate reconciliation path.
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — semantic mismatch preserves stale-lock reconciliation (#1085)', { timeout: 15000 }, () => {
  it('reaps a STALE lock through reconciliation when only the STRICT semantic id matches', async () => {
    const dir = await mkProject();
    // The strict semantic field matches, but the raw/native session IDs differ.
    // A stale lease remains eligible for reaper cleanup, never direct release.
    await seedLock(dir, {
      sessionId: 'old-uuid-strict-stale',
      semanticSessionId: 'sem-shared-strict-stale',
      lastHeartbeat: new Date(Date.now() - 5 * 3600_000).toISOString(),
    });
    await seedCurrentSession(dir, {
      sessionId: 'new-uuid-strict-stale',
      timestamp: new Date().toISOString(),
      semanticSessionId: 'sem-shared-strict-stale',
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-uuid-strict-stale' }),
    });

    expect(await lockExists(dir)).toBe(false);
    const events = await readAllEvents(dir);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.reconcile_attempted')).toBe(true);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.released')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1085 — raw native session_id is the sole live-lock ownership identity.
// A matching semantic id and genesis proof can corroborate a raw-owned lock,
// but must never heal a raw-ID mismatch.
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — raw-ID ownership boundary (#1085)', { timeout: 15000 }, () => {
  it('does NOT release a LIVE semantic-only-matched lock when the persisted owner proof matches', async () => {
    const dir = await mkProject();
    // The ending session's native ID is not the lock's native ID. Its semantic
    // ID and persisted proof happen to match, which must remain insufficient.
    await seedLock(dir, { sessionId: 'old-uuid-987', semanticSessionId: 'sem-987' });
    await seedOwnerProofFromLock(dir);
    await seedCurrentSession(dir, {
      sessionId: 'new-uuid-987',
      timestamp: new Date().toISOString(),
      semanticSessionId: 'sem-987',
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-uuid-987', reason: 'clear' }),
    });

    // The live lock and its proof remain for TTL/reaper reconciliation; neither
    // semantic equality nor the matching proof grants delete ownership.
    expect(await lockExists(dir)).toBe(true);
    await expect(fs.access(path.join(dir, PROOF_REL))).resolves.toBeUndefined();
    const events = await readAllEvents(dir);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.released')).toBe(false);
  });

  it('does NOT release when the proof startedAt differs by 1ms (foreign same-day collision)', async () => {
    const dir = await mkProject();
    // Same live semantic-only-match shape, but the on-disk lock was written
    // by a DIFFERENT process one millisecond apart from our genesis proof —
    // the exact foreign same-day collision signature. pid/host still match
    // (same machine), so started_at alone carries the discrimination.
    await seedLock(dir, { sessionId: 'old-uuid-987-f', semanticSessionId: 'sem-987-f' });
    await seedOwnerProofFromLock(dir, { startedAtOffsetMs: 1 });
    await seedCurrentSession(dir, {
      sessionId: 'new-uuid-987-f',
      timestamp: new Date().toISOString(),
      semanticSessionId: 'sem-987-f',
    });

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-uuid-987-f', reason: 'clear' }),
    });

    // Foreign lease survives untouched — proof mismatch keeps the
    // raw-ID ownership boundary closed.
    expect(await lockExists(dir)).toBe(true);
    const events = await readAllEvents(dir);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.released')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Host-registry deregistration (#1047)
//
// This is HALF B of the #1047 fix. Half A — the Stop hook refreshing the entry
// instead of deleting it — is pinned in tests/hooks/on-stop.test.mjs, whose
// comment states why only a spawned-hook test can catch that class: both
// deregisterSelf() and heartbeat() are correct in isolation and their lib unit
// tests pass either way, so the defect lives in the hook's WIRING.
//
// The same reasoning applies here and was NOT applied when half B landed:
// deleting the deregistration block from hooks/on-session-end.mjs left the full
// suite green at 13988/0 (measured 2026-08-17). These tests close that gap.
// ---------------------------------------------------------------------------

/** Seed a registry entry in the per-test SO_SESSION_REGISTRY_DIR. */
async function seedRegistryEntry(registryDir, sessionId) {
  const active = path.join(registryDir, 'active');
  await fs.mkdir(active, { recursive: true });
  const stamp = new Date().toISOString();
  await fs.writeFile(
    path.join(active, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      pid: process.pid,
      repo_name: 'demo',
      branch: 'main',
      started_at: stamp,
      last_heartbeat: stamp,
      status: 'active',
      current_wave: 0,
    }),
  );
  return path.join(active, `${sessionId}.json`);
}

async function exists(p) {
  return fs.access(p).then(() => true).catch(() => false);
}

describe('on-session-end.mjs — host-registry deregistration (#1047)', { timeout: 15000 }, () => {
  let registryDir;
  let origRegistryDir;

  beforeEach(async () => {
    origRegistryDir = process.env.SO_SESSION_REGISTRY_DIR;
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-session-end-registry-'));
    tmpDirs.push(registryDir);
    process.env.SO_SESSION_REGISTRY_DIR = registryDir;
  });

  afterEach(() => {
    if (origRegistryDir === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
    else process.env.SO_SESSION_REGISTRY_DIR = origRegistryDir;
  });

  it('removes the registry entry at session end', async () => {
    const dir = await mkProject();
    const sessionId = 'end-dereg-uuid-1';
    const entryPath = await seedRegistryEntry(registryDir, sessionId);
    expect(await exists(entryPath)).toBe(true);

    const res = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'exit' }),
    });

    expect(res.code).toBe(0);
    // The assertion that goes RED when the deregistration block is absent.
    expect(await exists(entryPath)).toBe(false);
  });

  it('removes only its own entry, leaving a peer entry byte-identical', async () => {
    const dir = await mkProject();
    const mine = 'end-dereg-uuid-2';
    const peer = 'end-dereg-peer-9';
    const minePath = await seedRegistryEntry(registryDir, mine);
    const peerPath = await seedRegistryEntry(registryDir, peer);
    const peerBefore = await fs.readFile(peerPath, 'utf8');

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: mine, reason: 'exit' }),
    });

    expect(await exists(minePath)).toBe(false);
    expect(await exists(peerPath)).toBe(true);
    expect(await fs.readFile(peerPath, 'utf8')).toBe(peerBefore);
  });

  it('resolves the session id from current-session.json when stdin carries none', async () => {
    const dir = await mkProject();
    const sessionId = 'end-dereg-fallback-3';
    await seedCurrentSession(dir, { sessionId, timestamp: new Date().toISOString() });
    const entryPath = await seedRegistryEntry(registryDir, sessionId);

    const res = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'exit' }),
    });

    expect(res.code).toBe(0);
    expect(await exists(entryPath)).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// #1138 — mechanical telemetry flush
// ---------------------------------------------------------------------------

/**
 * Isolation contract for this block:
 *   - HOME is a fresh mkdtemp for EVERY run, so `os.homedir()` (and with it
 *     `~/.config/session-orchestrator/telemetry.json`, the send queue, and
 *     owner.yaml) resolves into throwaway state. The operator's real consent
 *     record is never read and never written.
 *   - SO_TELEMETRY_ENDPOINT points at a local 127.0.0.1 collector or at a closed
 *     port. No test here reaches the real ingest server.
 *   - The three env kill-switches are cleared explicitly, so an ambient
 *     DO_NOT_TRACK on a developer machine cannot silently turn a "sent"
 *     assertion into a passing "gated".
 */

/** A fresh fake HOME; auto-removed by the outer afterEach. */
async function mkFakeHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-session-end-home-'));
  tmpDirs.push(dir);
  return dir;
}

/** Write ~/.config/session-orchestrator/telemetry.json inside a fake HOME. */
async function seedTelemetryState(fakeHome, record) {
  const dir = path.join(fakeHome, '.config', 'session-orchestrator');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'telemetry.json'), JSON.stringify(record));
}

/** Env block shared by every flush test: fake HOME + cleared kill-switches. */
function telemetryEnv(fakeHome, endpoint) {
  return {
    HOME: fakeHome,
    SO_TELEMETRY_ENDPOINT: endpoint,
    SO_TELEMETRY: '',
    SO_TELEMETRY_DISABLED: '',
    DO_NOT_TRACK: '',
  };
}

/** A local collector that records every POSTed body and answers 204. */
async function startCollector() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { received.push(JSON.parse(body)); } catch { received.push(body); }
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { url, received, close: () => new Promise((r) => server.close(r)) };
}

const flushEvents = async (dir) =>
  (await readAllEvents(dir)).filter((e) => e.event === 'orchestrator.telemetry.flush');

describe('on-session-end.mjs — mechanical telemetry flush (#1138)', { timeout: 20000 }, () => {
  // THE DEFECT THIS BLOCK PINS: before #1138 the close-time flush lived only in
  // `skills/session-end/SKILL.md` § Phase 3.45 prose. `main()` never called
  // `flush()`, so a session that never ran /close — or a coordinator that never
  // reached phase 3.45 — sent nothing at all. Measured 2026-08-23: 588 closes
  // across 13 repos produced 82 ingest records (~14%).

  it('calls flush() on every close — a host with no consent decision records a gated outcome', async () => {
    const dir = await mkProject();
    const home = await mkFakeHome();

    const res = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }),
      // Port 9 (discard) is never listened on; the consent gate short-circuits
      // long before any socket is opened.
      env: telemetryEnv(home, 'http://127.0.0.1:9/'),
    });

    expect(res.code).toBe(0);
    expect(await flushEvents(dir)).toEqual([
      expect.objectContaining({ event: 'orchestrator.telemetry.flush', outcome: 'gated', reason: 'gated' }),
    ]);
  });

  it("sends a ping built from the ENDING project's metrics dir, not the hook process cwd", async () => {
    const dir = await mkProject();
    const home = await mkFakeHome();
    const collector = await startCollector();
    try {
      await seedTelemetryState(home, {
        schema_version: 1,
        consent: 'granted',
        decided_at: '2026-08-01T00:00:00.000Z',
        last_flush_at: null,
      });
      // `session_type: 'deep'` is the discriminator: it survives the whitelist
      // projection and can ONLY come from THIS project's sessions.jsonl.
      await seedSessions(dir, [{
        schema_version: 1,
        session_id: 'flush-me',
        session_type: 'deep',
        started_at: '2026-08-23T09:00:00.000Z',
        completed_at: '2026-08-23T09:30:00.000Z',
      }]);

      const res = await runHook({
        projectDir: dir,
        stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'clear' }),
        env: telemetryEnv(home, collector.url),
      });

      expect(res.code).toBe(0);
      expect(collector.received).toHaveLength(1);
      expect(collector.received[0]).toHaveLength(1);
      expect(collector.received[0][0]).toMatchObject({ session_type: 'deep' });
      expect(await flushEvents(dir)).toEqual([
        expect.objectContaining({ outcome: 'sent', reason: 'sent' }),
      ]);
    } finally {
      await collector.close();
    }
  });

  it('queues instead of sending when the endpoint is unreachable, and never throws', async () => {
    const dir = await mkProject();
    const home = await mkFakeHome();
    await seedTelemetryState(home, {
      schema_version: 1,
      consent: 'granted',
      decided_at: '2026-08-01T00:00:00.000Z',
      last_flush_at: null,
    });

    const res = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }),
      env: telemetryEnv(home, 'http://127.0.0.1:9/'),
    });

    expect(res.code).toBe(0);
    expect(await flushEvents(dir)).toEqual([
      expect.objectContaining({ outcome: 'queued', reason: 'queued' }),
    ]);
    // The record landed in the host-local queue under the FAKE home.
    const queued = await fs.readFile(
      path.join(home, '.config', 'session-orchestrator', 'telemetry-queue.ndjson'),
      'utf8',
    );
    expect(queued.trim().split('\n')).toHaveLength(1);
  });

  it('skips the flush entirely under persistence: false', async () => {
    const dir = await mkProject();
    const home = await mkFakeHome();
    const collector = await startCollector();
    try {
      await seedTelemetryState(home, {
        schema_version: 1,
        consent: 'granted',
        decided_at: '2026-08-01T00:00:00.000Z',
        last_flush_at: null,
      });
      await fs.writeFile(
        path.join(dir, 'CLAUDE.md'),
        '# Test\n\n## Session Config\n\npersistence: false\nenforcement: warn\n',
      );

      const res = await runHook({
        projectDir: dir,
        stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }),
        env: telemetryEnv(home, collector.url),
      });

      expect(res.code).toBe(0);
      expect(collector.received).toEqual([]);
      expect(await flushEvents(dir)).toEqual([
        expect.objectContaining({ outcome: 'skipped', reason: 'persistence-disabled' }),
      ]);
    } finally {
      await collector.close();
    }
  });

  // THE GUARD'S OWN GUARD. The other ~35 tests in this file would keep passing
  // if `...telemetryIsolationEnv()` were dropped from runHook — they assert
  // nothing about telemetry, which is precisely why the leak went unnoticed
  // until an md5 of the operator's real queue file caught it. This test bites
  // on exactly the machines where the hazard is real: a host whose
  // ~/.config/session-orchestrator/telemetry.json says `granted` would produce
  // 'sent' or 'queued' here without the isolation. On a host with no consent
  // record (a clean CI runner) it is green either way — an asymmetry worth
  // stating rather than papering over.
  it('is fail-closed by DEFAULT — a run with no env override never sends, whatever the host consented to', async () => {
    const dir = await mkProject();

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }),
    });

    expect(await flushEvents(dir)).toEqual([
      expect.objectContaining({ outcome: 'gated', reason: 'gated' }),
    ]);
  });

  it('carries no telemetry payload on the observability event — exactly {outcome, reason}', async () => {
    const dir = await mkProject();
    const home = await mkFakeHome();

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'other' }),
      env: telemetryEnv(home, 'http://127.0.0.1:9/'),
    });

    const [ev] = await flushEvents(dir);
    // timestamp + event come from emitEvent; the hook adds exactly two keys.
    expect(Object.keys(ev).sort()).toEqual(['event', 'outcome', 'reason', 'timestamp']);
  });
});

// ---------------------------------------------------------------------------
// #1138 — the flush's time budget: manifest timeout + position in main()
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — flush time budget (#1138)', { timeout: 20000 }, () => {
  // WHY THIS IS PINNED. Every one of the 44 hook timeouts across the four
  // manifests is `5`; SessionEnd is now the single deliberate exception, so a
  // future "make the timeouts consistent" edit would silently revert it and
  // nothing else would notice. The two timeouts fail differently: the internal
  // one (TELEMETRY_FLUSH_TIMEOUT_MS) expiring queues the record, while the
  // HARNESS one expiring kills the process mid-flight and loses it — which is
  // exactly the silent drop #1138 removes.
  it('gives the SessionEnd hook a 10 s manifest budget, not the shared 5 s', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.resolve(import.meta.dirname, '../../hooks/hooks.json'), 'utf8'),
    );
    const entries = manifest.hooks.SessionEnd.flatMap((r) => r.hooks);
    const ours = entries.filter((h) => String(h.command).includes('on-session-end.mjs'));
    expect(ours).toHaveLength(1);
    expect(ours[0].timeout).toBe(10);
  });

  // WHY ORDER MATTERS. The flush is the only step in main() that may touch the
  // network, so it is the only one that can be killed by the harness timeout.
  // Running it LAST means such a kill takes nothing with it: the backfill, the
  // lock release and the deregistration are already durable on disk. If the
  // flush ever moves earlier, a slow endpoint starts eating the lock release.
  it('runs the flush AFTER the lifecycle event and the lock release', async () => {
    const dir = await mkProject();
    const home = await mkFakeHome();
    const sessionId = 'end-flush-order-1';
    await seedLock(dir, { sessionId });
    await seedOwnerProofFromLock(dir);

    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' }),
      env: telemetryEnv(home, 'http://127.0.0.1:9/'),
    });

    const names = (await readAllEvents(dir)).map((e) => e.event);
    expect(names).toContain('orchestrator.session.lock.released');
    expect(names[names.length - 1]).toBe('orchestrator.telemetry.flush');
    expect(names.indexOf('orchestrator.telemetry.flush'))
      .toBeGreaterThan(names.indexOf('orchestrator.session.ended'));
    expect(names.indexOf('orchestrator.telemetry.flush'))
      .toBeGreaterThan(names.indexOf('orchestrator.session.lock.released'));
  });
});
