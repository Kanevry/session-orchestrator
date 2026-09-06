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
  detectSandbox,
  deriveSessionFromEvents,
  TELEMETRY_ENDPOINT,
  POST_TIMEOUT_MS,
} from '@lib/telemetry/sync.mjs';
import { TELEMETRY_DIR } from '@lib/telemetry/paths.mjs';
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
    // No telemetry.json on disk, no env opt-in, and an INJECTED empty owner.yaml
    // (ownerConfig: {}) so the host's real owner.yaml fleet flag can never leak in —
    // otherwise a host with telemetry.enabled: true legitimately flips this to enabled-fleet.
    seedMetrics({ invocations: [{ timestamp: NOW, skill: 'session-orchestrator:plan' }] });
    const sender = vi.fn().mockResolvedValue(undefined);

    const result = await flush({ env: {}, ownerConfig: {}, sender, metricsDir, statePath, queuePath, now: NOW });

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
  // metricsDir is passed EVERYWHERE below: without it the predicate falls back
  // to `<cwd>/.orchestrator/metrics`, i.e. this repo's real session ledger,
  // and the catch-up disjunct would answer from live host state.

  it('is false when the queue is empty and no session completed since the last flush', () => {
    seedMetrics({
      sessions: [{ session_id: 's0', completed_at: '2026-07-19T00:00:00.000Z' }],
    });
    seedState({ schema_version: 1, last_flush_at: '2026-07-19T12:00:00.000Z' });
    expect(shouldDailyFlush({ statePath, queuePath, metricsDir, now: Date.parse(NOW) })).toBe(false);
  });

  it('is false when the last flush is fresh (< 24h ago)', () => {
    enqueue({ record_kind: 'usage-ping' }, { path: queuePath });
    seedState({ schema_version: 1, last_flush_at: NOW });
    expect(shouldDailyFlush({ statePath, queuePath, metricsDir, now: Date.parse(NOW) })).toBe(false);
  });

  it('is true when the queue is non-empty and the last flush is > 24h old', () => {
    enqueue({ record_kind: 'usage-ping' }, { path: queuePath });
    const nowMs = Date.parse(NOW);
    seedState({ schema_version: 1, last_flush_at: new Date(nowMs - DAY_MS - 1000).toISOString() });
    expect(shouldDailyFlush({ statePath, queuePath, metricsDir, now: nowMs })).toBe(true);
  });

  // #1138 — the catch-up disjunct. Before it, an EMPTY queue short-circuited to
  // false, so the "daily fallback" could only ever RETRY a send that had already
  // failed; it could never originate one. On a host where flush() simply never
  // ran, the queue stays empty forever and the fallback never fires — which is
  // the mechanism behind the measured 82 records for 588 closes.
  it('is true when the queue is EMPTY but a session completed after the last flush', () => {
    const nowMs = Date.parse(NOW);
    seedMetrics({
      sessions: [
        { session_id: 's0', completed_at: '2026-07-01T00:00:00.000Z' },
        { session_id: 's1', completed_at: '2026-07-19T20:00:00.000Z' },
      ],
    });
    seedState({ schema_version: 1, last_flush_at: '2026-07-19T00:00:00.000Z' });

    expect(queueStats({ path: queuePath }).count).toBe(0);
    expect(shouldDailyFlush({ statePath, queuePath, metricsDir, now: nowMs })).toBe(true);
  });

  it('is false when the empty-queue host has never had a session complete at all', () => {
    seedMetrics({ sessions: [] });
    seedState({ schema_version: 1, last_flush_at: null });
    expect(shouldDailyFlush({ statePath, queuePath, metricsDir, now: Date.parse(NOW) })).toBe(false);
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
        // session_id is required for the record to survive readCanonicalSessions'
        // #1167 collapse (id-less records cannot be deduplicated and are dropped) —
        // every production record carries one (REQUIRED_FIELDS), so this fixture
        // matches what the writer actually emits.
        { session_id: 's-deep', session_type: 'deep', started_at: '2026-07-20T09:00:00.000Z', completed_at: '2026-07-20T13:30:00.000Z' },
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

  // #1234 — RENAMED + RE-ASSERTED. This case previously asserted `'other'`, which
  // pinned the defect: a ping built with NO session source was indistinguishable
  // on the wire from one that measured an unusual session. `unknown` is now the
  // not-measured token and `other` keeps its measured-but-unrecognised meaning
  // (tests/lib/telemetry/fleet-and-session-record.test.mjs holds both cases).
  it('falls back to session_type "unknown" and a 24h window when no session record exists', () => {
    const nowMs = Date.parse(NOW);
    seedMetrics({
      invocations: [
        { timestamp: new Date(nowMs - 2 * DAY_MS).toISOString(), skill: 'session-orchestrator:plan' }, // > 24h → dropped
        { timestamp: new Date(nowMs - 1000).toISOString(), skill: 'session-orchestrator:discovery' }, // recent
      ],
    });

    const { record } = buildBatch({ env: {}, metricsDir, statePath, now: NOW, persist: false });

    expect(record.session_type).toBe('unknown');
    expect(record.session_record).toBe('absent');
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
// buildBatch — #1186 canonical dedupe (readCanonicalSessions, not raw tail)
// ---------------------------------------------------------------------------

describe('buildBatch — #1186 canonical dedupe', () => {
  it('picks the true most-recent session even when a stale duplicate re-append is the last physical line', () => {
    seedMetrics({
      sessions: [
        // s-A's first (stale) write.
        { session_id: 's-A', session_type: 'housekeeping', started_at: '2026-07-20T05:00:00.000Z', completed_at: '2026-07-20T05:10:00.000Z' },
        // s-B — the actual most-recently-completed session in the ledger.
        { session_id: 's-B', session_type: 'deep', started_at: '2026-07-20T09:00:00.000Z', completed_at: '2026-07-20T13:30:00.000Z' },
        // s-A re-appended (e.g. a crash-recovery rewrite) — physically the
        // LAST line in the file, but its completed_at is still older than s-B's.
        { session_id: 's-A', session_type: 'housekeeping', started_at: '2026-07-20T05:00:00.000Z', completed_at: '2026-07-20T05:12:00.000Z' },
      ],
    });

    const { record } = buildBatch({ env: {}, metricsDir, statePath, now: NOW, persist: false });

    // Pre-#1186 buildBatch read `sessions[sessions.length - 1]` — the raw last
    // LINE — which is s-A's stale re-append, not the session that actually
    // completed most recently.
    expect(record.session_type).toBe('deep');
  });
});

// ---------------------------------------------------------------------------
// shouldDailyFlush — #1186 canonical dedupe (readCanonicalSessions tail)
// ---------------------------------------------------------------------------

describe('shouldDailyFlush — #1186 canonical dedupe', () => {
  it('is due when the true most-recently-completed session outranks a stale duplicate at the tail', () => {
    const nowMs = Date.parse(NOW);
    seedMetrics({
      sessions: [
        // The real most-recent completion, ahead of the last flush.
        { session_id: 's-recent', completed_at: '2026-07-19T20:00:00.000Z' },
        // A stale re-append of an OLDER session, sitting last in the file —
        // pre-#1186 this raw-last-line record (older than last_flush_at) hid
        // s-recent's completion from the catch-up check entirely.
        { session_id: 's-old', completed_at: '2026-07-18T00:00:00.000Z' },
      ],
    });
    seedState({ schema_version: 1, last_flush_at: '2026-07-19T00:00:00.000Z' });

    expect(shouldDailyFlush({ statePath, queuePath, metricsDir, now: nowMs })).toBe(true);
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
      metricsDir,
      now: Date.parse(NOW),
    });

    expect(res).toEqual({ spawned: false, reason: 'disabled-env' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('does not spawn when the queue is empty and nothing completed since (not due)', () => {
    seedMetrics({ sessions: [] });
    seedState({ schema_version: 1, consent: 'granted', last_flush_at: null });
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));

    const res = maybeSpawnDailyFlush({ env: {}, spawnFn, statePath, queuePath, metricsDir, now: Date.parse(NOW) });

    expect(res).toEqual({ spawned: false, reason: 'not-due' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  // #1138 — the hook-side half of the catch-up disjunct: an empty queue plus a
  // freshly completed session is now due, so a host that has never flushed at
  // all finally originates one.
  it('spawns on an EMPTY queue when a session completed after the last flush', () => {
    seedMetrics({ sessions: [{ session_id: 's1', completed_at: '2026-07-19T20:00:00.000Z' }] });
    seedState({
      schema_version: 1,
      consent: 'granted',
      last_flush_at: '2026-07-19T00:00:00.000Z',
    });
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));

    const res = maybeSpawnDailyFlush({ env: {}, spawnFn, statePath, queuePath, metricsDir, now: Date.parse(NOW) });

    expect(res).toEqual({ spawned: true, reason: 'spawned' });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('spawns a detached _flush child when due and consent resolves to send', () => {
    enqueue({ record_kind: 'usage-ping' }, { path: queuePath });
    seedState({ schema_version: 1, consent: 'granted', last_flush_at: null });
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ unref }));

    const res = maybeSpawnDailyFlush({ env: {}, spawnFn, statePath, queuePath, metricsDir, now: Date.parse(NOW) });

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

// ---------------------------------------------------------------------------
// GitLab #1234 — sandbox send-refusal guard (merged in from the misplaced
// tests/lib/telemetry/sandbox-guard.test.mjs; that directory does not exist in
// this repo, tests/telemetry/ is the home of the telemetry suite).
//
// THE BUG THESE TESTS NAME: **Wave-1 sandbox runs sent 6 production pings with a
// wrong session_type on 2026-09-06.** Six agent sandboxes executed
// hooks/on-session-end.mjs from the repo checkout at 11:02:50–11:03:36Z. Each
// resolved the operator's REAL anon_id and REAL consent out of
// ~/.config/session-orchestrator/telemetry.json — telemetry/paths.mjs computes
// that path from homedir() and never consults SO_CONFIG_HOME — while owner.yaml
// was unreachable and sessions.jsonl absent. Six real records landed on the
// ingest server attributed to a real person, all session_type: "other", fleet: 0.
//
// Existing coverage could not have caught it: every other test in this file
// injects statePath/sender, so none exercises the shape where the state path is
// DEFAULT while the config home has been redirected — the shape a sandbox has.
//
// NOTHING HERE TOUCHES THE NETWORK: flush() is always called with an injected
// sender that records its calls, and every case asserts it was never invoked.
// ---------------------------------------------------------------------------

/** A cwd that is definitely NOT under a temp root, so condition (c) stays quiet. */
const REAL_CWD = process.cwd();

describe('detectSandbox — the three refusal conditions', () => {
  it('(a) refuses under SO_TELEMETRY_DISABLED=1', () => {
    const r = detectSandbox({
      env: { SO_TELEMETRY_DISABLED: '1' },
      statePath: join(tmpDir, 'telemetry.json'),
      cwd: REAL_CWD,
    });
    expect(r).toEqual({ sandbox: true, reason: 'sandbox:telemetry-disabled' });
  });

  it('(a) refuses under DO_NOT_TRACK, and NOT under its falsy spellings', () => {
    const at = (DO_NOT_TRACK) =>
      detectSandbox({ env: { DO_NOT_TRACK }, statePath: join(tmpDir, 's.json'), cwd: REAL_CWD }).sandbox;
    expect(at('1')).toBe(true);
    expect(at('true')).toBe(true);
    expect(at('0')).toBe(false);
    expect(at('false')).toBe(false);
    expect(at('')).toBe(false);
  });

  it('(b) THE Wave-1 SHAPE: SO_CONFIG_HOME declared, state still read from outside it', () => {
    // Config home redirected, state path NOT redirected → the sender reads the
    // operator's real telemetry.json regardless. Exactly what happened.
    const r = detectSandbox({ env: { SO_CONFIG_HOME: join(tmpDir, 'fake-config') }, cwd: REAL_CWD });
    expect(r).toEqual({ sandbox: true, reason: 'sandbox:config-home-split' });
  });

  it('(b) fires when the state path was redirected somewhere ELSE than the declared home', () => {
    const r = detectSandbox({
      env: { SO_CONFIG_HOME: join(tmpDir, 'declared') },
      statePath: join(tmpDir, 'somewhere-else', 'telemetry.json'),
      cwd: REAL_CWD,
    });
    expect(r).toEqual({ sandbox: true, reason: 'sandbox:config-home-split' });
  });

  it('(b) does NOT fire when the caller redirected CONSISTENTLY (hermetic-test shape)', () => {
    const r = detectSandbox({
      env: { SO_CONFIG_HOME: join(tmpDir, 'fake-config') },
      statePath: join(tmpDir, 'fake-config', 'telemetry.json'),
      cwd: REAL_CWD,
    });
    expect(r.sandbox).toBe(false);
  });

  it('(b) does NOT fire on an undeclared default — that is the normal case, not a split', () => {
    expect(detectSandbox({ env: {}, cwd: REAL_CWD }).sandbox).toBe(false);
    expect(detectSandbox({ env: { SO_CONFIG_HOME: TELEMETRY_DIR }, cwd: REAL_CWD }).sandbox).toBe(false);
  });

  it('(c) refuses a temp-root project while the identity is the REAL one', () => {
    // No statePath → the real ~/.config/session-orchestrator/telemetry.json is
    // the identity at stake. Uses a REAL mkdtemp path, so this also proves the
    // macOS /var/folders → /private/var/folders realpath hop is handled: a raw
    // prefix comparison against os.tmpdir() misses every macOS sandbox.
    expect(detectSandbox({ env: { CLAUDE_PROJECT_DIR: tmpDir } }))
      .toEqual({ sandbox: true, reason: 'sandbox:temp-root' });
    expect(detectSandbox({ env: {}, cwd: tmpDir }))
      .toEqual({ sandbox: true, reason: 'sandbox:temp-root' });
  });

  it('(c) does NOT fire when the IDENTITY is throwaway too — a properly isolated harness', () => {
    // This repo's isolation convention (tests/_helpers/telemetry-isolation.mjs)
    // points HOME at a tmp dir, so both the project AND the telemetry state live
    // under the temp root. Nothing of the operator's can leak, so the send is
    // permitted — otherwise the guard would break every telemetry e2e test.
    const r = detectSandbox({ env: {}, statePath: join(tmpDir, 'telemetry.json'), cwd: tmpDir });
    expect(r).toEqual({ sandbox: false, reason: null });
  });

  it('permits a real operator shape (no env redirect, real checkout)', () => {
    expect(detectSandbox({ env: {}, cwd: REAL_CWD })).toEqual({ sandbox: false, reason: null });
  });
});

describe('flush — a sandbox refusal performs NO network call and NO queue mutation', () => {
  /** Consent granted on disk, so the refusal cannot be attributed to the consent gate. */
  function grantedState(dir) {
    const p = join(dir, 'telemetry.json');
    writeFileSync(p, JSON.stringify({ schema_version: 1, consent: 'granted' }));
    return p;
  }

  it('refuses a config-home-split run that has full consent — sender never called, queue untouched', async () => {
    const sandboxStatePath = grantedState(tmpDir);
    const sandboxQueuePath = join(tmpDir, 'sandbox-queue.ndjson');
    mkdirSync(metricsDir, { recursive: true });

    const calls = [];
    const res = await flush({
      // Declared config home ≠ where the state actually is: the Wave-1 shape.
      env: { SO_CONFIG_HOME: join(tmpDir, 'declared-elsewhere') },
      ownerConfig: {},
      statePath: sandboxStatePath,
      queuePath: sandboxQueuePath,
      metricsDir,
      sender: async (batches) => { calls.push(batches); },
    });

    expect(res.sent).toBe(false);
    expect(res.queued).toBe(false);
    expect(res.reason).toBe('sandbox:config-home-split');
    // The load-bearing half: no send, and nothing written to the queue either.
    expect(calls).toEqual([]);
    expect(existsSync(sandboxQueuePath)).toBe(false); // queue file was never created
  });

  it('SO_TELEMETRY_DISABLED is refused by the consent gate BEFORE the sandbox guard (existing behaviour, re-verified)', async () => {
    const sandboxStatePath = grantedState(tmpDir);
    const calls = [];
    const res = await flush({
      env: { SO_TELEMETRY_DISABLED: '1' },
      ownerConfig: {},
      statePath: sandboxStatePath,
      queuePath: join(tmpDir, 'q.ndjson'),
      metricsDir: join(tmpDir, 'metrics'),
      sender: async (b) => { calls.push(b); },
    });
    expect(res).toMatchObject({ sent: false, queued: false, state: 'disabled-env', reason: 'gated' });
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GitLab #1234 BUG 2 — a ping with NO session source was indistinguishable from
// a measured one. buildBatch keyed exclusively on sessions.jsonl; when it was
// absent `sessionForPing` was {} and the ping reported session_type: "other" /
// duration_bucket: "<15m" — values that read as measurements. This repo has no
// sessions.jsonl at all, which is how 32 such pings reached the server.
// (Merged in from the misplaced tests/lib/telemetry/fleet-and-session-record.test.mjs.)
// ---------------------------------------------------------------------------

/** Write an events.jsonl into `dir` (the fallback source when sessions.jsonl is absent). */
function writeEvents(dir, records) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('session facts survive a missing sessions.jsonl (deriveSessionFromEvents)', () => {
  it('derives type + window from orchestrator.session.started', () => {
    writeEvents(tmpDir, [
      { timestamp: '2026-09-06T08:00:00.000Z', event: 'orchestrator.session.started', mode: 'deep' },
      { timestamp: '2026-09-06T11:30:00.000Z', event: 'orchestrator.agent.stopped' },
    ]);
    expect(deriveSessionFromEvents(tmpDir)).toEqual({
      session: {
        session_type: 'deep',
        started_at: '2026-09-06T08:00:00.000Z',
        completed_at: '2026-09-06T11:30:00.000Z',
      },
      source: 'derived',
    });
  });

  it('reports `absent` — never a fabricated type — when events.jsonl does not exist', () => {
    expect(deriveSessionFromEvents(join(tmpDir, 'nope'))).toEqual({ session: {}, source: 'absent' });
  });

  it('a started event with NO mode yields a window but no type (never invents one)', () => {
    writeEvents(tmpDir, [{ timestamp: '2026-09-06T08:00:00.000Z', event: 'orchestrator.session.started' }]);
    const { session } = deriveSessionFromEvents(tmpDir);
    expect('session_type' in session).toBe(false);
    expect(session.started_at).toBe('2026-09-06T08:00:00.000Z');
  });
});

describe('buildBatch marks the provenance of every ping', () => {
  const PROV_NOW = '2026-09-06T12:00:00.000Z';
  const common = { env: {}, ownerConfig: {}, now: PROV_NOW, persist: false };

  function grantedStatePath() {
    const p = join(tmpDir, 'provenance-telemetry.json');
    writeFileSync(p, JSON.stringify({ schema_version: 1, consent: 'granted', anon_id: '11111111-2222-4333-8444-555555555555' }));
    return p;
  }

  it('ledger present → session_record "ledger"', () => {
    const dir = join(tmpDir, 'm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sessions.jsonl'), JSON.stringify({
      session_id: 's1', session_type: 'feature',
      started_at: '2026-09-06T08:00:00.000Z', completed_at: '2026-09-06T11:00:00.000Z',
    }) + '\n');
    const { record } = buildBatch({ ...common, metricsDir: dir, statePath: grantedStatePath() });
    expect(record.session_record).toBe('ledger');
    expect(record.session_type).toBe('feature');
  });

  it('THE BUG: no ledger but events present → derived facts, not a measured-looking "other"', () => {
    const dir = join(tmpDir, 'm2');
    writeEvents(dir, [
      { timestamp: '2026-09-06T08:00:00.000Z', event: 'orchestrator.session.started', mode: 'deep' },
      { timestamp: '2026-09-06T11:30:00.000Z', event: 'orchestrator.agent.stopped' },
    ]);
    const { record } = buildBatch({ ...common, metricsDir: dir, statePath: grantedStatePath() });
    expect(record.session_record).toBe('derived');
    expect(record.session_type).toBe('deep');
    expect(record.duration_bucket).toBe('>3h');
  });

  it('neither source → session_type "unknown", NOT "other", and session_record "absent"', () => {
    const dir = join(tmpDir, 'm3');
    mkdirSync(dir, { recursive: true });
    const { record } = buildBatch({ ...common, metricsDir: dir, statePath: grantedStatePath() });
    expect(record.session_type).toBe('unknown');
    expect(record.session_record).toBe('absent');
  });

  it('a MEASURED but unrecognised type is still "other" — absent and unrecognised stay distinct', () => {
    const dir = join(tmpDir, 'm4');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sessions.jsonl'), JSON.stringify({
      session_id: 's1', session_type: 'weird',
      started_at: '2026-09-06T08:00:00.000Z', completed_at: '2026-09-06T08:05:00.000Z',
    }) + '\n');
    const { record } = buildBatch({ ...common, metricsDir: dir, statePath: grantedStatePath() });
    expect(record.session_type).toBe('other');
  });

  // Pairs with the `session_profile` contract in schema.test.mjs: a ping built
  // WITHOUT a ledger must carry no profile rather than an invented one.
  it('a derived (ledger-less) ping carries NO session_profile rather than an invented one', () => {
    const dir = join(tmpDir, 'mp');
    writeEvents(dir, [{ timestamp: '2026-09-06T08:00:00.000Z', event: 'orchestrator.session.started', mode: 'deep' }]);
    const { record } = buildBatch({ ...common, metricsDir: dir, statePath: grantedStatePath() });
    expect(record.session_record).toBe('derived');
    expect('session_profile' in record).toBe(false);
  });
});
