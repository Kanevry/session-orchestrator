/**
 * tests/telemetry/server.test.mjs — HTTP behavior of the anonymous
 * usage-telemetry ingest server (Epic #841, S5 / GitLab #846; PRD §3-FA4).
 *
 * Strategy: build the server in-process against an in-memory SQLite DB
 * (`createIngestServer({ dbPath: ':memory:' })`), listen on an ephemeral port,
 * drive it with `fetch`, and assert HTTP status + persisted rows. Every server
 * is torn down in afterEach.
 *
 * Privacy invariant under test (#14): the client IP is NEVER persisted. See the
 * fake-regression note in that test — temporarily persisting the IP turns it RED.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import { createIngestServer } from '../../server/ingest/server.mjs';
import { ACCEPTED_VERSIONS } from '../../server/ingest/validate.mjs';
import { createRateLimiter, extractIp } from '../../server/ingest/rate-limit.mjs';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

/** A fully-valid usage-ping v1 record; `overrides` mutate individual fields. */
function validPing(overrides = {}) {
  return {
    record_kind: 'usage-ping',
    schema_version: 1,
    anon_id: '12345678-1234-4234-8234-123456789012',
    sent_at: '2026-07-20T10:00:00.000Z',
    plugin_version: '3.16.0',
    platform: 'claude',
    os: 'darwin',
    arch: 'arm64',
    node_major: 24,
    ci: false,
    fleet: true,
    session_type: 'deep',
    duration_bucket: '1-3h',
    skills: ['session-start', 'wave-executor'],
    commands: ['/session', '/go'],
    ...overrides,
  };
}

let ctx = null;

/** Start an in-process server and resolve once it is listening. */
function start(overrides = {}) {
  const inst = createIngestServer({ dbPath: ':memory:', ...overrides });
  return new Promise((resolve) => {
    inst.server.listen(0, '127.0.0.1', () => {
      const { port } = inst.server.address();
      resolve({ ...inst, base: `http://127.0.0.1:${port}` });
    });
  });
}

