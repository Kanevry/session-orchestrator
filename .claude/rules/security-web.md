---
globs:
  - src/middleware*.ts
  - src/app/**
  - next.config.*
  - src/lib/csp*
  - src/lib/cors*
---

# Security — Web & API (Path-scoped)

CSRF, rate limiting, CSP, and transport security. Core security rules are in `security.md` (always-on).

## CSRF Protection (SEC-005)
- **Next.js 15+ Server Actions**: Built-in CSRF protection via Origin header validation against Host header. No manual CSRF token needed.
- **Manual CSRF tokens required for**: custom API routes (`/api/*`), form submissions to external endpoints, any non-Server-Action mutation endpoint.
- For manual CSRF token validation, use `crypto.timingSafeEqual()` for timing-safe comparison.
- Note: Next.js 15+ Server Actions automatically validate the Origin header against the Host header, providing CSRF protection out of the box.

## Headers & Transport
- HTTPS everywhere. No HTTP in production.
- Security headers via Helmet (Express) or Next.js config.
- CORS: explicit allow-list, never `*` in production.
- CORS origin comparison is case-sensitive in most implementations — `https://Example.com` !== `https://example.com`. Always use lowercase origins in Express/Helmet CORS allowlists. In Next.js middleware, normalize with `request.headers.get('origin')?.toLowerCase()` before comparing.

### CORS Origin Validation
- Always normalize origins with `.toLowerCase()` before comparison — some browsers send mixed-case Origin headers.
- Example:
  ```ts
  const allowedOrigins = ['https://example.com', 'https://app.example.com'];
  const origin = req.headers.origin?.toLowerCase();
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  ```
- Never use `Access-Control-Allow-Origin: *` with `credentials: true` — browsers will reject this.
- For multi-tenant: derive allowed origins from database at startup, cache with TTL.

## Content Security Policy & Headers (SEC-011)

- Every Next.js app MUST define security headers in `next.config.ts` via `headers()` on `source: '/(.*)'`.
- Every Express service MUST use `helmet()` with explicit CSP directives — never rely on defaults alone.
- CSP `default-src` MUST be `'self'`. Never use `'unsafe-eval'` in production.
- CSP `script-src`: use nonces (`'nonce-${nonce}'` + `'strict-dynamic'`) in production Next.js. `'unsafe-inline'` only in development.
- CSP `style-src`: use `'nonce-${nonce}'` in production where possible. `'unsafe-inline'` acceptable only during development or when Tailwind CSS runtime styles require it. Document retention.
- CSP `object-src: 'none'`, `base-uri: 'self'`, `form-action: 'self'`, `frame-ancestors: 'none'`.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (2 years).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` — mandatory on all routes.
- `Permissions-Policy`: deny `camera`, `microphone`, `geolocation`, `payment` unless actually used.
- Add Sentry CDN, Supabase URL, and Vercel Analytics to CSP `connect-src` as needed.
- Cookies MUST use `HttpOnly; Secure; SameSite=Lax` minimum. Use `__Host-` prefix for session cookies.
- CSP violations should be reported via `report-uri` to Sentry's CSP endpoint in production.
- CSP `report-to` directive + `Reporting-Endpoints` header is the modern replacement for `report-uri`. Both should be configured:
  - `Reporting-Endpoints: csp-endpoint="https://sentry.io/api/PROJECT_ID/security/?sentry_key=KEY"` response header
  - `report-to csp-endpoint` CSP directive (references the named endpoint)
  - Keep `report-uri` as legacy fallback for older browsers
  - Both are commented out in templates — uncomment with project-specific Sentry CSP endpoint
- Test headers with securityheaders.com before launch. Target grade A+.

### Next.js 16 CSP via proxy.ts
- Next.js 16 introduces `proxy.ts` as the recommended file for per-request header injection (CSP nonces, CORS). The baseline provides `templates/nextjs-saas/proxy.ts.template` — copy it as `proxy.ts` in the project root at setup time.
- `proxy.ts`: runs before routing, ideal for CSP nonce injection. Use for Next.js 16+ projects.
- `middleware.ts`: still works for CSP but is primarily for routing logic (auth redirects, rewrites).
- **Never set CSP in both proxy.ts AND middleware.ts.** proxy.ts is the single source for CSP. middleware.ts handles rate limiting and routing only.

#### SEC-011: CSP single-source enforcement
- Advisory rules are silent when they regress. Wire the single-source rule into a mechanical check so duplicates fail fast.
- Canonical hook: `templates/shared/hooks/check-csp-single-source.sh`. Greps all TS/JS under the given paths for `Content-Security-Policy`, filters to `proxy.ts` / `middleware.ts` / `next.config.*`, fails if more than one file matches.
- **Wire into pre-push (Husky):**
  ```json
  // package.json
  { "scripts": { "hook:check-csp": "bash templates/shared/hooks/check-csp-single-source.sh src" } }
  ```
  ```bash
  # .husky/pre-push
  pnpm run hook:check-csp
  ```
- **Wire into CI security stage:** copy the `check-csp-single-source` job from `templates/shared/hooks/README.md` into `.gitlab-ci.yml`. Runs on every merge request.
- Exit codes: `0` pass, `1` duplicate CSP source (SEC-011 violation), `2` tool error.
- Why: browsers receiving two `Content-Security-Policy` headers take the intersection — nonces and `strict-dynamic` break silently. Humans miss this in review; a grep doesn't.

#### Nonce Generation Pattern
- Generate a unique nonce per request: `const nonce = Buffer.from(crypto.randomUUID()).toString('base64');`
- Pass the nonce to Server Components via the `x-nonce` request header: `requestHeaders.set('x-nonce', nonce);`
- In Server Components, read it with `headers().get('x-nonce')` and pass to `<Script nonce={nonce}>` or inline `<script nonce={nonce}>` tags.
- Next.js automatically applies the nonce to framework scripts, bundles, and `<Script>` components when set via proxy.ts.
- The CSP header uses `'nonce-${nonce}' 'strict-dynamic'` for `script-src`, which allows nonce-tagged scripts to load their dependencies without explicit allowlisting.

#### Proxy Matcher Pattern
- The proxy matcher excludes API routes, static assets (`_next/static`, `_next/image`, `favicon.ico`), and prefetch requests (`next-router-prefetch` header, `purpose: prefetch` header).
- This avoids unnecessary nonce generation for requests that do not render HTML pages.
- Pattern: `/((?!api|_next/static|_next/image|favicon.ico).*)` with `missing` conditions for prefetch headers.

#### SRI (Subresource Integrity) as Alternative
- For fully static pages (no per-request nonce needed), enable SRI in `next.config.ts`:
  ```ts
  experimental: { sri: { algorithm: 'sha256' } }
  ```
- SRI adds `integrity="sha256-..."` attributes to `<script>` and `<link>` tags at build time, allowing `script-src 'self'` without nonces.
- **Do not combine SRI and nonces on the same page.** SRI hashes are computed at build time; nonces change per request. Mixing both creates conflicting CSP expectations and may cause script blocking.
- Use SRI for marketing/landing pages and other static content. Use nonces (via proxy.ts) for dynamic, authenticated pages.

### CSP Report-Only Mode
- Use `Content-Security-Policy-Report-Only` header to test CSP changes without blocking resources in production.
- Pattern: deploy new directives as report-only first, monitor violation reports for 1-2 weeks, then promote to enforcing `Content-Security-Policy`.
- Report endpoint: `report-uri /api/csp-report` (receives JSON violation reports). Forward to Sentry or structured logs for analysis.
- Never skip report-only. A single misconfigured directive in enforcing mode can break the entire page.
- In Next.js, set report-only header in `proxy.ts` alongside (not replacing) the enforcing CSP header.

### CSP Source of Truth (Critical)
- **Next.js projects**: `proxy.ts` is the SSOT for CSP headers. middleware.ts handles rate limiting and routing only.
- **Express/Docker projects**: `securityMiddleware()` in security.ts sets CSP via Helmet.
- **Never set CSP in both proxy.ts AND middleware.ts** — if both set Content-Security-Policy, the last writer wins (middleware.ts response overwrites proxy.ts header), creating security gaps where expected CSP directives are silently dropped.
- **Detection**: Search for `Content-Security-Policy` across all middleware files. If found in >1 file, consolidate into the SSOT.
- **Testing**: Use `CSP-Report-Only` header during development to catch violations before enforcing.

## Session Cookie Hardening (SEC-017)
- Cookie flags: `HttpOnly; Secure; SameSite=Lax` minimum on all session cookies. Use `SameSite=Strict` for admin/sensitive operations.
- Use `__Host-` prefix for session cookies: enforces `Secure`, no `Domain`, `Path=/`. Prevents cookie injection from sibling subdomains.
- Token rotation: rotate session token after login, privilege escalation, role change, or password change. Invalidate old token immediately.
- Idle timeout: 30 minutes for sensitive operations (payments, admin). Max-Age 7 days for persistent "remember me" sessions.
- Supabase Auth: `@supabase/ssr` handles cookie management. Verify that `cookieOptions` in `createServerClient()` sets `httpOnly: true`, `secure: true`, `sameSite: 'lax'`.
- Never store session tokens in `localStorage` or `sessionStorage`. Cookies with `HttpOnly` are not accessible to JavaScript (XSS-resistant).
- Logout: invalidate server-side session AND clear client cookie. Call `supabase.auth.signOut()` which handles both.

## Rate Limiting Details (SEC-003)

- All public API endpoints must enforce rate limiting. No exceptions.
- Use Upstash Redis for distributed rate limiting. Required env vars: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (add to `.env.example`).
- **Public endpoints**: `express-rate-limit` fixed window (all project types). Acceptable for general API traffic.
- **Auth endpoints** (login, register, password reset): `@upstash/ratelimit` sliding window with `@upstash/redis` (all project types — Next.js, Express, Docker). Prevents burst attacks at fixed-window boundaries.
- Next.js: `@upstash/ratelimit` + `@upstash/redis` in middleware. Express/Docker: `@upstash/ratelimit` + `@upstash/redis` in `authRateLimiter()` from shared security middleware.
- Rate limit thresholds SHOULD be configurable via environment variables (`RATE_LIMIT_REQUESTS`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_AUTH_REQUESTS`, `RATE_LIMIT_AUTH_WINDOW_MS`) with sensible defaults. Templates read these from `process.env` at startup.
- Rate limit keys: IP for unauthenticated, `userId` for authenticated, `IP + email hash` for auth endpoints.
- Use sliding window for auth endpoints (login, register, password reset) — prevents burst attacks at window boundaries.
- Apply rate limiting as early as possible in middleware — before auth and body parsing where applicable.
- Always return 429 with `Retry-After` header and `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`.
- Rate limit config: `standardHeaders: true, legacyHeaders: false` — uses IETF `RateLimit-*` headers. Response body must only contain a user-friendly error message, never internal limit configuration.
- Response body on 429: generic user-friendly message. Never expose internal limit config.
- Log every 429 with endpoint, key, window, limit. Alert when a key hits limit > 5 times in 10 minutes.
- If Redis store is unavailable, fail open with warning log — but alert immediately.

### Rate Limiting Matrix

| Endpoint Type | Window | Strategy | Anon | Auth | Premium |
|---------------|--------|----------|------|------|---------|
| Auth (login/register/reset) | Sliding, 15 min | Upstash | 5 | 10 | 10 |
| Auth (verify/token) | Sliding, 5 min | Upstash | 3 | 5 | 5 |
| Public API | Fixed, 1 min | express-rate-limit | 60 | 300 | 1000 |
| Authenticated API | Fixed, 1 min | express-rate-limit | — | 300 | 1000 |
| File Upload | Fixed, 1 min | express-rate-limit | — | 10 | 50 |
| Webhook Receiver | Fixed, 1 min | express-rate-limit | 100 | 100 | 100 |
| WebSocket Upgrade | Fixed, 1 min | Custom | 5 | 20 | 50 |

Tier detection: check `req.user.tier` after auth middleware. Anonymous = no auth token.
- Store tier definitions in config, not inline. Example: `RATE_TIERS = { anon: 60, auth: 300, premium: 1000 }`.
- If tier lookup fails (e.g., Redis unavailable), fall back to the anonymous tier — never fail open to the highest tier.
- IP-based limits still apply as a baseline layer to prevent abuse from a single source, even for premium users.

### Health/Readiness Route Bypass
Mount health routes BEFORE applying rate limiting middleware, so they remain unlimited:
```ts
// Health routes — excluded from rate limiting (SEC-003)
app.use('/health', healthRouter);
app.use('/ready', readinessRouter);

// Rate limiting applied AFTER health routes
securityMiddleware(app);
```

### Additional Rate Limit Guidance
- **Export row limits**: max 100,000 rows per export. Enforce server-side regardless of client request.
- **File upload size quotas**: 10MB per file, 50MB per request total. Enforce via middleware before body parsing.
- **WebSocket reconnection**: mandate exponential backoff on client disconnect (base 1s, max 30s, jitter).
- **Upstash sliding window**: standard for auth endpoints across all project types. `express-rate-limit` fixed window is acceptable for general public API rate limiting.
- **Search endpoints**: expensive queries (full-text search, complex joins) should have stricter limits than simple CRUD.

## Output Encoding & Escaping (SEC-016)

- **HTML**: React auto-escapes JSX output. For `dangerouslySetInnerHTML`, sanitize with DOMPurify first. Never render raw user HTML.
- **URL**: Use `encodeURIComponent()` for user data in URL parameters. Never interpolate raw user input into URLs.
- **CSV Injection**: Prefix cell values starting with `=`, `+`, `-`, `@`, `\t`, `\r` with a single quote (`'`) before export. Applies to all CSV/XLSX generation.
- **Base64**: Validate format before decoding (`/^[A-Za-z0-9+/]*={0,2}$/`). Enforce size limits (max 10MB decoded) to prevent memory exhaustion.
- **JSON**: Never use `eval()` or `new Function()` to parse JSON. Always `JSON.parse()` + Zod validation at system boundaries.
- **Log Injection**: Strip newlines (`\n`, `\r`) and ANSI escape codes (`\x1b[`) from user input before logging. Use structured logging (JSON format) to prevent log forging.
- **Template Literals**: Never use tagged template literals with user input for SQL, HTML, or shell commands. Use parameterized queries, DOMPurify, or `child_process.execFile()` respectively.

## See Also
development.md · security.md · security-compliance.md · testing.md · test-quality.md · frontend.md · backend.md · backend-data.md · infrastructure.md · swift.md · mvp-scope.md · cli-design.md · parallel-sessions.md · ai-agent.md
