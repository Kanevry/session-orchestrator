/**
 * tests/telemetry/sync.test.mjs
 *
 * Coverage for scripts/lib/telemetry/sync.mjs — the batch build + offline-tolerant
 * sync engine (Epic #841, Issue #844 / S3 FA3) — plus the hook-side daily-fallback
 * trigger `maybeSpawnDailyFlush` exported from hooks/skill-invocation-telemetry.mjs.
 *
 * Isolation contract:
 *   - Every test injects mkdtempSync paths (metricsDir / statePath / queuePath);
 *     no test ever touches the real ~/.config/session-orchestrator state.
 *   - The sender is injected (spy) for every path EXCEPT the one endpoint-override
 *     test, which stands up a local 127.0.0.1 node:http server — never real network.
 *   - `env` is always passed explicitly so ambient DO_NOT_TRACK / SO_TELEMETRY do
 *     not leak into consent resolution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

import {
  flush,
  buildBatch,
  shouldDailyFlush,
  TELEMETRY_ENDPOINT,
  POST_TIMEOUT_MS,
} from '@lib/telemetry/sync.mjs';
import { readTelemetryState } from '@lib/telemetry/consent.mjs';
import { enqueue, queueStats, peekAll } from '@lib/telemetry/queue.mjs';
import { maybeSpawnDailyFlush } from '../../hooks/skill-invocation-telemetry.mjs';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = '2026-07-20T10:00:00.000Z';

let tmpDir;
let metricsDir;
let statePath;
let queuePath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'telemetry-sync-'));
  metricsDir = join(tmpDir, 'metrics');
  statePath = join(tmpDir, 'telemetry.json');
  queuePath = join(tmpDir, 'telemetry-queue.ndjson');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedMetrics({ sessions = [], invocations = [] } = {}) {
  mkdirSync(metricsDir, { recursive: true });
  writeFileSync(
    join(metricsDir, 'sessions.jsonl'),
    sessions.length ? `${sessions.map((s) => JSON.stringify(s)).join('\n')}\n` : '',
  );
  writeFileSync(
    join(metricsDir, 'skill-invocations.jsonl'),
    invocations.length ? `${invocations.map((s) => JSON.stringify(s)).join('\n')}\n` : '',
  );
}

function seedState(record) {
  writeFileSync(statePath, JSON.stringify(record));
}

/** A representative completed session + a single in-window skill invocation. */
function grantedFixture(extraState = {}) {
  seedMetrics({
    sessions: [
      {
        schema_version: 1,
        session_id: 's1',
        session_type: 'feature',
        started_at: '2026-07-20T09:00:00.000Z',
        completed_at: '2026-07-20T09:30:00.000Z',
      },
    ],
    invocations: [
      {
        timestamp: '2026-07-20T09:10:00.000Z',
        event: 'selected',
        skill: 'session-orchestrator:discovery',
        session_id: 's1',
        schema_version: 1,
      },
    ],
  });
  seedState({
    schema_version: 1,
    consent: 'granted',
    decided_at: '2026-07-01T00:00:00.000Z',
    anon_id: null,
    anon_id_created_at: null,
    last_flush_at: null,
    ...extraState,
  });
}

