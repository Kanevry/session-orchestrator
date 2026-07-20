/**
 * tests/telemetry/daily-fallback-e2e.test.mjs — FA3.3 real `_flush` CHILD
 * subprocess chain (Epic #841 W4-Panel Q2).
 *
 * Every prior daily-fallback test exercises `maybeSpawnDailyFlush` with an
 * INJECTED `spawnFn` spy — the real `scripts/telemetry.mjs _flush` child path
 * (the thing that spy stands in for) is never actually run. This file spawns
 * the REAL CLI as a REAL subprocess (`node:child_process.spawn`, no mocks)
 * against:
 *   - an isolated HOME (mkdtempSync; os.homedir() honors $HOME on POSIX, so
 *     telemetry.json / telemetry-queue.ndjson land under the tmp dir);
 *   - a real in-process node:http collector server on an ephemeral port,
 *     wired in via SO_TELEMETRY_ENDPOINT.
 *
 * `cwd` is set to the SAME isolated tmp dir (not the repo root): `_flush`'s
 * `buildBatch()` reads `<cwd>/.orchestrator/metrics/*.jsonl` by default, and
 * this repo's own real (gitignored, host-local) metrics files would make the
 * built ping's session_type/duration_bucket non-deterministic. An isolated
 * empty cwd makes buildBatch fall back to its documented synthetic-session
 * path deterministically (session_type 'other', duration_bucket '<15m',
 * skills/commands both empty) — mirrors the isolation pattern already used by
 * tests/telemetry/cli.test.mjs for the `show` subcommand.
 *
 * Uses ASYNC `spawn` (not `spawnSync`) deliberately: `spawnSync` blocks the
 * calling process's event loop for its entire duration, which would prevent
 * the collector server running IN THIS SAME PROCESS from ever accepting the
 * child's connection (verified empirically — a `spawnSync` variant of this
 * test hangs at 0 received requests even though the child itself exits 0).
 * `spawn` keeps the event loop alive so the collector can service the
 * request concurrently with awaiting the child's `close` event.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';

import { grantConsent, readTelemetryState } from '../../scripts/lib/telemetry/consent.mjs';
import { enqueue, queueStats } from '../../scripts/lib/telemetry/queue.mjs';

const CLI = path.resolve(import.meta.dirname, '../../scripts/telemetry.mjs');
const START = '2026-07-20T00:00:00.000Z';

/** A fully-valid, standalone usage-ping v1 record, used to seed the offline queue. */
function sampleQueuedBatch() {
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
    session_type: 'deep',
    duration_bucket: '1-3h',
    skills: [],
    commands: [],
  };
}

/** A real node:http server that collects every POST body as parsed JSON. */
function createCollectorServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // leave body as null — an unparsable body is recorded as such.
      }
      requests.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: Array.isArray(body) ? body.length : 1 }));
    });
  });
  return { server, requests };
}

let tmpHome;
let collector;
let base;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'telemetry-flush-e2e-'));
  collector = createCollectorServer();
  await new Promise((resolvePromise) => collector.server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = collector.server.address();
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolvePromise) => collector.server.close(resolvePromise));
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Path where the CLI persists consent under the isolated HOME. */
function telemetryJsonPath() {
  return join(tmpHome, '.config', 'session-orchestrator', 'telemetry.json');
}

/** Path where the CLI persists the offline queue under the isolated HOME. */
function telemetryQueuePath() {
  return join(tmpHome, '.config', 'session-orchestrator', 'telemetry-queue.ndjson');
}

/**
 * Spawn the real `telemetry.mjs _flush` child and resolve once it exits.
 * Async `spawn` (not `spawnSync`) so the collector server's event handlers in
 * THIS process keep running while the child is alive — see module docblock.
 */
function runFlushChild(extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, '_flush'], {
      cwd: tmpHome,
      env: {
        ...process.env,
        HOME: tmpHome,
        SO_TELEMETRY_ENDPOINT: `${base}/v1/records`,
        // Clear ambient kill-switches/opt-ins and CI so consent + the `ci`
        // field resolve deterministically from the fixtures this test sets up.
        DO_NOT_TRACK: '',
        SO_TELEMETRY: '',
        SO_TELEMETRY_DISABLED: '',
        SO_TELEMETRY_DEBUG: '',
        CI: '',
        ...extraEnv,
      },
    });
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
  });
}

describe('daily-fallback e2e: real `_flush` child subprocess', () => {
  it('with granted consent and a seeded offline queue, the child POSTs the queued batch plus a freshly-built ping in one request, then empties the queue', { timeout: 15000 }, async () => {
    const statePath = telemetryJsonPath();
    const queuePath = telemetryQueuePath();

    const grantResult = grantConsent({ path: statePath, now: START });
    expect(grantResult.ok).toBe(true);

    const enqueueResult = enqueue(sampleQueuedBatch(), { path: queuePath, now: START });
    expect(enqueueResult).toEqual({ ok: true, dropped: 0, total: 1 });
    expect(queueStats({ path: queuePath })).toEqual({ count: 1, bytes: expect.any(Number) });

    const { code, signal } = await runFlushChild();

    expect(code).toBe(0);
    expect(signal).toBe(null);

    expect(collector.requests).toHaveLength(1);
    const [received] = collector.requests;
    expect(received.method).toBe('POST');
    expect(Array.isArray(received.body)).toBe(true);
    expect(received.body).toHaveLength(2);

    // Entry 0 is the batch that was already queued before the child ran.
    expect(received.body[0]).toEqual(sampleQueuedBatch());

    // Entry 1 is the child's freshly-built ping: with an empty
    // .orchestrator/metrics/ under the isolated cwd, buildBatch falls back to
    // its documented synthetic-session path (schema.mjs `session_type`
    // normalizes an unrecognised value to 'other'; deriveDurationBucket falls
    // back to '<15m' on unparsable start/end timestamps).
    expect(received.body[1]).toMatchObject({
      record_kind: 'usage-ping',
      schema_version: 1,
      ci: false,
      fleet: false,
      session_type: 'other',
      duration_bucket: '<15m',
      skills: [],
      commands: [],
    });
    expect(typeof received.body[1].anon_id).toBe('string');
    expect(received.body[1].anon_id.length).toBeGreaterThan(0);

    // The queue is emptied once the send succeeds.
    expect(queueStats({ path: queuePath })).toEqual({ count: 0, bytes: 0 });

    // last_flush_at is stamped on success.
    const { record: finalState } = readTelemetryState({ path: statePath });
    expect(typeof finalState.last_flush_at).toBe('string');
  });

  it('with no consent decision on record, the child exits 0 and the collector receives nothing', { timeout: 15000 }, async () => {
    const statePath = telemetryJsonPath();

    expect(existsSync(statePath)).toBe(false);

    const { code, signal } = await runFlushChild();

    expect(code).toBe(0);
    expect(signal).toBe(null);
    expect(collector.requests).toHaveLength(0);

    // The gated early-return in flush() never reaches telemetry.json — the
    // no-consent invariant holds even after an attempted flush.
    expect(existsSync(statePath)).toBe(false);
  });
});
