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

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { permsEnforced } from '../_helpers/perms.mjs';

const HOOK = path.resolve(import.meta.dirname, '../../hooks/on-session-end.mjs');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');
const LOCK_REL = path.join('.orchestrator', 'session.lock');

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

async function runHook({ projectDir, stdin = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
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

async function readLastEvent(projectDir) {
  const content = await fs.readFile(path.join(projectDir, EVENTS_REL), 'utf8');
  const lines = content.trim().split('\n').filter((l) => l.length > 0);
  return JSON.parse(lines[lines.length - 1]);
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
  it('exits 0', async () => {
    const dir = await mkProject();
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-1', reason: 'clear' }),
    });
    expect(result.code).toBe(0);
  });

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
    const result = await runHook({ projectDir: dir, stdin: '' });
    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
    expect(record.reason).toBe('other');
  });

  it('record carries an ISO 8601 timestamp', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-ts' }),
    });
    const record = await readLastEvent(dir);
    expect(typeof record.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
  });

  it('degrades to duration_ms 0 when current-session.json is malformed JSON', async () => {
    const dir = await mkProject();
    const od = path.join(dir, '.orchestrator');
    await fs.mkdir(od, { recursive: true });
    await fs.writeFile(path.join(od, 'current-session.json'), '{ not valid json');
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-x' }),
    });
    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
    expect(record.session_id).toBe('sess-x');
    expect(record.duration_ms).toBe(0);
  });

  it('degrades to duration_ms 0 when recorded timestamp is a non-string', async () => {
    const dir = await mkProject();
    await seedCurrentSession(dir, { sessionId: 'sess-ts', timestamp: 123456 });
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-ts' }),
    });
    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record.duration_ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C1 (#724) — deterministic lock release
// ---------------------------------------------------------------------------

describe('on-session-end.mjs — deterministic lock release (#724)', { timeout: 15000 }, () => {
  it('releases the session.lock when it belongs to the ending session (UUID match)', async () => {
    const dir = await mkProject();
    await seedLock(dir, { sessionId: 'sess-own', semanticSessionId: 'sem-own' });

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-own' }),
    });

    expect(result.code).toBe(0);
    expect(await lockExists(dir)).toBe(false);
  });

  it('releases the lock when only the SEMANTIC id matches (UUID rotated across clear)', async () => {
    const dir = await mkProject();
    // Lock recorded under an older UUID but the same semantic id.
    await seedLock(dir, { sessionId: 'old-uuid', semanticSessionId: 'sem-shared' });
    await seedCurrentSession(dir, {
      sessionId: 'new-uuid',
      timestamp: new Date().toISOString(),
      semanticSessionId: 'sem-shared',
    });

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-uuid' }),
    });

    expect(result.code).toBe(0);
    expect(await lockExists(dir)).toBe(false);
  });

  it('does NOT release a FOREIGN lock (different session, live heartbeat)', async () => {
    const dir = await mkProject();
    await seedLock(dir, {
      sessionId: 'foreign-sess',
      semanticSessionId: 'foreign-sem',
      lastHeartbeat: new Date().toISOString(),
    });
    await seedCurrentSession(dir, {
      sessionId: 'sess-me',
      timestamp: new Date().toISOString(),
      semanticSessionId: 'sem-me',
    });

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-me' }),
    });

    expect(result.code).toBe(0);
    // Foreign lock must survive — PSA: never destroy another session's lease.
    expect(await lockExists(dir)).toBe(true);
    // And the informational event is still emitted despite the foreign lock.
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
  });

  it('exits 0 and still emits session.ended even with a foreign lock present (backfill/release are best-effort)', async () => {
    const dir = await mkProject();
    await seedLock(dir, {
      sessionId: 'other',
      semanticSessionId: 'other-sem',
      lastHeartbeat: new Date().toISOString(),
    });

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'mine', reason: 'logout' }),
    });

    expect(result.code).toBe(0);
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
    // Own live lock (UUID match) — backfill proceeds, release then clears it.
    await seedLock(dir, { sessionId: UUID, semanticSessionId: SEMANTIC });

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: UUID, reason: 'clear' }),
    });

    expect(result.code).toBe(0);

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

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: UUID, reason: 'clear' }),
    });

    expect(result.code).toBe(0);
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

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: UUID_STALE, reason: 'clear' }),
    });

    expect(result.code).toBe(0);
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

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-rotated-uuid', reason: 'clear' }),
    });

    expect(result.code).toBe(0);
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

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'new-rotated-uuid-pid-alive', reason: 'clear' }),
    });

    expect(result.code).toBe(0);
    // Never reaped — the lease survives untouched.
    expect(await lockExists(dir)).toBe(true);
    const events = await readAllEvents(dir);
    const reconcileEvent = events.find((e) => e.event === 'orchestrator.session.lock.reconcile_attempted');
    expect(reconcileEvent).toBeDefined();
    expect(reconcileEvent.action).toBe('skipped');
    expect(reconcileEvent.reason).toBe('own-host-pid-alive');
  });

  it('does NOT reap a live lock that belongs to neither ownership check (reconciliation is dead-lease-only)', async () => {
    const dir = await mkProject();
    await seedLock(dir, {
      sessionId: 'foreign-live-uuid',
      semanticSessionId: 'foreign-live-sem',
      lastHeartbeat: new Date().toISOString(), // fresh — live
    });
    // No current-session.json — this session's own semanticSessionId is null,
    // so ownBySemantic cannot accidentally match the foreign lock's semantic id.

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'me-different-uuid', reason: 'clear' }),
    });

    expect(result.code).toBe(0);
    // Live + not-ours → reconciliation must never touch it.
    expect(await lockExists(dir)).toBe(true);
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
      const result = await runHook({
        projectDir: dir,
        stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-own-fail', reason: 'clear' }),
      });

      expect(result.code).toBe(0);
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

    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-happy', reason: 'clear' }),
    });

    expect(result.code).toBe(0);
    expect(await lockExists(dir)).toBe(false);
    const events = await readAllEvents(dir);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.release_failed')).toBe(false);
    expect(events.some((e) => e.event === 'orchestrator.session.lock.reconcile_attempted')).toBe(false);
  });
});
