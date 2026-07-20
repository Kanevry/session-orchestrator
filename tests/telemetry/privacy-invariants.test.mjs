/**
 * tests/telemetry/privacy-invariants.test.mjs — CROSS-MODULE privacy hardening
 * suite for anonymous usage telemetry (Epic #841; PRD
 * docs/prd/2026-07-20-anonymous-usage-telemetry.md §3 Edge Cases + FA2/FA3/FA4).
 *
 * Wave-2 unit tests already pin each module's own contract (schema.test.mjs,
 * consent.test.mjs, anon-id.test.mjs, queue.test.mjs, roster.test.mjs,
 * server.test.mjs). This file targets the invariants that ONLY show up when
 * modules are wired together the way production wiring does: the full
 * build→project chain, the consent gate ahead of the queue, and the
 * client-whitelist-vs-server-additive-tolerance boundary.
 *
 * Scope discipline: this file wires scripts/lib/telemetry/{consent,schema,
 * anon-id,queue}.mjs + server/ingest/{server,db}.mjs DIRECTLY. It deliberately
 * does NOT import scripts/lib/telemetry/sync.mjs or scripts/telemetry.mjs —
 * those are a sibling agent's in-flight work (P1) and are tested there.
 *
 * Isolation: every stateful test uses a fresh mkdtempSync directory injected
 * via each module's `{ path }` option. No personal host paths appear in any
 * fixture (PSA/testing.md discipline).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname, userInfo, homedir } from 'node:os';

import { buildUsagePing, projectUsagePing } from '../../scripts/lib/telemetry/schema.mjs';
import { resolveConsent, readTelemetryState, grantConsent } from '../../scripts/lib/telemetry/consent.mjs';
import { enqueue } from '../../scripts/lib/telemetry/queue.mjs';
import { createIngestServer } from '../../server/ingest/server.mjs';

const START = '2026-07-20T00:00:00.000Z';

/**
 * Mini send-flow mirroring the real caller's consent gate (PRD FA5): the
 * queue must never be written to when `consent.send` is false. Defined at
 * module scope (not inside an `it()` body) so the branching lives here, not
 * in the test's own control flow.
 */
function sendIfConsented(consent, batch, queuePath) {
  if (!consent.send) return 'skipped';
  enqueue(batch, { path: queuePath });
  return 'enqueued';
}

// ---------------------------------------------------------------------------
// 1 — End-to-end whitelist: buildUsagePing → projectUsagePing never leaks
//     poisoned fields planted on the session record or the invocations.
// ---------------------------------------------------------------------------

describe('cross-module chain: buildUsagePing -> projectUsagePing never leaks poisoned fields', () => {
  it('drops repo, cwd, git_remote, prompt, hostname, and email across the full construction chain', () => {
    const sessionRecord = {
      session_type: 'deep',
      started_at: START,
      completed_at: START,
      repo: 'secret-repo',
      cwd: '/home/eve/private',
      git_remote: 'git@host:x.git',
      prompt: 'user text',
      hostname: 'workstation-01',
      email: 'eve@example.com',
    };
    const skillInvocations = [
      {
        timestamp: START,
        event: 'selected',
        skill: 'session-orchestrator:session-start',
        session_id: 'synthetic-1',
        schema_version: 1,
        prompt: 'do the secret thing',
        cwd: '/home/eve/private',
      },
    ];
    const roster = { skills: new Set(['session-orchestrator:session-start']), commands: new Set() };

    const built = buildUsagePing({ sessionRecord, skillInvocations, env: {}, now: START, roster });
    const projected = projectUsagePing(built);

    // Assert on BOTH layers independently: `built` (buildUsagePing's own
    // output, pre-projection) and `projected`/serialized (post-whitelist).
    // A regression in EITHER layer alone must turn this red — projectUsagePing
    // must never be the only thing standing between buildUsagePing and a leak.
    const builtSerialized = JSON.stringify(built);
    const serialized = JSON.stringify(projected);

    expect(builtSerialized).not.toContain('secret-repo');
    expect(builtSerialized).not.toContain('/home/eve/private');
    expect(builtSerialized).not.toContain('git@host:x.git');
    expect(builtSerialized).not.toContain('user text');
    expect(builtSerialized).not.toContain('workstation-01');
    expect(builtSerialized).not.toContain('eve@example.com');
    expect(builtSerialized).not.toContain('do the secret thing');

    expect(serialized).not.toContain('secret-repo');
    expect(serialized).not.toContain('/home/eve/private');
    expect(serialized).not.toContain('git@host:x.git');
    expect(serialized).not.toContain('user text');
    expect(serialized).not.toContain('workstation-01');
    expect(serialized).not.toContain('eve@example.com');
    expect(serialized).not.toContain('do the secret thing');
  });
});

