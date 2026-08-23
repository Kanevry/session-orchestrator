# Ingest Server (`server/ingest/`)

Minimal, dependency-free ingest endpoint for the anonymous usage-telemetry
pipeline (Epic #841, S5 — GitLab #846; PRD
[`docs/prd/2026-07-20-anonymous-usage-telemetry.md`](../../docs/prd/2026-07-20-anonymous-usage-telemetry.md) §3-FA4).

- **Runtime:** Node 24, `node:http` + `node:sqlite` only. No third-party deps,
  no `npm install`.
- **Storage:** SQLite (WAL) at `SO_INGEST_DB` (`/data/records.db` in the container).
- **License:** MIT (same repo). Excluded from the npm `files` whitelist by
  construction — this directory never ships in the plugin package.

## Privacy invariants

- The **client IP is never persisted and never logged**. It exists only
  transiently in memory as the rate-limiter key for the current window, then is
  discarded on window reset. There is no IP column and no IP in `raw_json`.
- `received_day` is **server-derived** (UTC, the server's own clock). The
  client-supplied `sent_at` is validated for shape but never trusted for the
  storage day and never indexed.
- Deploy behind the existing Caddy edge with **access logging off** for the
  `telemetry.` vhost.

## HTTP API

### `POST /v1/records`

Accepts a single record object or a non-empty array of records. Body ≤ 32 KB.

Flow (order is load-bearing):

1. `Content-Type` must begin with `application/json` → else `415 {"error":"unsupported_media_type"}`.
2. `Content-Length` > body cap → `413 {"error":"payload_too_large"}` (no body read).
3. Per-IP rate limit → `429 {"error":"rate_limited"}` + `Retry-After` header.
4. Stream byte cap (Content-Length can lie / be absent) → `413` + connection destroyed.
5. Invalid JSON → `400 {"error":"invalid_json"}`.
6. Empty array / non-object → `400 {"error":"validation_failed","field":"body"}`.
7. Any record invalid → `400 {"error":"validation_failed","field":"<path>"}`, **nothing stored** (all-or-nothing).
8. All rows persisted in one transaction.
9. `202 {"accepted":N}`.

Unknown top-level fields on an otherwise-valid record are **accepted** and
preserved in `raw_json` (additive forward-compatibility). An unknown
`record_kind` is rejected (`400`).

### `GET /healthz`

`200` — no rate limit, no body read, no DB write. Also the read-out for the
in-memory response counters (GitLab #1140):

```json
{
  "status": "ok",
  "started_at": "2026-08-23T08:16:14.636Z",
  "counters": { "202": 1, "400": 1, "404": 1, "415": 1 },
  "accepted_records": 1
}
```

- `counters` — one tally per HTTP status the server has answered with. This is
  the only trace a rejected send leaves: a `400`/`413`/`415`/`429` stores no row
  and (by privacy design) writes no log line, so without these tallies a host
  with zero foreign records cannot distinguish *nobody sends* from *everybody is
  rejected*.
- `accepted_records` — total records persisted, summed across batches. A `202`
  tally alone cannot separate one batch of 50 from 50 single-record posts.
- `started_at` — process start (ISO-8601 UTC).
- **`/healthz` itself is not counted.** The container `HEALTHCHECK` probes it
  every 30s (~2880/day); counting it would bury every other status under one
  dominant `200`. Probe health is already reported by
  `docker inspect --format '{{.State.Health.Status}}'`.
- **Reset semantics:** the counters are in-memory and per-process. A container
  restart resets every tally to zero and moves `started_at` — always read a
  tally against `started_at`, never as a lifetime total. There is no persistence
  and no back-fill; the weekly digest (`digest.mjs`) is the durable read path.
- **Privacy:** status-code tallies only. No IP, no path, no body, no
  per-request timestamp — a bare HTTP status carries no client identity, so the
  invariants above are unchanged.
- **Not counted, by construction:** responses produced by Node's own HTTP layer
  rather than by the request handler (`requestTimeout`/`headersTimeout` → `408`,
  `maxRequestsPerSocket` → `503`) never pass through the application's response
  helper. Revisit only if transport-level rejections ever need to be visible —
  that needs a `res.on('finish')` hook, not a second counting site.

Non-POST on `/v1/records` → `405` + `Allow: POST`. Any other path → `404`.

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8787` | Listen port |
| `SO_INGEST_DB` | `./data/records.db` | SQLite path (`:memory:` for tests) |
| `SO_INGEST_BODY_CAP` | `32768` | Max request body bytes |
| `SO_INGEST_RATE_WINDOW_MS` | `3600000` | Rate-limit window (fixed) |
| `SO_INGEST_RATE_LIMIT` | `60` | Requests per window per IP |
| `SO_INGEST_MAX_TRACKED_IPS` | `50000` | Rate-limit Map cap (fail-closed when reached) |
| `SO_INGEST_TRUST_PROXY` | `1` | Use left-most `X-Forwarded-For` when `1`, else socket peer |
| `SO_INGEST_RETENTION_MONTHS` | `24` | Raw-record retention window |
| `SO_INGEST_RETENTION_INTERVAL_MS` | `86400000` | Retention sweep interval |

## Operations

Run locally:

```sh
node server/ingest/server.mjs
```

Build + run the container:

```sh
docker build -f server/ingest/Dockerfile -t so-ingest .
docker run -d -p 8787:8787 -v so-ingest-data:/data so-ingest
```

Prune old raw records once (CLI seam; `aggregates_weekly` is left untouched):

```sh
node server/ingest/retention.mjs        # prints {"deleted":N}
```

Smoke test:

```sh
curl -fsS http://127.0.0.1:8787/healthz
# {"status":"ok","started_at":"…","counters":{},"accepted_records":0}
```

## Extending with a new `record_kind`

The server is `record_kind`-generic. To add a kind (e.g. `session-eval`):

1. Add a validator in `validate.mjs` and register it via
   `registerValidator('<kind>', fn)`. The validator returns a storage row
   (`{ kind, schema_version, received_day, anon_id, fleet, raw_json }`).
2. No transport, routing, or table change is required — records share the
   `records` table, discriminated by `kind`.

## Module map

| File | Responsibility |
|------|----------------|
| `server.mjs` | HTTP factory (`createIngestServer`) + CLI bootstrap |
| `config.mjs` | `resolveConfig(env)` — pure env resolution |
| `validate.mjs` | `record_kind` registry + `usage-ping` v1 validator + `ValidationError` |
| `db.mjs` | **only** `node:sqlite` importer (driver-swap seam) |
| `rate-limit.mjs` | fixed-window in-memory limiter + IP extraction |
| `retention.mjs` | `pruneOldRecords` / `scheduleRetention` + CLI seam |
