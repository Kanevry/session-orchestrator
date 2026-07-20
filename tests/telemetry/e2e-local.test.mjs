/**
 * tests/telemetry/e2e-local.test.mjs — the local FULL CHAIN for anonymous
 * usage telemetry, hand-wired WITHOUT scripts/lib/telemetry/sync.mjs (Epic
 * #841; PRD docs/prd/2026-07-20-anonymous-usage-telemetry.md §3 Edge Cases +
 * FA2/FA3/FA4).
 *
 * sync.mjs and scripts/telemetry.mjs are a sibling agent's in-flight work
 * (P1) and are tested there — this file deliberately re-derives the same
 * "consent -> build -> anon-id -> project -> POST -> aggregate" flow using
 * ONLY the already-shipped Wave-2 modules (consent, schema, anon-id, queue)
 * plus the Wave-2 server (server.mjs / db.mjs), proving those pieces compose
 * correctly on their own public APIs.
 *
 * Isolation: every test gets a fresh mkdtempSync directory (path-injected
 * into every module via its `{ path }` option) and a fresh in-process ingest
 * server (`createIngestServer({ dbPath: ':memory:' })` on an ephemeral port).
 * No personal host paths appear in any fixture.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { grantConsent, readTelemetryState, writeTelemetryState, resolveConsent } from '../../scripts/lib/telemetry/consent.mjs';
import { buildUsagePing, projectUsagePing, loadRoster } from '../../scripts/lib/telemetry/schema.mjs';
import { ensureAnonId } from '../../scripts/lib/telemetry/anon-id.mjs';
import { enqueue, drain, queueStats } from '../../scripts/lib/telemetry/queue.mjs';
import { createIngestServer } from '../../server/ingest/server.mjs';
import { countRecords, querySummary } from '../../server/ingest/db.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const START = '2026-07-20T00:00:00.000Z';

/** A fully-valid, standalone usage-ping v1 record for queue/drain fixtures. */
function samplePing(overrides = {}) {
  return {
    record_kind: 'usage-ping',
    schema_version: 1,
    anon_id: '99999999-8888-4777-8666-555555555555',
    sent_at: START,
    plugin_version: '1.0.0',
    platform: 'claude',
    os: 'darwin',
    arch: 'arm64',
    node_major: 24,
    ci: false,
    fleet: false,
    session_type: 'housekeeping',
    duration_bucket: '<15m',
    skills: [],
    commands: [],
    ...overrides,
  };
}

let tmp;
let ctx;
let base;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'so-telemetry-e2e-'));
  ctx = createIngestServer({ dbPath: ':memory:' });
  await new Promise((resolve_) => ctx.server.listen(0, '127.0.0.1', resolve_));
  const { port } = ctx.server.address();
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (ctx) await ctx.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1 — Happy path: consent -> build -> anon-id -> write -> project -> POST ->
//     server-side aggregation.
// ---------------------------------------------------------------------------