/** POST a record (object, array, or raw string) to /v1/records. */
function post(base, body, headers = {}) {
  return fetch(`${base}/v1/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Count rows in the records table. */
function countRows(db) {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM records').get().c);
}

afterEach(async () => {
  if (ctx) {
    await ctx.close();
    ctx = null;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/records — happy path', () => {
  it('accepts a valid usage-ping, returns 202 {accepted:1}, and stores a server-derived received_day', async () => {
    ctx = await start();
    const res = await post(ctx.base, validPing());

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });

    const rows = ctx.db.prepare('SELECT * FROM records').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('usage-ping');
    expect(rows[0].schema_version).toBe(1);
    expect(rows[0].fleet).toBe(1);
    // received_day is derived from the server's UTC clock, not the client's sent_at.
    expect(rows[0].received_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0].received_day).toBe(new Date().toISOString().slice(0, 10));

    const raw = JSON.parse(rows[0].raw_json);
    expect(raw.plugin_version).toBe('3.16.0');
    expect(raw.skills).toEqual(['session-start', 'wave-executor']);
  });

  it('accepts an array batch and returns 202 {accepted:2}', async () => {
    ctx = await start();
    const res = await post(ctx.base, [validPing(), validPing()]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(countRows(ctx.db)).toBe(2);
  });
});

describe('POST /v1/records — validation rejections', () => {
  it('rejects an unknown record_kind with 400 and stores nothing', async () => {
    ctx = await start();
    const res = await post(ctx.base, validPing({ record_kind: 'totally-unknown' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_failed', field: 'record_kind' });
    expect(countRows(ctx.db)).toBe(0);
  });

  it.each([
    ['missing anon_id', () => { const p = validPing(); delete p.anon_id; return p; }, 'anon_id'],
    ['non-UUID anon_id', () => validPing({ anon_id: 'not-a-uuid' }), 'anon_id'],
    // 'claude-code' is deliberately OFF-enum — the client sends 'claude'.
    ['platform off-enum (claude-code)', () => validPing({ platform: 'claude-code' }), 'platform'],
    ['duration_bucket off-enum', () => validPing({ duration_bucket: '2h' }), 'duration_bucket'],
    ['skills > 100 items', () => validPing({ skills: Array.from({ length: 101 }, (_, i) => `s${i}`) }), 'skills'],
    ['skill string > 64 chars', () => validPing({ skills: ['x'.repeat(65)] }), 'skills[0]'],
  ])('rejects %s with 400 and stores nothing', async (_name, build, expectedField) => {
    ctx = await start();
    const res = await post(ctx.base, build());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_failed', field: expectedField });
    expect(countRows(ctx.db)).toBe(0);
  });

  it('rejects schema_version 2 with 400 (accepted-set is data-driven)', async () => {
    // Data-driven assertion: only v1 is accepted today; the same Set gates the wire.
    expect(ACCEPTED_VERSIONS.has(1)).toBe(true);
    expect(ACCEPTED_VERSIONS.has(2)).toBe(false);

    ctx = await start();
    const res = await post(ctx.base, validPing({ schema_version: 2 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_failed', field: 'schema_version' });
    expect(countRows(ctx.db)).toBe(0);
  });

  it('rejects an empty array batch with 400 and stores nothing', async () => {
    ctx = await start();
    const res = await post(ctx.base, []);
    expect(res.status).toBe(400);
    expect(countRows(ctx.db)).toBe(0);
  });

  it('rejects an array batch containing one invalid record (all-or-nothing) and stores nothing', async () => {
    ctx = await start();
    const batch = [validPing(), validPing({ platform: 'claude-code' }), validPing()];
    const res = await post(ctx.base, batch);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_failed', field: 'platform' });
    expect(countRows(ctx.db)).toBe(0);
  });
});

describe('POST /v1/records — forward compatibility', () => {
  it('accepts an unknown top-level field and preserves it in raw_json', async () => {
    ctx = await start();
    const res = await post(ctx.base, validPing({ future_field: 'hello-future' }));
    expect(res.status).toBe(202);

    const rows = ctx.db.prepare('SELECT raw_json FROM records').all();
    expect(JSON.parse(rows[0].raw_json).future_field).toBe('hello-future');
  });
});

describe('POST /v1/records — body cap (both paths)', () => {
  it('rejects an oversized body via the Content-Length precheck (413)', async () => {
    ctx = await start();
    // A ~33 KB body — over the 32768 cap. fetch sets Content-Length for a string body.
    const oversized = 'x'.repeat(33000);
    const res = await post(ctx.base, oversized);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(countRows(ctx.db)).toBe(0);
  });

  it('rejects an oversized body via the stream cap when Content-Length is absent (chunked)', async () => {
    ctx = await start();
    const payload = 'x'.repeat(33000);
    // A ReadableStream body forces chunked transfer-encoding (no Content-Length),
    // so the Content-Length precheck is skipped and the stream byte-count is the gate.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const res = await fetch(`${ctx.base}/v1/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(countRows(ctx.db)).toBe(0);
  });
});