// ---------------------------------------------------------------------------
// 2 — Off-roster anonymization across the full chain.
// ---------------------------------------------------------------------------

describe('cross-module chain: off-roster skill names are anonymized end-to-end', () => {
  it('keeps the on-roster name, collapses off-roster names to "other", and never leaks their identifiers', () => {
    const sessionRecord = { session_type: 'feature', started_at: START, completed_at: START };
    const skillInvocations = [
      { timestamp: START, event: 'selected', skill: 'session-orchestrator:session-start', session_id: 's1', schema_version: 1 },
      { timestamp: START, event: 'selected', skill: 'my-secret-client-skill', session_id: 's1', schema_version: 1 },
      { timestamp: START, event: 'selected', skill: 'kundenname-workflow', session_id: 's1', schema_version: 1 },
    ];
    const roster = { skills: new Set(['session-orchestrator:session-start']), commands: new Set() };

    const built = buildUsagePing({ sessionRecord, skillInvocations, env: {}, now: START, roster });
    const projected = projectUsagePing(built);

    // Assert on buildUsagePing's own output too, not only the post-projection
    // result — projectUsagePing does not touch array CONTENT of an
    // already-whitelisted field, so this pins the roster filter itself.
    expect(built.skills).toEqual(['other', 'session-orchestrator:session-start']);
    expect(projected.skills).toEqual(['other', 'session-orchestrator:session-start']);

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('my-secret-client-skill');
    expect(serialized).not.toContain('kundenname-workflow');
  });
});

// ---------------------------------------------------------------------------
// 3 — No identity material anywhere in the projected payload.
// ---------------------------------------------------------------------------

describe('cross-module chain: no identity material survives the projection', () => {
  it('carries neither the test host hostname, nor the OS username, nor the home directory', () => {
    const sessionRecord = { session_type: 'housekeeping', started_at: START, completed_at: START };
    const roster = { skills: new Set(), commands: new Set() };
    const built = buildUsagePing({ sessionRecord, skillInvocations: [], env: {}, now: START, roster });
    const projected = projectUsagePing(built);
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(hostname());
    expect(serialized).not.toContain(userInfo().username);
    expect(serialized).not.toContain(homedir());
  });
});

// ---------------------------------------------------------------------------
// 4 — Server-side defense in depth. The ingest server is DELIBERATELY
//     additive (server/ingest/validate.mjs preserves unknown top-level
//     fields verbatim in raw_json for forward compatibility) — the real
//     privacy boundary is the CLIENT's whitelist projection, not the server.
//     These two tests document that split precisely.
// ---------------------------------------------------------------------------

