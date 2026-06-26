---
globs:
  - src/lib/db/**
  - src/lib/cache/**
  - src/services/db/**
  - supabase/**
  - migrations/**
  - src/lib/redis/**
  - src/lib/queue/**
tier: wave-only
---
# Backend Data Rules (Path-scoped)

## Database (Supabase)
- RLS on every table. No exceptions.
- Never use `service_role` key in client-side code.
- Generate types after schema changes: `pnpm db:types` or `supabase gen types typescript`.
- Naming: snake_case for tables and columns.
- Always include `created_at`, `updated_at` timestamps.
- Soft-delete pattern where appropriate (`deleted_at` column + RLS filter).
- Connection pooling: use Supabase's built-in connection pooler (port 6543) for serverless environments. Direct connections (port 5432) for long-lived services.
- Query optimization: use `.select()` to limit returned columns. Avoid `select('*')` in production code.

## GDPR Cascade Deletion (DSGVO Art. 17)
- On account deletion, ALL personal data must be cascade-deleted. No orphaned PII.
- Use PostgreSQL `ON DELETE CASCADE` on foreign keys referencing `auth.users`. For complex cases, create a `delete_user_data(user_id uuid)` RPC function that handles all tables in the correct order.
- Audit trail retention: anonymize PII fields (`SET name = NULL, email = NULL`) or replace with a one-way hash rather than hard-deleting rows required for compliance.
- Define retention periods per table: invoices/receipts 7 years (AT BAO tax law), access logs 90 days, session data 30 days, marketing consent until withdrawal.
- Immutable-retention regimes (AT BAO §132): corrective fixes MUST INSERT a new row with `effective_from = fix-date` — never UPDATE historical rows. Read semantics: highest `effective_from <= query_date` wins.
- Soft-delete users first (`deleted_at` + anonymize PII), then hard-delete after retention period expires via a scheduled cleanup job.
- Cache invalidation: on deletion, purge all cache keys for the user (`v1:user:{id}`, related entities).
- Test cascade deletion in integration tests: insert a full user graph, call `delete_user_data()`, assert zero rows with that `user_id` across all PII-bearing tables.

## Migration Patterns
- Migrations: timestamped SQL files in `supabase/migrations/`. Test migrations before applying to production.
- Always write reversible migrations: include both `up` and `down` logic.
- Zero-downtime strategy: add new columns as nullable first, backfill, then add NOT NULL constraint in a follow-up migration.
- Never rename columns directly in production — add new column, migrate data, drop old column across 3 separate migrations.
- Lock-safe: avoid `ALTER TABLE ... ADD COLUMN ... DEFAULT` on large tables (takes ACCESS EXCLUSIVE lock in older PG). Use backfill instead.
- Test migrations against a local Supabase instance (`supabase start`, `supabase db reset`) before pushing to staging/production.
- One logical change per migration file. Never combine unrelated schema changes.
- Migration ordering: production Supabase tracks creation order in `supabase_migrations.schema_migrations`; a naive `*.sql` glob lex-sorts by filename. A back-dated date prefix (seq `020` dated earlier than the dependency at seq `017`) runs out of dependency order and fails on the missing column. Sort by the 6-digit sequence, or drop the date prefix entirely (sequence-only naming).
- Glob recursively: `for f in supabase/migrations/*.sql` is non-recursive — nested files (rsync without trailing slash, `migrations/migrations/`) are silently skipped and old ones re-run with no error and no log. Use `find supabase/migrations -name "*.sql" | sort`, plus a post-deploy `ls … | wc -l` local-vs-staging sanity check.
- History drift: migrations applied via the SQL Editor do NOT update `supabase_migrations.schema_migrations`, so the next `supabase db push` re-applies them. Run `supabase migration repair --status applied <version> --linked` for each untracked migration first; always dry-run/compare the expected list (`supabase migration list --linked`) before pushing.
- Seed files must be explicitly listed in `supabase/config.toml [db.seed] sql_paths` — a missing file is a silent skip, not a loud error. Verify each new seed actually ran by checking its `RAISE NOTICE` output in `db:reset`.
- SQLite→Postgres trajectory (typical v1→v2): add a ~100-LOC lint banning SQLite-dialect tokens (`PRAGMA`, `AUTOINCREMENT`, `WITHOUT ROWID`, `ROWID`, `BLOB`, `DATETIME`) in migration SQL and wire it fail-fast into the lint gate from day 1 — a SQLite-only test suite will NOT catch dialect lock-in (e.g. a duplicate `CREATE TABLE schema_migrations`).
- Single-row config/toggle tables: enforce row-count=1 at the DB layer with a boolean singleton PK + `ON CONFLICT DO NOTHING` seed — idempotent migration:
```sql
singleton_id boolean PRIMARY KEY DEFAULT true,
CONSTRAINT one_row CHECK (singleton_id = true)
-- seed: INSERT ... ON CONFLICT DO NOTHING
```

## RLS Performance (MUST)

Supabase RLS policies can degrade query performance 10-100x without these optimizations. Full checklist with examples: see the baseline `security-compliance` rules § RLS Performance Checklist (not vendored into this plugin).

- **Index policy columns:** Every column referenced in an RLS policy MUST have a btree index. Missing indexes are the #1 RLS performance killer.
- **Wrap `auth.uid()` in `(SELECT ...)`:** Use `(SELECT auth.uid())` instead of bare `auth.uid()`. This enables PostgreSQL initPlan caching (9ms vs 179ms on 100K rows).
- **Specify `TO authenticated`:** Always specify the target role to stop execution early for unauthenticated users.
- **Avoid joins in policies:** Use `IN` or `ANY` subqueries instead of join chains.
- **Never use `user_metadata`:** Users can modify `raw_user_meta_data` client-side. Use `raw_app_meta_data` (server-only) instead.
- **`service_role` bypasses RLS — policies become dead code:** an admin/`service_role` client bypasses RLS entirely, so RLS INSERT/UPDATE policies on server-written tables never evaluate; superuser/`psql` probes prove nothing. Verify policies under `SET LOCAL ROLE authenticated` + `request.jwt.claims`, or route writes through the session client if RLS must enforce. When a migration `REVOKE`s table privileges, audit every `SECURITY INVOKER` function that writes there.

## View Security (MUST)

- All PostgreSQL views accessing RLS-protected tables MUST use `security_invoker = true` (PostgreSQL 15+). Without it, views execute as the view owner (typically superuser), bypassing RLS entirely.
```sql
-- UNSAFE: view bypasses RLS (executes as owner)
CREATE VIEW my_view AS SELECT * FROM protected_table;

-- SAFE: view respects caller's RLS policies
CREATE VIEW my_view WITH (security_invoker = true) AS SELECT * FROM protected_table;
```
- This applies to ALL views exposed via Supabase client queries.
- For materialized views, RLS does not apply — use explicit `WHERE` clauses and restrict access via `GRANT`.
- **`SECURITY DEFINER` functions run as the OWNER, not the caller:** `current_user` is fixed to the function owner, so a `current_user`-based allowlist bypass is internally inconsistent (owner-in-list → always bypasses, the allowlist is useless; owner-not-in-list → never bypasses by role). For caller-aware logic use `SECURITY INVOKER`, `session_user`, or a hybrid (`current_user = session_user AND …`). A txn-local GUC gate is the safe escape hatch for immutability triggers while RLS stays the primary barrier.

## PostgREST & Supabase Operational Gotchas

- **Reload the PostgREST schema cache after DDL:** after `ALTER TABLE ADD COLUMN` or a new RPC, PostgREST keeps a STALE schema cache → silent `PGRST204` for the new column for hours. Reload by sending `SIGUSR1` to the rest container (`docker kill --signal=SIGUSR1 <supabase_rest_*>`); `NOTIFY pgrst` alone is NOT sufficient. Apply atomically with the migration and confirm the column landed in prod with `psql \d`.
- **PostgREST silently caps at 1000 rows:** any Supabase query without `.range()` returns at most 1000 rows → skewed aggregations (the "everything is exactly 1000" tell). Always paginate full-dataset queries in scripts and tools.
- **`pg` (node) returns `numeric`/`bigint`/`interval`/`time` as JS STRINGS** (precision preservation): at Zod boundaries use `z.coerce.number()`, never `z.number()` — the latter passes lint/typecheck but throws only in prod (e.g. when a SECURITY DEFINER RPC's numeric score hits the validator). Catch it with an integration smoke test, not unit mocks.
- **Validate enum/CHECK-column INSERTs against REAL Postgres:** unit mocks accept any string, so they cannot prove a ternary mapping (e.g. `disposition → report|enforce`) is load-bearing. Run the INSERT through actual Postgres (`docker exec … psql`) — right-sized vs a full-app E2E when the changed flow is DB-level.

## Caching
- Upstash Redis for distributed caching and rate limiting.
- Cache invalidation strategy: explicit invalidation on mutation, TTL as fallback.
- Never cache user-specific sensitive data without encryption.
- Cache key convention: `{service}:{entity}:{id}` (e.g., `bg:invoice:uuid-123`).
- Default TTL: 5 minutes for API responses, 1 hour for config, 24 hours for static lookups.

## Queue Processing
- BullMQ + Redis for job queues.
- Stalled job protection: lock duration, stalledInterval.
- Idempotent job processing (handle duplicates gracefully).
- Dead letter queue for persistent failures.

## Cache Strategy

### TTL-Based Caching
- Use Upstash Redis for distributed caching. Key format: `v1:{entity}:{id}`.
- Default TTLs: user profiles 5min, config/settings 15min, public listings 1min.
- Probabilistic early expiration to prevent thundering herd: refresh at `TTL * 0.8 + random(0, TTL * 0.2)`.

### Cache-Aside Pattern
- Read: check cache → if miss, fetch from DB → write to cache → return.
- Write: update DB → invalidate cache (never update cache directly on write).
- Use `JSON.stringify`/`JSON.parse` for complex objects. Validate shape on read (cache corruption safety).

```ts
// Cache-aside with explicit invalidation
async function getUser(id: string): Promise<User> {
  const cached = await redis.get(`v1:user:${id}`);
  if (cached) return JSON.parse(cached) as User;

  const user = await supabase.from('users').select().eq('id', id).single();
  await redis.set(`v1:user:${id}`, JSON.stringify(user.data), { ex: 300 });
  return user.data as User;
}

// On mutation — invalidate, never update cache directly
async function updateUser(id: string, data: Partial<User>): Promise<void> {
  await supabase.from('users').update(data).eq('id', id);
  await redis.del(`v1:user:${id}`);
}
```

### Cache Key Conventions
- Format: `v{version}:{entity}:{identifier}` (e.g., `v1:user:uuid`, `v1:invoice:uuid`).
- Bump version prefix when schema changes (invalidates all old keys).
- Namespace by environment: `{env}:v1:user:uuid` in shared Redis instances.

### Cache Warming
- Post-deployment: warm critical caches (frequently accessed configs, feature flags).
- Use background jobs, not blocking startup.
- Monitor cache hit rate — alert if < 80% sustained.

## N+1 Query Prevention

### Detection
- Enable query logging in development: log all Supabase queries with timing.
- Watch for patterns: N identical queries in a single request handler.
- Use `performance.mark()` / `performance.measure()` to profile request handlers.

### Prevention with Supabase
- Use embedded selects: `.select('*, profiles(*)')` instead of separate queries.
- Batch fetching: `.in('id', ids)` instead of looping `.eq('id', id)`.
- For complex joins: use Supabase views or RPC functions.
- Limit `.select()` to needed columns — avoid `select('*')` in production.

### Patterns to Avoid
- `for (const item of items) { await supabase.from('x').select().eq('id', item.id) }` — use `.in()` instead.
- Fetching parent then children separately when a join would suffice.
- Multiple sequential queries that could be parallelized with `Promise.all()`.

## Realtime Subscriptions

### Supabase Realtime Setup
- Enable Realtime on tables via Supabase Dashboard → Database → Replication.
- Subscribe pattern: `supabase.channel('name').on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, handler).subscribe()`.
- RLS applies to Realtime — users only receive events for rows they can SELECT.

### Client-Side Management
- Always unsubscribe on component unmount: `supabase.removeChannel(channel)` in useEffect cleanup.
- Handle reconnection: Realtime auto-reconnects, but re-subscribe if channel enters `CLOSED` state.
- Debounce rapid updates: batch UI updates from high-frequency channels.

### Best Practices
- Limit subscriptions per client (max 10 concurrent channels recommended).
- Use specific filters (`filter: 'user_id=eq.uuid'`) to reduce payload volume.
- Never subscribe to entire tables without filters in production.
- Monitor Realtime connections via Supabase Dashboard metrics.

## Query Performance & Profiling
- Run `EXPLAIN ANALYZE` before deploying complex queries (joins, subqueries, CTEs). Review actual vs estimated rows.
- Index strategy: always index foreign keys. Use composite indexes for frequently combined WHERE clauses (leftmost prefix rule).
- Use `pg_stat_statements` (enabled by default in Supabase) to identify slow queries. Review weekly.
- Alert threshold: log and review any query exceeding 100ms. Investigate and optimize queries exceeding 500ms.
- Connection pooling: use Supabase's pgbouncer (port 6543) for serverless/edge functions. Direct connections (port 5432) for long-lived backend services.
- Avoid `SELECT *` in production queries. Always specify needed columns with `.select('col1, col2')`.
- Pagination: use cursor-based pagination (keyset) for large datasets. Offset-based pagination degrades at high offsets.
- Keyset over OFFSET when the dataset is MUTATED inside the paging loop (dedup, enrichment, cleanup): page on an immutable PK (`WHERE r.id > p_cursor_id`), never OFFSET — mutating WHERE-filter writes break the stable physical row order OFFSET depends on, silently skipping or re-visiting rows.
- Batch operations: use `.upsert()` or `.insert()` with arrays instead of individual inserts in loops.

## See Also
development.md · security.md · security-web.md · testing.md · frontend.md · backend.md · swift.md · mvp-scope.md · cli-design.md · parallel-sessions.md