describe('e2e-local: happy path', () => {
  it('grants consent, builds a whitelist-clean ping, mints an anon_id, posts it, and the server aggregates it correctly', async () => {
    const statePath = join(tmp, 'telemetry.json');

    const grantResult = grantConsent({ path: statePath, now: START });
    expect(grantResult.ok).toBe(true);

    const { record: consentRecord } = readTelemetryState({ path: statePath });
    const consent = resolveConsent({ env: {}, ownerConfig: {}, state: consentRecord, interactive: false });
    expect(consent.state).toBe('enabled-consent');
    expect(consent.send).toBe(true);

    const sessionRecord = {
      session_type: 'deep',
      started_at: '2026-07-20T00:00:00.000Z',
      completed_at: '2026-07-20T00:45:00.000Z', // 45 min -> 15-60m
    };
    const skillInvocations = [
      { timestamp: START, event: 'selected', skill: 'session-orchestrator:session-start', session_id: 's1', schema_version: 1 },
      { timestamp: START, event: 'selected', skill: 'session-orchestrator:session-start', session_id: 's1', schema_version: 1 },
      { timestamp: START, event: 'selected', skill: 'session-orchestrator:wave-executor', session_id: 's1', schema_version: 1 },
    ];
    const roster = {
      skills: new Set(['session-orchestrator:session-start', 'session-orchestrator:wave-executor']),
      commands: new Set(),
    };

    const built = buildUsagePing({ sessionRecord, skillInvocations, env: {}, now: START, roster });
    expect(built.duration_bucket).toBe('15-60m');

    const anonResult = ensureAnonId({}, { now: START });
    expect(anonResult.created).toBe(true);

    const writeRes = writeTelemetryState(
      { ...consentRecord, anon_id: anonResult.anon_id, anon_id_created_at: START },
      { path: statePath },
    );
    expect(writeRes.ok).toBe(true);

    const ping = projectUsagePing({ ...built, anon_id: anonResult.anon_id });

    const res = await fetch(`${base}/v1/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ping),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(countRecords(ctx.db)).toBe(1);

    const summary = querySummary(ctx.db);
    expect(summary.total).toBe(1);
    // platform is environment-derived (SO_PLATFORM) and not overridable here;
    // this asserts ROUND-TRIP FIDELITY (the value the client produced is the
    // exact key the server aggregates under), not derivation correctness
    // (that invariant is schema.test.mjs's job).
    expect(Object.keys(summary.byPlatform)).toEqual([ping.platform]);
    expect(summary.byPlatform[ping.platform]).toBe(1);
    expect(summary.topSkills).toContainEqual({ name: 'session-orchestrator:session-start', count: 1 });
    expect(summary.topSkills).toContainEqual({ name: 'session-orchestrator:wave-executor', count: 1 });
  });
});

// ---------------------------------------------------------------------------
// 2 — Offline -> queue -> drain against a freshly-restarted server instance.
// ---------------------------------------------------------------------------

describe('e2e-local: offline queue then drain', () => {
  it('queues a batch when the server is unreachable, then drains it once a new server instance is listening', async () => {
    const queuePath = join(tmp, 'telemetry-queue.ndjson');

    const deadBase = base;
    await ctx.close();

    await expect(
      fetch(`${deadBase}/v1/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(samplePing()),
      }),
    ).rejects.toThrow();

    const enqueueResult = enqueue(samplePing(), { path: queuePath });
    expect(enqueueResult).toEqual({ ok: true, dropped: 0, total: 1 });
    expect(queueStats({ path: queuePath })).toEqual({ count: 1, bytes: expect.any(Number) });

    // Restart on a brand-new factory instance + fresh in-memory DB.
    ctx = createIngestServer({ dbPath: ':memory:' });
    await new Promise((resolve_) => ctx.server.listen(0, '127.0.0.1', resolve_));
    const { port: livePort } = ctx.server.address();
    const liveBase = `http://127.0.0.1:${livePort}`;

    const drainResult = await drain({
      path: queuePath,
      sender: async ([batch]) => {
        await fetch(`${liveBase}/v1/records`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch),
        });
      },
    });

    expect(drainResult).toEqual({ sent: 1, remaining: 0, dropped: 0 });
    expect(queueStats({ path: queuePath })).toEqual({ count: 0, bytes: 0 });
    expect(countRecords(ctx.db)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3 — anon_id stability across two consecutive builds, and 91-day rotation.
// ---------------------------------------------------------------------------

describe('e2e-local: anon_id stability and rotation across payload builds', () => {
  it('mints the same anon_id for two consecutive builds against the same state file', () => {
    const statePath = join(tmp, 'telemetry.json');
    const sessionRecord = { session_type: 'housekeeping', started_at: START, completed_at: START };
    const roster = { skills: new Set(), commands: new Set() };

    const first = ensureAnonId({}, { now: START });
    expect(first.created).toBe(true);
    writeTelemetryState(
      {
        schema_version: 1,
        consent: 'granted',
        decided_at: START,
        anon_id: first.anon_id,
        anon_id_created_at: START,
        last_flush_at: null,
      },
      { path: statePath },
    );

    const { record: stateAfterFirst } = readTelemetryState({ path: statePath });
    const second = ensureAnonId(stateAfterFirst, { now: START });
    expect(second.created).toBe(false);
    expect(second.rotated).toBe(false);
    expect(second.anon_id).toBe(first.anon_id);

    const ping1 = projectUsagePing({
      ...buildUsagePing({ sessionRecord, skillInvocations: [], env: {}, now: START, roster }),
      anon_id: first.anon_id,
    });
    const ping2 = projectUsagePing({
      ...buildUsagePing({ sessionRecord, skillInvocations: [], env: {}, now: START, roster }),
      anon_id: second.anon_id,
    });
    expect(ping1.anon_id).toBe(ping2.anon_id);
  });

  it('rotates to a new anon_id once the stored one is older than 90 days, and the old id never appears in the payload', () => {
    const statePath = join(tmp, 'telemetry.json');
    const oldId = '11111111-2222-4222-8222-333333333333';
    const createdAt91DaysAgo = '2026-04-20T00:00:00.000Z'; // exactly 91 days before NOW below

    writeTelemetryState(
      {
        schema_version: 1,
        consent: 'granted',
        decided_at: START,
        anon_id: oldId,
        anon_id_created_at: createdAt91DaysAgo,
        last_flush_at: null,
      },
      { path: statePath },
    );

    const { record: state } = readTelemetryState({ path: statePath });
    const rotation = ensureAnonId(state, { now: START });
    expect(rotation.rotated).toBe(true);
    expect(rotation.anon_id).not.toBe(oldId);

    const sessionRecord = { session_type: 'feature', started_at: START, completed_at: START };
    const roster = { skills: new Set(), commands: new Set() };
    const built = buildUsagePing({ sessionRecord, skillInvocations: [], env: {}, now: START, roster });
    const ping = projectUsagePing({ ...built, anon_id: rotation.anon_id });

    expect(ping.anon_id).toBe(rotation.anon_id);
    expect(JSON.stringify(ping)).not.toContain(oldId);
  });
});

// ---------------------------------------------------------------------------
// 4 — duration_bucket chain: a 2-hour session survives build -> project ->
//     POST -> raw_json unchanged.
// ---------------------------------------------------------------------------

describe('e2e-local: duration_bucket chain', () => {
  it('a 2-hour session round-trips as duration_bucket "1-3h" through the full chain', async () => {
    const sessionRecord = {
      session_type: 'deep',
      started_at: '2026-07-20T00:00:00.000Z',
      completed_at: '2026-07-20T02:00:00.000Z',
    };
    const roster = { skills: new Set(), commands: new Set() };
    const built = buildUsagePing({ sessionRecord, skillInvocations: [], env: {}, now: START, roster });
    expect(built.duration_bucket).toBe('1-3h');

    const anon = ensureAnonId({}, { now: START });
    const ping = projectUsagePing({ ...built, anon_id: anon.anon_id });

    const res = await fetch(`${base}/v1/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ping),
    });
    expect(res.status).toBe(202);

    const rows = ctx.db.prepare('SELECT raw_json FROM records').all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].raw_json).duration_bucket).toBe('1-3h');
  });
});

// ---------------------------------------------------------------------------
// 5 — Roster E2E against the REAL shipped plugin surface.
// ---------------------------------------------------------------------------

describe('e2e-local: roster projection against the real plugin surface', () => {
  it('an on-roster skill name survives and a real off-roster skill name ("deep-research") becomes "other"', () => {
    const roster = loadRoster({ pluginRoot: REPO_ROOT });
    // Verified via loadRoster against the live repo surface (not grep-assumed):
    // 'deep-research' ships as a top-level Claude Code skill, NOT under the
    // session-orchestrator: roster prefix, so it is genuinely off-roster.
    expect(roster.skills.has('deep-research')).toBe(false);
    expect(roster.skills.has('session-orchestrator:deep-research')).toBe(false);
    expect(roster.skills.has('session-orchestrator:session-start')).toBe(true);

    const sessionRecord = { session_type: 'deep', started_at: START, completed_at: START };
    const skillInvocations = [
      { timestamp: START, event: 'selected', skill: 'session-orchestrator:session-start', session_id: 'synthetic-e2e-1', schema_version: 1 },
      { timestamp: START, event: 'selected', skill: 'session-orchestrator:wave-executor', session_id: 'synthetic-e2e-1', schema_version: 1, phase: 'wave-1' },
      { timestamp: START, event: 'selected', skill: 'deep-research', session_id: 'synthetic-e2e-2', schema_version: 1 },
    ];

    const built = buildUsagePing({ sessionRecord, skillInvocations, env: {}, now: START, roster });
    expect(built.skills).toContain('session-orchestrator:session-start');
    expect(built.skills).toContain('session-orchestrator:wave-executor');
    expect(built.skills).toContain('other');
    expect(built.skills).not.toContain('deep-research');
  });
});
