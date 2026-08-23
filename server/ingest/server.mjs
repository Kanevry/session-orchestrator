/**
 * server/ingest/server.mjs — HTTP factory + CLI bootstrap for the anonymous
 * usage-telemetry ingest server (Epic #841, S5 / GitLab #846; PRD §3-FA4).
 *
 * Dependency-free: node:http only here; node:sqlite is isolated in db.mjs.
 *
 * Privacy invariants (load-bearing):
 *   - The client IP is used ONLY for the transient rate-limit decision. It is
 *     NEVER persisted (no column, never in raw_json) and NEVER logged — not even
 *     on an error path. The single boot line on stderr carries no IP.
 *   - SEC-009: an internal error message never reaches the client; responses
 *     carry only fixed machine-readable error codes.
 *   - The response counters (GitLab #1140) are status-code tallies only. No IP,
 *     no path, no body, no timestamp-per-request is retained — a bare HTTP
 *     status carries no client identity, so the invariants above are unchanged.
 *
 * POST /v1/records flow ordering is load-bearing — see handleRecordsPost.
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from './config.mjs';
import { openDb, insertRecords, closeDb } from './db.mjs';
import { validateRecord, ValidationError } from './validate.mjs';
import { createRateLimiter, extractIp } from './rate-limit.mjs';
import { scheduleRetention } from './retention.mjs';

/**
 * Symbol key under which the routing layer binds this response's status
 * counter onto the ServerResponse. Bound once in `handleRequest`, read once in
 * `sendJson` — which is the single point EVERY response in this module leaves
 * through — so no response path can silently escape counting (BV-003).
 */
const RESPONSE_COUNTER = Symbol('so.ingest.responseCounter');

/**
 * Per-instance response statistics (GitLab #1140).
 *
 * Motivation: a send attempt that fails with 400/413/415/429 stores nothing and
 * (by privacy design) logs nothing, so before these counters a host with zero
 * foreign records could not distinguish "nobody sends" from "everybody is
 * rejected". The counters make the rejection visible without recording anything
 * about who was rejected.
 *
 * In-memory and per-instance by design: a container restart resets every tally
 * to zero. `started_at` is what makes that legible — a small `202` count next
 * to a recent `started_at` is a young process, not a quiet week.
 *
 * @returns {{
 *   countStatus: (status: number) => void,
 *   addAccepted: (n: number) => void,
 *   snapshot: () => { started_at: string, counters: Record<string, number>, accepted_records: number },
 * }}
 */
function createStats() {
  const counters = Object.create(null);
  const startedAt = new Date().toISOString();
  let acceptedRecords = 0;

  return {
    countStatus(status) {
      counters[status] = (counters[status] ?? 0) + 1;
    },
    addAccepted(n) {
      acceptedRecords += n;
    },
    snapshot() {
      // Copy — callers must never hold a handle on the live tally.
      return {
        started_at: startedAt,
        counters: { ...counters },
        accepted_records: acceptedRecords,
      };
    },
  };
}

/**
 * Send a JSON response. Guards against a double-send (e.g. after a mid-stream
 * 413 + destroy) via `headersSent`.
 *
 * This is also the ONLY status-counting site: all 13 call sites in this module
 * funnel through here, so one increment covers every response path. The
 * optional call is deliberate — `/healthz` binds no counter (see
 * `handleRequest`), and responses produced by Node's own HTTP layer rather than
 * by this handler (`requestTimeout`/`headersTimeout` → 408,
 * `maxRequestsPerSocket` → 503) never reach this function and are therefore not
 * counted. Named ceiling: if those transport-level rejections ever need to be
 * visible, they require a `res.on('finish')` hook, not another call site here.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
  res[RESPONSE_COUNTER]?.(status);
}

/**
 * POST /v1/records — the ordered ingest flow. Each numbered step corresponds to
 * the S5 contract; the ordering is deliberate (cheap rejections precede the
 * stream read; the Content-Length precheck avoids reading an oversized body,
 * while the stream byte-count is the real cap because Content-Length can lie or
 * be absent under chunked transfer-encoding).
 */
