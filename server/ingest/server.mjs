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
 * Send a JSON response. Guards against a double-send (e.g. after a mid-stream
 * 413 + destroy) via `headersSent`.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * POST /v1/records — the ordered ingest flow. Each numbered step corresponds to
 * the S5 contract; the ordering is deliberate (cheap rejections precede the
 * stream read; the Content-Length precheck avoids reading an oversized body,
 * while the stream byte-count is the real cap because Content-Length can lie or
 * be absent under chunked transfer-encoding).
 */
function handleRecordsPost(req, res, { config, db, rateLimiter }) {
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
  if (path === '/healthz') {
    return sendJson(res, 200, { status: 'ok' });
  }

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
  const rateLimiter = createRateLimiter({
    windowMs: config.rateWindowMs,
    limit: config.rateLimit,
    maxTrackedIps: config.maxTrackedIps,
  });
  const retentionTimer = scheduleRetention(db, {
    months: config.retentionMonths,
    intervalMs: config.retentionIntervalMs,
  });

  const server = http.createServer((req, res) => handleRequest(req, res, { config, db, rateLimiter }));

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