describe('server-side defense in depth (additive server, client is the privacy boundary)', () => {
  let ctx;
  let base;

  beforeEach(async () => {
    ctx = createIngestServer({ dbPath: ':memory:' });
    await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
    const { port } = ctx.server.address();
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('the INDEXED columns never carry a poisoned value even for an unprojected record (additive tolerance is raw_json-only)', async () => {
    const poisoned = {
      record_kind: 'usage-ping',
      schema_version: 1,
      anon_id: '12345678-1234-4234-8234-123456789012',
      sent_at: START,
      plugin_version: '1.0.0',
      platform: 'claude',
      os: 'darwin',
      arch: 'arm64',
      node_major: 24,
      ci: false,
      fleet: false,
      session_type: 'deep',
      duration_bucket: '<15m',
      skills: [],
      commands: [],
      // Unknown top-level field — accepted by the server (forward compat) but
      // MUST never reach an indexed column.
      cwd: '/home/eve/private-poison',
    };

    const res = await fetch(`${base}/v1/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(poisoned),
    });
    expect(res.status).toBe(202);

    const rows = ctx.db.prepare('SELECT kind, anon_id, fleet, received_day FROM records').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('private-poison');
  });

  it('a record that was whitelist-projected client-side BEFORE POST carries no poison anywhere, including raw_json', async () => {
    const poisoned = {
      record_kind: 'usage-ping',
      schema_version: 1,
      anon_id: '87654321-4321-4321-8321-210987654321',
      sent_at: START,
      plugin_version: '1.0.0',
      platform: 'claude',
      os: 'darwin',
      arch: 'arm64',
      node_major: 24,
      ci: false,
      fleet: false,
      session_type: 'deep',
      duration_bucket: '<15m',
      skills: [],
      commands: [],
      cwd: '/home/eve/private-poison',
    };
    const projected = projectUsagePing(poisoned);
    expect('cwd' in projected).toBe(false);

    const res = await fetch(`${base}/v1/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projected),
    });
    expect(res.status).toBe(202);

    const rows = ctx.db.prepare('SELECT raw_json FROM records').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].raw_json).not.toContain('private-poison');
  });
});

// ---------------------------------------------------------------------------
// 5 — Consent-gate chain: DO_NOT_TRACK blocks the queue write even with a
//     stored granted consent AND a fleet-enabled owner.yaml.
// ---------------------------------------------------------------------------

describe('consent-gate chain: DO_NOT_TRACK blocks enqueue despite granted consent + fleet', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'so-telemetry-privacy-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolveConsent send=false short-circuits before queue.enqueue is ever invoked', () => {
    const statePath = join(tmp, 'telemetry.json');
    const queuePath = join(tmp, 'telemetry-queue.ndjson');

    grantConsent({ path: statePath, now: START });
    const { record } = readTelemetryState({ path: statePath });

    const consent = resolveConsent({
      env: { DO_NOT_TRACK: '1' },
      ownerConfig: { telemetry: { enabled: true } },
      state: record,
      interactive: false,
    });
    expect(consent.state).toBe('disabled-env');
    expect(consent.send).toBe(false);

    const outcome = sendIfConsented(consent, { some: 'batch' }, queuePath);
    expect(outcome).toBe('skipped');
    expect(existsSync(queuePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6 — Consent-gate chain: a corrupt telemetry.json fails closed through to
//     the queue, without throwing.
// ---------------------------------------------------------------------------

describe('consent-gate chain: corrupt state fails closed through to the queue', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'so-telemetry-privacy-corrupt-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a corrupt state file resolves to send=false and the mini send-flow never enqueues, without throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const statePath = join(tmp, 'telemetry.json');
    const queuePath = join(tmp, 'telemetry-queue.ndjson');
    writeFileSync(statePath, 'not json at all {{{', 'utf8');

    const { record, source } = readTelemetryState({ path: statePath });
    expect(source).toBe('corrupt');

    const consent = resolveConsent({ env: {}, ownerConfig: {}, state: record, interactive: false });
    expect(consent.send).toBe(false);

    const outcome = sendIfConsented(consent, { some: 'batch' }, queuePath);

    expect(outcome).toBe('skipped');
    expect(existsSync(queuePath)).toBe(false);
  });
});