function handleRecordsPost(req, res, { config, db, rateLimiter, stats }) {
  // (1) Content-Type must begin with application/json.
  const ctype = (req.headers['content-type'] || '').toLowerCase();
  if (!ctype.startsWith('application/json')) {
    return sendJson(res, 415, { error: 'unsupported_media_type' });
  }

  // (2) Content-Length precheck — reject an over-cap body WITHOUT reading it.
  const declaredLen = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLen) && declaredLen > config.bodyCap) {
    return sendJson(res, 413, { error: 'payload_too_large' });
  }

  // (3) Rate-limit — IP resolved transiently, used for this decision only.
  const ip = extractIp(req, config.trustProxy);
  const decision = rateLimiter.check(ip);
  if (!decision.allowed) {
    return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(decision.retryAfter) });
  }

  // (4) Stream with a hard byte cap — Content-Length may lie or be absent.
  let size = 0;
  let aborted = false;
  const chunks = [];

  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > config.bodyCap) {
      aborted = true;
      sendJson(res, 413, { error: 'payload_too_large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  // Never log the IP or the error — swallow silently (privacy invariant).
  req.on('error', () => {
    aborted = true;
  });

  req.on('end', () => {
    if (aborted) return;

    // (5) JSON parse.
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }

    // (6) Accept a single object OR a non-empty array of records.
    let records;
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return sendJson(res, 400, { error: 'validation_failed', field: 'body' });
      }
      records = parsed;
    } else if (parsed !== null && typeof parsed === 'object') {
      records = [parsed];
    } else {
      return sendJson(res, 400, { error: 'validation_failed', field: 'body' });
    }

    // (7) Validate EVERY record before storing anything (all-or-nothing).
    const rows = [];
    for (const record of records) {
      try {
        rows.push(validateRecord(record));
      } catch (err) {
        const field = err instanceof ValidationError ? (err.field ?? null) : null;
        return sendJson(res, 400, { error: 'validation_failed', field });
      }
    }

    // (8) Persist the whole batch in one transaction.
    try {
      const accepted = insertRecords(db, rows);
      // Counted where the rows are actually stored — a 202 tally alone cannot
      // distinguish one batch of 50 from 50 single-record posts.
      stats.addAccepted(accepted);
      // (9) Success.
      return sendJson(res, 202, { accepted });
    } catch (err) {
      // Operator-visible signal for DB-layer failures (disk full, WAL corruption).
      // Driver errors carry no client data — the client IP is never part of err.
      process.stderr.write(`[ingest] insertRecords failed: ${err?.message ?? err}\n`);
      // SEC-009: never leak the driver error message to the client.
      return sendJson(res, 500, { error: 'internal_error' });
    }
  });
}

/**
 * Route a single request.
 */
function handleRequest(req, res, ctx) {
  const path = (req.url || '/').split('?')[0];
  const method = req.method || 'GET';

  // GET /healthz — no rate limit, no body read, no DB write.
  //
  // Deliberately NOT counted (#1140): the container HEALTHCHECK probes this
  // path every 30s (~2880/day), so counting it would bury the ingest statuses
  // the counters exist to surface under a single dominant `200`. Nothing is
  // lost by the omission — probe health is already reported by
  // `docker inspect --format '{{.State.Health.Status}}'` and process age by
  // `started_at` below. Concretely: no counter is bound on this branch, so
  // sendJson's optional call is a no-op here.
  if (path === '/healthz') {
    return sendJson(res, 200, { status: 'ok', ...ctx.stats.snapshot() });
  }

  // Every other path IS counted. Binding here (one line, at the single routing
  // fork) rather than at each sendJson call site is what makes it impossible
  // for a new response path to be added without being counted.
  res[RESPONSE_COUNTER] = ctx.stats.countStatus;

  if (path === '/v1/records') {
    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    return handleRecordsPost(req, res, ctx);
  }

  return sendJson(res, 404, { error: 'not_found' });
}

/**
 * Build the ingest server. The argument is treated as an OVERRIDE map merged
 * over resolveConfig() — so `createIngestServer({ dbPath: ':memory:' })` yields
 * a fully-defaulted config with only dbPath overridden (the in-process test
 * construction), while a bare call resolves the full environment config.
 *
 * @param {Partial<ReturnType<typeof resolveConfig>>} [overrides]
 * @returns {{ server: import('node:http').Server,
 *             db: import('node:sqlite').DatabaseSync,
 *             close: () => Promise<void> }}
 */
export function createIngestServer(overrides = {}) {
  const config = { ...resolveConfig(), ...overrides };

  const db = openDb(config.dbPath);
  const stats = createStats();
  const rateLimiter = createRateLimiter({
    windowMs: config.rateWindowMs,
    limit: config.rateLimit,
    maxTrackedIps: config.maxTrackedIps,
  });
  const retentionTimer = scheduleRetention(db, {
    months: config.retentionMonths,
    intervalMs: config.retentionIntervalMs,
  });

  const server = http.createServer((req, res) =>
    handleRequest(req, res, { config, db, rateLimiter, stats }),
  );

  // Connection hardening (defense against slowloris / socket exhaustion).
  server.requestTimeout = 10000;
  server.headersTimeout = 8000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;

  const close = () =>
    new Promise((resolve) => {
      rateLimiter.stop();
      clearInterval(retentionTimer);
      server.close(() => {
        try {
          closeDb(db);
        } catch {
          /* already closed */
        }
        resolve();
      });
    });

  return { server, db, close };
}

// ---------------------------------------------------------------------------
// CLI bootstrap — only on direct invocation.
// ---------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = resolveConfig();
  const { server, close } = createIngestServer(config);

  server.listen(config.port, () => {
    // The ONLY stdout/stderr line — carries no IP.
    process.stderr.write(`ingest server listening on :${config.port}\n`);
  });

  const shutdown = () => {
    close().then(() => process.exit(0));
    // Force-exit backstop if graceful close stalls; unref'd so it is not itself
    // a reason to stay alive.
    const t = setTimeout(() => process.exit(0), 5000);
    t.unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