describe('POST /v1/records — content-type & JSON', () => {
  it('rejects a non-JSON Content-Type with 415', async () => {
    ctx = await start();
    const res = await fetch(`${ctx.base}/v1/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(validPing()),
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
    expect(countRows(ctx.db)).toBe(0);
  });

  it('rejects malformed JSON with 400 invalid_json', async () => {
    ctx = await start();
    const res = await post(ctx.base, '{ not valid json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
    expect(countRows(ctx.db)).toBe(0);
  });
});

describe('rate limiting', () => {
  it('rate-limits past the window limit, stores nothing for the rejected request, and keeps /healthz at 200', async () => {
    ctx = await start({ rateLimit: 2 });

    const r1 = await post(ctx.base, validPing());
    const r2 = await post(ctx.base, validPing());
    const r3 = await post(ctx.base, validPing());

    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r3.status).toBe(429);
    expect(await r3.json()).toEqual({ error: 'rate_limited' });
    expect(Number(r3.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // The two allowed requests stored; the 429'd request stored nothing.
    expect(countRows(ctx.db)).toBe(2);

    // /healthz is never rate-limited.
    const health = await fetch(`${ctx.base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
  });
});

describe('routing', () => {
  it('returns 200 {status:ok} for GET /healthz', async () => {
    ctx = await start();
    const res = await fetch(`${ctx.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns 405 + Allow: POST for a non-POST /v1/records', async () => {
    ctx = await start();
    const res = await fetch(`${ctx.base}/v1/records`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('returns 404 for an unknown path', async () => {
    ctx = await start();
    const res = await fetch(`${ctx.base}/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe('privacy — IP is never persisted', () => {
  it('never persists the X-Forwarded-For client IP in any column or in raw_json', async () => {
    ctx = await start();
    const res = await post(ctx.base, validPing(), { 'X-Forwarded-For': '203.0.113.7' });
    expect(res.status).toBe(202);

    // Dump EVERY column of EVERY row (raw_json included) and assert the IP is absent.
    const rows = ctx.db.prepare('SELECT * FROM records').all();
    expect(rows).toHaveLength(1);
    const fullDump = JSON.stringify(rows);
    expect(fullDump).not.toContain('203.0.113.7');

    // FAKE-REGRESSION (manual guard proof, documented in the wave report):
    // temporarily injecting `record.__ip = ip` before validateRecord in
    // server.mjs step 7 makes raw_json contain '203.0.113.7' → this test RED.
    // Reverted after observing red.
  });
});

describe('lifecycle', () => {
  it('close() shuts the server down so a subsequent request fails', async () => {
    ctx = await start();
    const base = ctx.base;
    await ctx.close();
    ctx = null; // afterEach must not double-close.
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });
});

describe('POST /v1/records — DB insert failure (500 path, SEC-009)', () => {
  it('returns 500 {error:internal_error} with no driver text leaked, then recovers after ROLLBACK on the same handle', async () => {
    ctx = await start();

    // Real fault injection (NOT a mock of the SUT): wrap the REAL, open db handle
    // so the FIRST `INSERT INTO records` prepare yields a statement whose .run()
    // genuinely throws. This drives the real db.mjs BEGIN → run(throw) → ROLLBACK
    // → rethrow path and server.mjs's real catch → 500. The DatabaseSync handle
    // stays open, so after ROLLBACK it is still usable — the recovery POST proves
    // it. Only the INSERT prepare is sabotaged; COUNT and every other statement
    // delegate to the real prepare, so the row assertions below are honest.
    const realPrepare = ctx.db.prepare.bind(ctx.db);
    let sabotage = true;
    ctx.db.prepare = (sql) => {
      if (sabotage && sql.startsWith('INSERT INTO records')) {
        sabotage = false; // one-shot: only the first insert batch fails.
        return {
          run() {
            throw new Error('SQLITE_IOERR: disk I/O error near "records": constraint failed');
          },
        };
      }
      return realPrepare(sql);
    };

    const res = await post(ctx.base, validPing());
    expect(res.status).toBe(500);

    // SEC-009: the fixed machine code only — the SQLite driver text never leaks.
    const text = await res.text();
    expect(text).toBe('{"error":"internal_error"}');
    expect(text).not.toContain('SQLITE');
    expect(text).not.toContain('constraint');
    expect(text).not.toContain('disk I/O');

    // The failed batch rolled back — nothing persisted.
    expect(countRows(ctx.db)).toBe(0);

    // Rollback recovery: the same (now un-sabotaged) handle accepts a fresh POST.
    const res2 = await post(ctx.base, validPing());
    expect(res2.status).toBe(202);
    expect(await res2.json()).toEqual({ accepted: 1 });
    expect(countRows(ctx.db)).toBe(1);
  });
});

describe('extractIp — right-most XFF hop (CWE-348 rate-limit-bypass fix)', () => {
  it('returns the RIGHT-MOST XFF hop under trustProxy (the Caddy-appended peer, not the spoofable left-most)', () => {
    const req = { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, socket: { remoteAddress: '9.9.9.9' } };
    expect(extractIp(req, true)).toBe('2.2.2.2');
  });

  it('returns the socket peer when trustProxy is off (XFF ignored entirely)', () => {
    const req = { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, socket: { remoteAddress: '9.9.9.9' } };
    expect(extractIp(req, false)).toBe('9.9.9.9');
  });

  it('falls back to the socket peer on an empty XFF under trustProxy', () => {
    const req = { headers: { 'x-forwarded-for': '   ' }, socket: { remoteAddress: '9.9.9.9' } };
    expect(extractIp(req, true)).toBe('9.9.9.9');
  });

  it('falls back to the "unknown" constant when neither XFF nor socket peer is present', () => {
    const req = { headers: {}, socket: {} };
    expect(extractIp(req, true)).toBe('unknown');
  });
});

describe('rate limiting — XFF spoof cannot mint fresh buckets (CWE-348 bypass closed)', () => {
  it('routes two requests sharing a right-most XFF hop into the SAME bucket despite differing left-most (spoofed) hops', async () => {
    ctx = await start({ rateLimit: 1 });

    // Both requests share right-most 9.9.9.9 (the trusted Caddy peer) but vary
    // the client-controlled left-most hop. Pre-fix (left-most keyed) these would
    // land in two DISTINCT buckets and both pass; post-fix they share one bucket,
    // so the second is rate-limited — this is the core proof the bypass is closed.
    const r1 = await post(ctx.base, validPing(), { 'X-Forwarded-For': '1.1.1.1, 9.9.9.9' });
    const r2 = await post(ctx.base, validPing(), { 'X-Forwarded-For': '8.8.8.8, 9.9.9.9' });

    expect(r1.status).toBe(202);
    expect(r2.status).toBe(429);
    expect(await r2.json()).toEqual({ error: 'rate_limited' });

    // Exactly one row stored — the spoofed second request was rejected pre-persist.
    expect(countRows(ctx.db)).toBe(1);
  });
});

describe('createRateLimiter — maxTrackedIps fail-closed', () => {
  it('rejects a new IP once the tracked-IP cap is reached (fails CLOSED, not open)', () => {
    const limiter = createRateLimiter({ windowMs: 1_000_000, limit: 5, maxTrackedIps: 1 });
    try {
      expect(limiter.check('a').allowed).toBe(true); // first IP is tracked.
      expect(limiter.check('b').allowed).toBe(false); // a second NEW IP over the cap → denied.
    } finally {
      limiter.stop();
    }
  });
});

describe('POST /v1/records — os/arch enum coverage', () => {
  it('accepts a full-Node-set arch (loong64) with 202', async () => {
    ctx = await start();
    const res = await post(ctx.base, validPing({ arch: 'loong64' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
  });

  it('rejects an off-enum arch with 400 field arch', async () => {
    ctx = await start();
    const res = await post(ctx.base, validPing({ arch: 'quantum99' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_failed', field: 'arch' });
    expect(countRows(ctx.db)).toBe(0);
  });
});

describe('POST /v1/records — body cap boundary (exact / +1, both transports)', () => {
  it('does NOT 413 a body of exactly bodyCap bytes via Content-Length (falls through to JSON parse)', async () => {
    ctx = await start({ bodyCap: 100 });
    const res = await post(ctx.base, 'x'.repeat(100)); // exactly the cap — not over it.
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(400); // 'xxxx…' is invalid JSON → invalid_json, NOT payload_too_large.
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('413s a body of bodyCap+1 bytes via the Content-Length precheck', async () => {
    ctx = await start({ bodyCap: 100 });
    const res = await post(ctx.base, 'x'.repeat(101));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('does NOT 413 an exactly-bodyCap chunked body (no Content-Length → the stream cap decides)', async () => {
    ctx = await start({ bodyCap: 100 });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(100)));
        controller.close();
      },
    });
    const res = await fetch(`${ctx.base}/v1/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    });
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(400);
  });

  it('413s a bodyCap+1 chunked body via the stream byte-count cap', async () => {
    ctx = await start({ bodyCap: 100 });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(101)));
        controller.close();
      },
    });
    const res = await fetch(`${ctx.base}/v1/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });
});

describe('POST /v1/records — node_major bounds', () => {
  it.each([
    ['zero (below floor)', 0],
    ['100 (above ceiling)', 100],
    ['string "24" (not an integer)', '24'],
    ['24.5 (non-integer)', 24.5],
  ])('rejects node_major %s with 400 field node_major', async (_name, value) => {
    ctx = await start();
    const res = await post(ctx.base, validPing({ node_major: value }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_failed', field: 'node_major' });
    expect(countRows(ctx.db)).toBe(0);
  });

  it.each([
    ['1 (floor)', 1],
    ['99 (ceiling)', 99],
  ])('accepts node_major %s with 202', async (_name, value) => {
    ctx = await start();
    const res = await post(ctx.base, validPing({ node_major: value }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
  });
});

describe('POST /v1/records — anon_id case sensitivity', () => {
  it('rejects an uppercase-hex anon_id with 400 field anon_id (client emits lowercase randomUUID)', async () => {
    ctx = await start();
    const res = await post(ctx.base, validPing({ anon_id: '12345678-1234-4234-8234-123456789ABC' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'validation_failed', field: 'anon_id' });
    expect(countRows(ctx.db)).toBe(0);
  });
});

describe('POST /v1/records — list boundary acceptance', () => {
  it('accepts skills with exactly 100 items with 202', async () => {
    ctx = await start();
    const skills = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const res = await post(ctx.base, validPing({ skills }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
  });

  it('accepts a 64-char skill name with 202', async () => {
    ctx = await start();
    const res = await post(ctx.base, validPing({ skills: ['x'.repeat(64)] }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
  });
});