// ---------------------------------------------------------------------------
// Exported contract constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('TELEMETRY_ENDPOINT points at the v1 ingest path', () => {
    expect(TELEMETRY_ENDPOINT).toBe('https://telemetry.session-orchestrator.com/v1/records');
  });

  it('POST_TIMEOUT_MS is 3000', () => {
    expect(POST_TIMEOUT_MS).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// 1. flush — gated (no consent): nothing sent, nothing queued, no ID minted
// ---------------------------------------------------------------------------

describe('flush — consent gate (outermost seam)', () => {
  it('sends nothing, queues nothing, and mints no anon_id when consent is absent', async () => {
    // No telemetry.json on disk, no env opt-in → resolveConsent → no-consent.
    seedMetrics({ invocations: [{ timestamp: NOW, skill: 'session-orchestrator:plan' }] });
    const sender = vi.fn().mockResolvedValue(undefined);

    const result = await flush({ env: {}, sender, metricsDir, statePath, queuePath, now: NOW });

    expect(result).toEqual({ sent: false, queued: false, state: 'no-consent', reason: 'gated' });
    expect(sender).not.toHaveBeenCalled();
    expect(queueStats({ path: queuePath }).count).toBe(0);
    // telemetry.json must be untouched — no anon_id lazily minted below the gate.
    expect(existsSync(statePath)).toBe(false);
  });

  it('is gated by DO_NOT_TRACK even when consent was granted', async () => {
    grantedFixture();
    const sender = vi.fn().mockResolvedValue(undefined);

    const result = await flush({
      env: { DO_NOT_TRACK: '1' },
      sender,
      metricsDir,
      statePath,
      queuePath,
      now: NOW,
    });

    expect(result.sent).toBe(false);
    expect(result.state).toBe('disabled-env');
    expect(sender).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. flush — granted + 2xx sender: sent, queue empty, last_flush_at + anon_id
// ---------------------------------------------------------------------------

describe('flush — success path', () => {
  it('sends, empties the queue, stamps last_flush_at, and mints + persists an anon_id', async () => {
    grantedFixture();
    const sender = vi.fn().mockResolvedValue(undefined);

    const result = await flush({ env: {}, sender, metricsDir, statePath, queuePath, now: NOW });

    expect(result.sent).toBe(true);
    expect(result.queued).toBe(false);
    expect(result.reason).toBe('sent');

    expect(sender).toHaveBeenCalledTimes(1);
    const batches = sender.mock.calls[0][0];
    expect(Array.isArray(batches)).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0].record_kind).toBe('usage-ping');

    // Persisted state: last_flush_at == now, a fresh anon_id, queue emptied.
    const persisted = readTelemetryState({ path: statePath }).record;
    expect(persisted.last_flush_at).toBe(NOW);
    expect(typeof persisted.anon_id).toBe('string');
    expect(persisted.anon_id.length).toBeGreaterThan(0);
    expect(persisted.anon_id_created_at).toBe(NOW);
    // The wire record carries the same freshly-minted id.
    expect(batches[0].anon_id).toBe(persisted.anon_id);
    expect(queueStats({ path: queuePath }).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. flush — rejecting sender: record queued, no throw
// ---------------------------------------------------------------------------

describe('flush — offline queue on send failure', () => {
  it('queues the record and never throws when the sender rejects', async () => {
    grantedFixture();
    const sender = vi.fn().mockRejectedValue(new Error('network down'));

    const result = await flush({ env: {}, sender, metricsDir, statePath, queuePath, now: NOW });

    expect(result.sent).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.reason).toBe('queued');

    const entries = peekAll({ path: queuePath });
    expect(entries).toHaveLength(1);
    expect(entries[0].batch.record_kind).toBe('usage-ping');
  });
});

// ---------------------------------------------------------------------------
// 4. flush — SO_TELEMETRY_DEBUG=1: payload to stderr, sender never called
// ---------------------------------------------------------------------------

describe('flush — debug seam', () => {
  it('prints the payload to stderr and does not send under SO_TELEMETRY_DEBUG=1', async () => {
    grantedFixture();
    const sender = vi.fn().mockResolvedValue(undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await flush({
      env: { SO_TELEMETRY_DEBUG: '1' },
      sender,
      metricsDir,
      statePath,
      queuePath,
      now: NOW,
    });

    expect(result.reason).toBe('debug');
    expect(result.sent).toBe(false);
    expect(sender).not.toHaveBeenCalled();

    const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('usage-ping');
  });
});

// ---------------------------------------------------------------------------
// 5. flush — queue drain: 2 queued + 1 new sent as one array of 3
// ---------------------------------------------------------------------------

describe('flush — queue drain', () => {
  it('sends the existing queue plus the new record in one array, then clears', async () => {
    grantedFixture();
    enqueue({ record_kind: 'usage-ping', anon_id: 'q1' }, { path: queuePath });
    enqueue({ record_kind: 'usage-ping', anon_id: 'q2' }, { path: queuePath });
    expect(queueStats({ path: queuePath }).count).toBe(2);

    const sender = vi.fn().mockResolvedValue(undefined);
    const result = await flush({ env: {}, sender, metricsDir, statePath, queuePath, now: NOW });

    expect(result.sent).toBe(true);
    expect(sender).toHaveBeenCalledTimes(1);
    const batches = sender.mock.calls[0][0];
    expect(batches).toHaveLength(3);
    expect(queueStats({ path: queuePath }).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. shouldDailyFlush — empty / fresh / aged matrix
// ---------------------------------------------------------------------------

describe('shouldDailyFlush', () => {
  it('is false when the queue is empty', () => {
    seedState({ schema_version: 1, last_flush_at: null });
    expect(shouldDailyFlush({ statePath, queuePath, now: Date.parse(NOW) })).toBe(false);
  });

  it('is false when the last flush is fresh (< 24h ago)', () => {
    enqueue({ record_kind: 'usage-ping' }, { path: queuePath });
    seedState({ schema_version: 1, last_flush_at: NOW });
    expect(shouldDailyFlush({ statePath, queuePath, now: Date.parse(NOW) })).toBe(false);
  });

  it('is true when the queue is non-empty and the last flush is > 24h old', () => {
    enqueue({ record_kind: 'usage-ping' }, { path: queuePath });
    const nowMs = Date.parse(NOW);
    seedState({ schema_version: 1, last_flush_at: new Date(nowMs - DAY_MS - 1000).toISOString() });
    expect(shouldDailyFlush({ statePath, queuePath, now: nowMs })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. flush — anon-ID rotation end-to-end (91-day-old id)
// ---------------------------------------------------------------------------

describe('flush — anon-ID rotation', () => {
  it('rotates an id older than 90 days and persists the fresh one in the payload', async () => {
    const nowMs = Date.parse(NOW);
    grantedFixture({
      anon_id: 'stale-0000-old',
      anon_id_created_at: new Date(nowMs - 91 * DAY_MS).toISOString(),
    });
    const sender = vi.fn().mockResolvedValue(undefined);

    const result = await flush({ env: {}, sender, metricsDir, statePath, queuePath, now: NOW });

    expect(result.sent).toBe(true);
    const persisted = readTelemetryState({ path: statePath }).record;
    expect(persisted.anon_id).not.toBe('stale-0000-old');
    expect(persisted.anon_id_created_at).toBe(NOW);

    const batches = sender.mock.calls[0][0];
    expect(batches[0].anon_id).toBe(persisted.anon_id);
    expect(batches[0].anon_id).not.toBe('stale-0000-old');
  });
});

// ---------------------------------------------------------------------------
// 8. flush — SO_TELEMETRY_ENDPOINT override drives the default network sender
// ---------------------------------------------------------------------------

describe('flush — endpoint override (default sender against a local server)', () => {
  it('POSTs the batch array to SO_TELEMETRY_ENDPOINT and clears on 2xx', async () => {
    grantedFixture();

    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { received.push({ method: req.method, url: req.url, body: JSON.parse(body) }); }
        catch { received.push({ method: req.method, url: req.url, body }); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
      const result = await flush({
        env: { SO_TELEMETRY_ENDPOINT: `http://127.0.0.1:${port}/v1/records` },
        metricsDir,
        statePath,
        queuePath,
        now: NOW,
      });

      expect(result.sent).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('POST');
      expect(received[0].url).toBe('/v1/records');
      expect(Array.isArray(received[0].body)).toBe(true);
      expect(received[0].body).toHaveLength(1);
      expect(received[0].body[0].record_kind).toBe('usage-ping');
      expect(queueStats({ path: queuePath }).count).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ---------------------------------------------------------------------------
// buildBatch — session-window vs 24h-fallback selection
// ---------------------------------------------------------------------------

describe('buildBatch — window selection', () => {
  it('scopes invocations to the last session record and honors its session_type', () => {
    seedMetrics({
      sessions: [
        { session_type: 'deep', started_at: '2026-07-20T09:00:00.000Z', completed_at: '2026-07-20T13:30:00.000Z' },
      ],
      invocations: [
        { timestamp: '2026-07-20T08:00:00.000Z', skill: 'session-orchestrator:plan' }, // before window → dropped
        { timestamp: '2026-07-20T09:15:00.000Z', skill: 'session-orchestrator:discovery' }, // in window
      ],
    });

    const { record } = buildBatch({ env: {}, metricsDir, statePath, now: NOW, persist: false });

    expect(record.session_type).toBe('deep');
    expect(record.duration_bucket).toBe('>3h');
    // The pre-window invocation is excluded; only the in-window skill survives.
    expect(record.skills).toContain('session-orchestrator:discovery');
    expect(record.skills).not.toContain('session-orchestrator:plan');
  });

  it('falls back to session_type "other" and a 24h window when no session record exists', () => {
    const nowMs = Date.parse(NOW);
    seedMetrics({
      invocations: [
        { timestamp: new Date(nowMs - 2 * DAY_MS).toISOString(), skill: 'session-orchestrator:plan' }, // > 24h → dropped
        { timestamp: new Date(nowMs - 1000).toISOString(), skill: 'session-orchestrator:discovery' }, // recent
      ],
    });

    const { record } = buildBatch({ env: {}, metricsDir, statePath, now: NOW, persist: false });

    expect(record.session_type).toBe('other');
    expect(record.duration_bucket).toBe('<15m');
    expect(record.skills).toContain('session-orchestrator:discovery');
    expect(record.skills).not.toContain('session-orchestrator:plan');
  });

  it('persist:false shows an anon_id placeholder and never writes telemetry.json', () => {
    seedMetrics({ invocations: [{ timestamp: NOW, skill: 'session-orchestrator:plan' }] });

    const { record } = buildBatch({ env: {}, metricsDir, statePath, now: NOW, persist: false });

    expect(record.anon_id).toBe('(generated on first send)');
    expect(existsSync(statePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maybeSpawnDailyFlush — hook-side daily fallback (spawnFn injected)
// ---------------------------------------------------------------------------

describe('maybeSpawnDailyFlush', () => {
  it('never spawns when SO_TELEMETRY_DISABLED=1 (cheapest env gate)', () => {
    // Even with a due, granted backlog present, the env kill-switch wins first.
    enqueue({ record_kind: 'usage-ping' }, { path: queuePath });
    seedState({ schema_version: 1, consent: 'granted', last_flush_at: null });
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));

    const res = maybeSpawnDailyFlush({
      env: { SO_TELEMETRY_DISABLED: '1' },
      spawnFn,
      statePath,
      queuePath,
      now: Date.parse(NOW),
    });

    expect(res).toEqual({ spawned: false, reason: 'disabled-env' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('does not spawn when the queue is empty (not due)', () => {
    seedState({ schema_version: 1, consent: 'granted', last_flush_at: null });
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));

    const res = maybeSpawnDailyFlush({ env: {}, spawnFn, statePath, queuePath, now: Date.parse(NOW) });

    expect(res).toEqual({ spawned: false, reason: 'not-due' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns a detached _flush child when due and consent resolves to send', () => {
    enqueue({ record_kind: 'usage-ping' }, { path: queuePath });
    seedState({ schema_version: 1, consent: 'granted', last_flush_at: null });
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ unref }));

    const res = maybeSpawnDailyFlush({ env: {}, spawnFn, statePath, queuePath, now: Date.parse(NOW) });

    expect(res).toEqual({ spawned: true, reason: 'spawned' });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnFn.mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(args[1]).toBe('_flush');
    expect(args[0]).toContain('telemetry.mjs');
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
