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

`200 {"status":"ok"}` — no rate limit, no body, no DB write.

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
# {"status":"ok"}
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
