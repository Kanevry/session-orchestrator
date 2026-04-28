---
paths:
  - src/app/actions/**
  - src/app/api/**
  - src/routes/**
  - src/lib/errors/**
  - src/lib/http/**
  - src/lib/logging/**
  - src/lib/responses/**
  - src/services/**
  - api/**
  - services/**
  - server/**
  - src/index.*
---
# Backend Rules (Path-scoped)

## Server Actions (Next.js)
- File pattern: `src/app/actions/*.actions.ts`
- Always `"use server"` at top of file.
- Auth first: `const { user, supabase } = await requireAuth()`
- For tenant-specific data, look up `businessId` from the database after auth (do not destructure from `requireAuth`).
- Cache `businessId` per request via `React.cache()` wrapping a `getBusinessId(userId, supabase)` helper to avoid redundant DB lookups.
- Zod validation on all inputs before any DB operation.
- Return typed results using the canonical API response envelope (see below).
- Never return raw DB errors to client.

### Canonical API Response Envelope (SEC-009)
All API responses and server action returns MUST use the canonical envelope from `@goetzendorfer/zod-schemas`:
- **Success:** `{ success: true, data: T }` | **Error:** `{ success: false, error: { code, message, details? } }`
- **Standard codes:** `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500). Do not invent new codes without documenting.
- Never return raw error objects or `error.message` to client (SEC-009). Map to standard code + user-friendly message.
- `details` field: only for validation errors (Zod issues array). Never include stack traces.
- Import: `import { ApiErrorSchema, apiSuccess } from '@goetzendorfer/zod-schemas'`

### SaaS Response Envelope (internal vs SaaS)

Two envelopes, one per consumer class. Pick **one** per endpoint — do not mix shapes inside a route group.

| Use for | Envelope shape | Error codes | Import |
|---|---|---|---|
| **Internal** — Next.js server actions, internal service-to-service | `{ success: true, data }` / `{ success: false, error }` | `ApiErrorCode` enum (above) | `@goetzendorfer/zod-schemas` (root) |
| **SaaS** — service-token-gated public API consumed by external clients | `{ data, meta? }` / `{ error: { code, message, details? } }` | `SaasErrorCode` enum (`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `PLAN_LIMIT_EXCEEDED`, `PAYMENT_REQUIRED`, `QUOTA_EXHAUSTED`, `UPSTREAM_ERROR`, `INTERNAL_ERROR`) | `@goetzendorfer/zod-schemas/saas-response` |

```ts
import { saasResponseSchema, saasErrorSchema } from '@goetzendorfer/zod-schemas/saas-response';
```

When to choose SaaS over internal:
- The endpoint is authenticated with a **service token** (not a user session) and carries a **plan / quota** concept. Plan-limit and quota errors have first-class codes.
- The response is paginated with stable `{ total, limit, offset }` meta — external clients need the shape to be contract-stable.
- The caller is billed or rate-limited at the subscription level, and must differentiate `RATE_LIMITED` from `PLAN_LIMIT_EXCEEDED`.

Anti-pattern: routing a SaaS client through the internal envelope. The internal `ApiErrorCode` set lacks `PLAN_LIMIT_EXCEEDED` / `QUOTA_EXHAUSTED`, which forces integrators to pattern-match on `message` strings — a breakage vector on every copy edit.

Harvested from feedfoundry `src/utils/saas-response.ts` (baseline #196).

### Wrapper Contract (BE-012)
Server actions wrapped by auth/tenant/validation higher-order functions MUST throw on error and return **data-only** on success. The wrapper — not the inner action — converts the thrown error into the `{ success: false, ... }` envelope.

This contract prevents a silent-pass class of bug: if the inner action returns `{ success: false, error: ... }` and the wrapper returns `{ success: true, data: <innerResult> }`, the client receives `{ success: true, data: { success: false, ... } }`. Tests that only check `result.success` pass green while production fails.

**Bad — nested envelopes, silently passing:**
```ts
async function createInvoice(input) {
  const parsed = InvoiceSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: { code: 'VALIDATION_ERROR', message: 'bad input' } };
  // ...
  return { success: true, data: invoice };
}
export const action = withAuth(createInvoice); // wraps the returned `{success:false}` as data
```

**Good — inner throws, wrapper enveloppes:**
```ts
async function createInvoice(input) {
  const parsed = InvoiceSchema.parse(input); // throws ZodError on failure
  // ...
  return invoice; // data-only; wrapper wraps as { success: true, data: invoice }
}
export const action = withAuth(createInvoice);
```

The wrapper contract:
```ts
function withAuth<T>(fn: (ctx: AuthCtx, input: any) => Promise<T>) {
  return async (input: any) => {
    try {
      const ctx = await requireAuth();
      const data = await fn(ctx, input);
      return { success: true, data } as const;
    } catch (err) {
      return toErrorEnvelope(err); // maps ZodError → VALIDATION_ERROR, AuthError → UNAUTHORIZED, etc.
    }
  };
}
```

**Reviewer detection** — wrapped actions that return an envelope directly are suspect:
```bash
rg -n "return \{\s*success:\s*(true|false)" src/app/actions/ src/services/
```
Any hit inside a function that is then passed through `withAuth(...)` / `withTenant(...)` / `withValidation(...)` is a likely BE-012 violation. Test-quality cross-reference: `test-quality.md` covers how unit tests must assert `data`/`error` fields shape, not just `success` boolean.

**Evidence:** BuchhaltGenie migration (#1907–1909) converted 66+ server actions over commits `af1ba292f`, `d39ce6ebe`, `eba3d0e2a`, `65e5a2456`, `3a3854df9` after discovering the silent-pass pattern in production.

## API Routes (Next.js)
- Use for webhooks, external API endpoints, cron jobs only.
- Server Actions preferred over API routes for internal mutations.
- Validate webhook signatures (HMAC, timing-safe comparison).
- Rate limit all public endpoints.

## Express Services
- ESM modules (`"type": "module"` in package.json).
- Helmet for security headers.
- Prom-client for Prometheus metrics.
- Structured logging with Pino.
- Health check endpoint: `GET /health` (returns 200 + uptime + version).

### Graceful Shutdown
- Handle `SIGTERM` and `SIGINT` signals to drain connections before exiting.
- Call `server.close()` to stop accepting new connections, then wait for in-flight requests to complete.
- Set a forced exit timeout (10s) to prevent hanging: `setTimeout(() => process.exit(1), 10_000).unref()`.
- Return 503 during shutdown drain if a load balancer continues sending traffic.
- Close database connections and flush logs after the HTTP server is closed.
- Wrap `app.listen()` in `if (process.env.NODE_ENV !== 'test')` so test imports don't start the server.

### API + Worker Split (ROLE pattern)
Split api and worker into separate processes when any of these apply: queue-based jobs (BullMQ / pg-boss), CPU-heavy jobs (>500ms or >256MB), long-running jobs (p95 >10s), external binaries (Chromium / ffmpeg / pandoc), or ≥1 worker-bound endpoint that would block the HTTP server.

- **Single codebase, env-var routing:** set `ROLE=api|worker|both`; a generic router in `src/role-router.ts` starts only the subsystems for that role.
- **Default:** `ROLE=both` in `docker-compose.yml` — no split needed until traffic or job characteristics demand it.
- **Scale-out:** `docker-compose.scaled.yml` in `templates/docker-service/` launches `api` and `worker` as separate services. Scale workers independently: `docker compose up -d --scale worker=N`.
- **Redis:** prefer an external managed Redis instance for production. An in-compose Redis service is commented-optional in the scaled template.

### Logging & Error Tracking
- Use `@goetzendorfer/logger` (Pino-based) for structured logging. Initialize with `new Logger()`, set level via `LOG_LEVEL` env var.
- Never log PII (emails, names, IBANs, Steuernummer). Use UUIDs and correlation IDs instead.
- Use `req.id` or `x-request-id` header for request correlation. Inject into logger context.
- Log levels: `error` (failures), `warn` (degraded), `info` (request lifecycle), `debug` (dev only).
- Cross-references: structured logging in `infrastructure.md`, DSGVO PII rules in `security-compliance.md`.

### Sentry Integration
- **SDK selection:** Next.js App Router → `@sentry/nextjs` | Express/Docker → `@sentry/node` | Swift → `sentry-cocoa`.
- **Init order (Express):** `initSentry()` → `express()` → security middleware → `express.json()` → routes → `Sentry.setupExpressErrorHandler(app)` (last, before error handler).
- **PII redaction:** Configure `beforeSend` to strip `authorization`/`cookie` headers and redact `request.data`. Configure `beforeBreadcrumb` to scrub emails/IBANs from URLs and messages using a regex redactor. Extend to `beforeSendTransaction` and `beforeSendSpan` (Sentry v8+).
- **User context:** `Sentry.setUser({ id: user.id })` after auth — never set email or name.
- **Config:** Set `environment` from `NODE_ENV`, `release` from `package.json` version. Never log `SENTRY_DSN` — it's a secret URL.

## Streaming / SSE Patterns
- Use SSE for real-time one-way data (AI streaming, live updates, long-lived event channels). Set `Content-Type: text/event-stream`.
- Send `data: [DONE]\n\n` as final event. Max 3 concurrent SSE connections per user.
- Client: `EventSource` or Vercel AI SDK `useChat`/`useCompletion`.
- Clean up on disconnect: `req.on('close')` (Express) or `signal.aborted` (Next.js).

### SSE vs WebSocket decision
- **SSE** — one-way server→client, HTTP/1.1 friendly (proxies, CDNs, auth middleware all pass through), `EventSource` auto-reconnect is built-in. **Prefer for:** AI token streaming, dashboard live updates, webhook relay, notification feeds. Default choice.
- **WebSocket** — bidirectional, higher proxy complexity (requires `Upgrade` header handling end-to-end). **Prefer only when:** client→server messages share the channel (chat, collaborative editing, RPC over long-lived connection) AND polling / separate POST is insufficient.
- Rule of thumb: if the client would otherwise open a second HTTP request per action, SSE is correct. If every user keystroke or cursor move must hit the server, WebSocket is correct.

### Heartbeat cadence
- Send a comment-line heartbeat every **30s** (`: heartbeat\n\n`) to keep intermediaries (nginx, Vercel, Cloudflare, corporate proxies) from timing out idle connections.
- Comment lines are ignored by `EventSource`, so they don't fire client `onmessage` handlers — zero client-side cost.
- If the stream is genuinely noisy (>1 event/sec steady), heartbeat is optional. If there are natural silence windows, heartbeat is mandatory.

### Event-name convention
- Named events (`event: <name>\n`) instead of untyped `data:` payloads, so client code reads `source.addEventListener('<name>', ...)` rather than switching on payload shape.
- Naming: lowercase, dot-scoped, noun-verb. Examples: `draft.ready`, `classification.done`, `job.failed`, `stream.heartbeat`, `stream.end`.
- Scope events by domain, not by endpoint. Two endpoints emitting `job.failed` is fine if the payload shape is identical.
- Document the event catalog in the service's `CLAUDE.md` or `docs/api.md` — consumers need to know what to listen for without reading source.

### Client reconnect pattern
- `EventSource` reconnects automatically on network drop. Use the `Last-Event-ID` header to resume from the last received ID — set `id: <number>\n` on each server event for this to work.
- Server must accept `Last-Event-ID` (header or `?lastEventId=` query fallback) and replay missed events from its buffer. If no buffer, skip resume and send a `stream.reset` event so the client discards stale UI state.
- Bound reconnect attempts on the client side only if the UI should give up (e.g., "connection lost, reload"). For always-on dashboards, let the browser's default backoff (0 → 3s → 30s) run.

### Auth on SSE endpoints
- `EventSource` has **no API to send custom headers** — cannot use `Authorization: Bearer ...`.
- Options, in order of preference:
  1. **Cookie-based session** (same-origin / strict SameSite cookie) — works transparently, preferred for first-party dashboards.
  2. **Short-lived token in query string** (`?token=<jwt>`) — acceptable when session cookies are unavailable. Token TTL ≤5 min, single-use if possible, never logged (strip from access logs).
  3. **Upgrade to `fetch()` + `ReadableStream`** if the client library supports it (Vercel AI SDK does). This allows custom headers.
- Never put long-lived tokens in query strings — they end up in server logs, browser history, and referer headers.

### Minimal server outline (Hono / Express / Next.js shape)
```ts
// Hono example (mail-assistant pattern)
app.get('/events', streamSSE(async (stream) => {
  const onDraft = (payload) => stream.writeSSE({ event: 'draft.ready', data: JSON.stringify(payload), id: String(++seq) });
  emitter.on('draft.ready', onDraft);
  const hb = setInterval(() => stream.writeSSE({ data: ': heartbeat' }), 30_000);
  stream.onAbort(() => { clearInterval(hb); emitter.off('draft.ready', onDraft); });
}));
```
Evidence: mail-assistant `apps/daemon/src/api.ts` (`GET /events`) — event-driven Hono SSE with heartbeat + `EventEmitter` fan-out.

## Health Check Response Schema
- **Liveness** (`GET /health`): `{ status: "ok", uptime, version }` — HTTP 200, no external calls.
- **Readiness** (`GET /health/ready`): `{ status: "ok"|"degraded"|"unhealthy", checks: { database, redis, ... } }` — 2s timeout per check, 503 if critical check fails.
- **Liveness alias** (`GET /health/live`): `{ status: "ok" }` — Kubernetes convention.
- **Detailed** (`GET /health/detailed`): Full diagnostics (API-key protected).
- All health endpoints excluded from rate limiting, auth, and access logging. Use `createHealthRouter()` from `templates/shared/src/health.ts.template`.

## Retry with Exponential Backoff
- Config: 3 attempts, base 1s, max 30s, jitter enabled. Formula: `min(base * 2^attempt + random(0, base), max)`.
- Only retry transient errors (5xx, network timeouts, ECONNRESET). Never retry 4xx.
- Circuit breaker: 5 consecutive failures in 60s → open for 30s → return 503.
- Log every retry attempt with attempt number, delay, and error reason.
- Implement as a generic `withRetry<T>(fn, opts)` wrapper. See `@goetzendorfer/http-client` for `fetchWithRetry()`.

## API Response Shapes
Uses the canonical envelope from the [Canonical API Response Envelope](#canonical-api-response-envelope-sec-009) section above.
- **List variant:** `{ success: true, data: T[], count: number }` — always include total count for pagination.
- **Status codes:** 200 (success), 201 (created), 204 (deleted, no body), 400/401/403/404/409/429/500 per standard codes above.

## API Design Patterns

### Pagination (Cursor-based)
- Use `?cursor=<opaque_id>&limit=20`. Return `{ data: T[], nextCursor: string | null, hasMore: boolean }`.
- Default limit: 20, max: 100. Cursor = opaque base64-encoded `id` or `created_at`. Never use offset pagination for large datasets.

### Versioning
- URL prefix: `/api/v1/`, `/api/v2/`. Max 2 concurrent versions. Deprecate with `Sunset` header.
- Breaking changes (removed fields, renamed endpoints) → new version. Non-breaking → current version.

### Filtering & Sorting
- Convention: `?filter[status]=active&sort=-created_at&limit=20`. `-` prefix for descending.
- Validate all filter/sort fields against an allowlist. Reject unknown fields with 400.

## Error Handling Patterns
- Use typed error classes: base `AppError(statusCode, message, code)` with subclasses like `NotFoundError`, `ValidationError`.
- Distinguish operational errors (expected: 4xx, recoverable) from programmer errors (unexpected: 5xx).
- Express: centralize in a single `(err, req, res, next)` handler mapping `AppError` subclasses to responses.
- Next.js Server Actions: try/catch → return canonical error envelope. Never throw (triggers error boundary).

## External API Integration
- User-supplied URLs: `safeFetch()`/`safeFetchJSON()` from `@goetzendorfer/http-client` (SEC-014). Trusted URLs: `fetchWithTimeout()`/`fetchWithRetry()`.
- **Error classification:** Use `classifyError()` from `@goetzendorfer/http-client/errors` to convert raw fetch errors into typed classes (`NetworkError`, `TimeoutError`, `HttpError`, `ValidationError`, `SSRFBlockedError`). Check `error.isRetryable()` for retry decisions.
- Wrap in service classes. Apply retry + circuit breaker (see sections above). Timeout: 30s default.
- Log request/response (minus sensitive data) for debugging.

## API Documentation
- Generate OpenAPI 3.1 specs from Zod schemas using `@asteasolutions/zod-to-openapi`.
- Use the helpers from `@goetzendorfer/zod-schemas/openapi`: `createOpenAPIRegistry()`, `registerSchema()`, `generateOpenAPIDocument()`.
- Register every request/response Zod schema in the OpenAPI registry. This ensures the spec stays in sync with validation logic.
- Serve the spec at `GET /api/docs/openapi.json` (raw JSON) and `GET /api/docs` (Scalar UI via `@scalar/express-api-reference`).
- Reuse canonical envelope schemas (`ApiErrorSchema`, `apiSuccessSchema`) in route registrations.
- Register routes via `registry.registerPath()` with method, path, request, and response schemas.
- Keep the registry setup co-located with route definitions or in a dedicated `src/routes/docs.ts` module.
- See `templates/express-service/src/routes/docs.ts.template` for reference implementation.

## Distributed Tracing (OpenTelemetry)
- Use OpenTelemetry SDK with OTLP exporter for all backend services. Express: `src/lib/tracing.ts` (import first, before express). Next.js: `src/instrumentation.ts` (`register()` hook).
- Environment variables: `OTEL_SERVICE_NAME` (default: package name), `OTEL_EXPORTER_OTLP_ENDPOINT` (default: `http://localhost:4318`), `OTEL_ENABLED` (default: false in dev, true in prod).
- Auto-instrument HTTP, Express, and database clients. Disable `fs` instrumentation to reduce noise. Skip `/health` and `/metrics` from traces.
- Span naming: `HTTP ${method} ${route}` for HTTP spans, `${db.system} ${operation}` for DB spans, `${service}.${method}` for custom spans. Use normalized routes (`:id` not UUIDs) to prevent high cardinality.
- Add custom spans for: external API calls, database transactions, message queue operations, and any operation >100ms. Use `tracer.startActiveSpan()` with `span.end()` in `finally`.
- Inject `traceId` into Pino log bindings for log-trace correlation. Use `trace-context` middleware to expose `req.traceId`.
- Call `shutdown()` during graceful shutdown to flush pending spans before process exit.
- Backend: Grafana Tempo. See `infrastructure.md` > Tracing Backend.

## Bounded Ring-Buffer for Admin Observability
- Fixed-capacity FIFO ring buffer of recent backend events (exits, errors, rate-limit hits, quota exhaustion) exposed via an authenticated admin endpoint. In-memory only — **zero DB overhead**, intended for rapid diagnosis between scrapes.
- **When to use:** gateway / proxy / worker services that need to answer "what just happened?" without adding a logs table or waiting for the next Prometheus scrape. Not a replacement for metrics or logs; a complement for operator triage.
- **Size guidance:** 50 entries minimum (useful diagnostic depth), 1000 entries maximum (memory bound). Default to `200` unless service-specific tuning applies. Per-entry payload stays small — event type, timestamp, `backendId`/`handlerId`, classification code, optional error summary string (≤256 chars). No stack traces, no request bodies.
- **TTL:** default `30min`. Entries older than TTL are dropped on read (lazy eviction) even if the ring has capacity — prevents stale data dominating the buffer during low-traffic periods.
- **Endpoint:** `GET /admin/backend-status` with filters (`backend`, `classification`, `since`, `limit`). **Admin-only** — must sit behind the same auth boundary as `/health/detailed`. Never expose on the public base path.
- **Code outline:**
  ```ts
  interface RingEntry<T> { ts: number; payload: T }
  class RingBuffer<T> {
    private buf: RingEntry<T>[] = [];
    constructor(private size: number, private ttlMs: number) {}
    push(payload: T) {
      this.buf.push({ ts: Date.now(), payload });
      if (this.buf.length > this.size) this.buf.shift();
    }
    read(filter?: (p: T) => boolean, limit = 100): RingEntry<T>[] {
      const cutoff = Date.now() - this.ttlMs;
      return this.buf
        .filter(e => e.ts >= cutoff && (!filter || filter(e.payload)))
        .slice(-limit);
    }
  }
  ```
- **Evidence:** ai-gateway `src/backends/exit-log.ts` + `src/routes/admin.ts` (L144–231), commit `e249190`. Clank uses an equivalent `BoundedMap` FIFO pattern for its event bus (50–1000 entries).
- **Reusable helper:** candidate for `@goetzendorfer/http-client` or a dedicated `@goetzendorfer/ringbuffer` package if demand grows past 2 consumer repos.

## Feature Flags
- Use environment-variable-backed typed flags as default (see `docs/feature-flags.md`).
- Naming convention: `FF_<FEATURE_NAME>` in `.env`.
- Every flag must have an expiry date. Remove within 30 days of full rollout.

## AI Provider Abstraction

### Rule: No Direct Provider SDK in Business Logic
- NEVER import `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`, or other provider SDKs directly in business logic (`src/app/`, `src/routes/`, `src/services/`).
- Use the **Vercel AI SDK** (`ai` package) as the unified abstraction layer. It provides `generateText()`, `streamText()`, `generateObject()` with provider-agnostic APIs.
- Route all LLM calls through `ai-gateway` (centralized proxy) for usage tracking, rate limiting, and credential management.

### Allowed Import Locations
- `src/lib/ai/` — AI client setup, model configuration, provider initialization
- `src/providers/` — Custom provider adapters (e.g., local model integration)
- `tests/` — Test files may import SDKs directly for mocking

### Environment Configuration
```
AI_GATEWAY_URL=https://ai.gotzendorfer.at   # Centralized proxy
AI_GATEWAY_TOKEN=<from env>                  # Auth token
AI_DEFAULT_MODEL=claude-sonnet-4-20250514    # Default model
AI_FALLBACK_PROVIDER=openrouter              # Fallback when primary unavailable
```

### Pattern: AI Client Factory
```typescript
// src/lib/ai/client.ts — single point of AI configuration
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const provider = createAnthropic({
  baseURL: process.env.AI_GATEWAY_URL,
  apiKey: process.env.AI_GATEWAY_TOKEN,
});

export async function askAI(prompt: string, options?: { model?: string; maxTokens?: number }) {
  return generateText({
    model: provider(options?.model ?? process.env.AI_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514'),
    prompt,
    maxTokens: options?.maxTokens ?? 4096,
  });
}
```

### Anti-Patterns
- Importing `@anthropic-ai/sdk` in a route handler or server action — use `askAI()` from `src/lib/ai/`.
- Hardcoding model names in business logic — use environment variables or the client factory.
- Calling LLM APIs without going through ai-gateway — breaks usage tracking and rate limiting.
- Creating multiple provider instances — use a single shared client from `src/lib/ai/client.ts`.

## AI Observability

**Token Tracking**
- Wrap every LLM call with token tracking. Two patterns:
  - Vercel AI SDK: use `onFinish` callback on `generateText()`/`streamText()` — extracts `usage.promptTokens`, `usage.completionTokens`
  - Anthropic SDK direct: read `response.usage.input_tokens`, `response.usage.output_tokens`
- Log to `ai_usage_log` table (see Supabase migration template)
- Include: `userId`, `feature` (which app feature triggered the call), `model`, `provider`, `tokensInput`, `tokensOutput`, `costUsd`, `durationMs`, `finishReason`
- Validate log entries with `aiUsageLogSchema` from `@goetzendorfer/zod-schemas`

**OTel Span Attributes**
- Every LLM call MUST create an OTel span with these attributes (following OpenTelemetry Semantic Conventions for GenAI):
  - `gen_ai.system`: provider name (anthropic, openai, etc.)
  - `gen_ai.request.model`: model identifier
  - `gen_ai.response.model`: actual model used (may differ from request)
  - `gen_ai.usage.input_tokens`: prompt token count
  - `gen_ai.usage.output_tokens`: completion token count
  - `gen_ai.response.finish_reasons`: array of finish reasons
  - Custom: `ai.cost.usd` (calculated cost), `ai.feature` (app feature), `ai.duration_ms`
- Span name: `gen_ai.{operation}` (e.g., `gen_ai.generate`, `gen_ai.stream`)
- Set span status to ERROR on LLM failures (rate limit, context length exceeded, model overloaded)

**Cost Attribution**
- Calculate cost per call: `(tokensInput * inputPrice + tokensOutput * outputPrice)` using model pricing lookup
- Maintain a pricing table (env var or config): model → price per 1K input/output tokens
- Aggregate in `ai_usage_daily` materialized view: per-user, per-feature, per-model daily rollups
- Dashboard query pattern: `SELECT feature, SUM(cost_usd) FROM ai_usage_log WHERE created_at >= now() - interval '30 days' GROUP BY feature ORDER BY 2 DESC`

**Budget Enforcement**
- Middleware pattern: check `ai_budget_config` table before every LLM call
- Two limit types: `dailyLimitUsd` and `monthlyLimitUsd`
- Soft limit (alert at `alertThresholdPct`): log warning + Discord notification via Clank webhook
- Hard limit (`hardLimit: true`): return 429 with `{ code: 'AI_BUDGET_EXCEEDED', message: 'AI-Budget ueberschritten' }` using canonical error envelope
- Override: admin endpoint to temporarily increase limits
- Validate config with `aiBudgetConfigSchema` from `@goetzendorfer/zod-schemas`

**Error Codes for AI Failures**
- `AI_RATE_LIMITED` (429): provider rate limit hit → retry with exponential backoff
- `AI_CONTEXT_LENGTH` (400): input too long → truncate or summarize
- `AI_MODEL_OVERLOADED` (503): model unavailable → fall back to `AI_FALLBACK_PROVIDER`
- `AI_BUDGET_EXCEEDED` (429): budget limit hit → block request, notify admin
- `AI_CONTENT_FILTERED` (400): content policy violation → return safe error message
- Map all to canonical `ApiError` envelope. Never expose raw provider errors to client.

**Anti-Patterns**
- Calling LLM APIs without token tracking — all calls must be logged
- Hardcoding model pricing — use config-driven lookup table
- Skipping OTel spans for "quick" AI calls — every call needs observability
- Returning raw provider error messages to client (exposes internal details)
- Checking budget after the LLM call (check before, enforce before spending)

## See Also
development.md · security.md · security-web.md · security-compliance.md · testing.md · test-quality.md · frontend.md · backend-data.md · infrastructure.md · observability.md · swift.md · mvp-scope.md · cli-design.md · parallel-sessions.md · ai-agent.md
