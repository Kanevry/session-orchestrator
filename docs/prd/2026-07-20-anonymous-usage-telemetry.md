# Feature: Anonymous Usage Telemetry — Opt-in Client + record_kind-generic Ingest

**Date:** 2026-07-20
**Author:** Bernhard + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 2w (Medium Batch)
**Parent Project:** session-orchestrator

## 1. Problem & Motivation

### What

An opt-in, anonymized usage-telemetry pipeline: a client layer inside the plugin (consent management, whitelist-projected usage pings, offline-tolerant batch sync) plus a minimal self-hosted ingest server on existing Hetzner infrastructure. The server accepts a **generic `record_kind` envelope** from day 1 — `usage-ping` now; `session-eval` submissions (leaderboard, existing design notes) and anonymized `learning` submissions (emergent rule library) attach later without a server rebuild.

### Why

The plugin was first published to npm on 2026-07-19 (v3.16.0). From this point on, external installs exist — and we are blind: there is **zero** measurement of what external users install, invoke, or abandon, and no backlog issue covers it. Internally, local telemetry is mature (events.jsonl 10.7k events, skill-invocations.jsonl, subagents.jsonl, eval.jsonl) and shows a hot core loop (session-start → plan → wave-executor → session-end) with a cold long tail (10+ skills with zero recorded use, ~25 opt-in config flags off by default). Product decisions — what to deepen, what to sunset (`/sunset-review` exists but has never produced a report), what to document — currently run on gut feeling. Usage data is the missing input, and the npm launch makes **now** the cheapest moment to introduce it honestly (a consent story retrofitted after growth is far more expensive, cf. Homebrew/Audacity backlashes).

### Who

- **External users** (npm / marketplace installs, Claude Code / Codex / Cursor / Pi): strictly opt-in via first-run prompt; `DO_NOT_TRACK` and env kill-switches honored; payload inspectable via debug flag.
- **The operator's own fleet** (38 of 43 portfolio repos are orchestrator-adopted, 31 active in the last 30 days): sync enabled host-locally via `owner.yaml` — an immediate, real data stream that exercises the full pipeline before any external user opts in.
- **The maintainer** (Bernhard): consumes aggregates (top skills, platform/version split, journey coverage) to drive deepen/sunset/docs decisions and, later, the emergent learnings library.

## 2. Solution & Scope

### In-Scope

- [ ] **Consent layer (client):** host-local consent state at `~/.config/session-orchestrator/telemetry.json` (never in any repo, follows the owner.yaml host-local pattern); precedence `DO_NOT_TRACK=1` > `SO_TELEMETRY_DISABLED=1` > `SO_TELEMETRY=1` > `owner.yaml telemetry.enabled` > consent file > unset→prompt. First-run consent via AskUserQuestion at session-start (interactive only; headless/CI = no prompt, no send). CLI `scripts/telemetry.mjs status|enable|disable|show` + `SO_TELEMETRY_DEBUG=1` (print payload to stderr instead of sending).
- [ ] **Usage-Ping v1 schema + projection:** versioned, additive-evolution schema (`record_kind: "usage-ping"`, `schema_version: 1`); whitelist projection in the style of eval's `SUBMISSION_FIELDS`/`projectSubmission()`; skill/command names filtered against the shipped plugin roster (unknown/custom names → `"other"` — never leak third-party or repo-specific names); rotating anonymous ID (random UUID, 90-day rotation, never machine-derived).
- [ ] **Sync engine:** batch flush at session-end (fire-and-forget POST, 3s timeout) + daily fallback flush on first skill invocation; host-local offline queue with size cap (default: max 50 batches / 256 KB, oldest-dropped) and retry on next opportunity.
- [ ] **Ingest server (`server/ingest/`, same repo, MIT):** dependency-light Node 24 service (`node:http` + `node:sqlite`), `POST /v1/records` with per-kind schema validation, unknown `record_kind` → 400, additive unknown fields accepted; SQLite WAL storage (raw JSON + indexed columns); rate limiting (IP used transiently, **never persisted**); retention pruning (raw 24 months); Dockerfile.
- [ ] **Deploy runbook:** Caddy vhost `telemetry.session-orchestrator.com` on the existing TLS edge (access-logging off), DNS record, container on the existing service host, smoke test. Operator-gated ops steps documented, not hidden.
- [ ] **Transparency docs:** public `docs/telemetry.md` ("we collect X, never Y" with the full field list, consent mechanics, kill switches, retention, pointer to the open-source server code); README re-wording of the "no server, no cloud component" claim to "local by default, optional opt-in anonymous telemetry"; reconcile with the existing `docs/telemetry/telemetry-claims.md`.
- [ ] **Read path (minimal but real):** aggregation queries (DuckDB/SQLite) + weekly digest generation (top skills/commands, active anon IDs, version/platform split, fleet vs external segmentation) so the data produces value from week 1.
- [ ] **Fleet rollout:** enable via `owner.yaml` on this host, verify across ≥3 repos, first digest reviewed.

### Out-of-Scope

- **Leaderboard UI / public stats page** on session-orchestrator.com — deliberately data-gated (per the eval PRD); the ingest envelope prepares for it, the UI is a later epic.
- **Session-eval submission wiring** (`record_kind: "session-eval"`, #815) — the server accepts the kind envelope generically, but client-side submission UX ships in its own follow-up.
- **Learnings submission / emergent rule library** — Phase-3 vision (see §4 Roadmap); requires its own anonymization review.
- **Marketplace pin refresh + submission-kit updates** (A1; pin is ~588 commits stale) — acute, but a separate distribution chore, filed independently.
- **Web analytics for session-orchestrator.com** (pageviews are Vercel's domain, unrelated to CLI telemetry).
- **Crash/error reporting** — different sensitivity class, separate consent discussion.
- **Any per-repo identifiable data** — no repo names, no paths, no git remotes, no args, no prompt text, ever (hard invariant, not a deferral).

## 3. Acceptance Criteria

### Feature Area 1 — Consent & Kill-Switches

```gherkin
Given a fresh host with no telemetry.json and no relevant env vars
When an interactive session-start runs
Then exactly one AskUserQuestion consent prompt is shown, the decision is persisted to ~/.config/session-orchestrator/telemetry.json, and no network call happens before an affirmative decision

Given DO_NOT_TRACK=1 or SO_TELEMETRY_DISABLED=1 is set
When any orchestrator code path considers emitting or flushing telemetry
Then nothing is sent, nothing is queued, and no consent prompt is shown

Given a headless/CI invocation (CI env or non-interactive) with no prior consent
When a session runs end to end
Then no prompt is shown and no telemetry is sent

Given consent was granted earlier
When the operator runs `node scripts/telemetry.mjs disable`
Then the consent file records the denial and subsequent sessions send nothing

Given SO_TELEMETRY=1 is set on a host with no consent file (fleet force-enable)
When a session runs
Then telemetry is active without any prompt, and SO_TELEMETRY_DISABLED=1 / DO_NOT_TRACK=1 in the same shell still win
```

### Feature Area 2 — Payload & Privacy Projection

```gherkin
Given a completed session with skill invocations, session type, and duration
When the usage-ping payload is built
Then it contains only whitelisted fields (record_kind, schema_version, anon_id, sent_at, plugin_version, platform, os, arch, node_major, ci, fleet, session_type, duration_bucket, skills[], commands[]) and a projection unit test proves every non-whitelisted input field is dropped

Given a skill or command name that is not part of the shipped plugin roster
When the payload is built
Then that name is replaced by "other" (roster whitelist), so custom/third-party names never leave the machine

Given SO_TELEMETRY_DEBUG=1
When a flush would occur
Then the exact payload is printed to stderr and NOT sent

Given the anon ID is older than 90 days
When the next payload is built
Then a fresh random UUID replaces it (rotation) and the old ID is discarded
```

### Feature Area 3 — Sync & Offline Queue

```gherkin
Given consent granted and a reachable endpoint
When session-end completes
Then one batched POST for the session is fired (3s timeout, fire-and-forget) and the queue is emptied on HTTP 2xx

Given the endpoint is unreachable
When a flush is attempted
Then the batch lands in the host-local queue (bounded size, oldest-dropped) and the session closes with zero user-facing error

Given queued batches exist and >24h passed since the last successful flush
When the first skill invocation of the day fires
Then a fallback flush attempt drains the queue
```

### Feature Area 4 — Ingest Server

```gherkin
Given a valid usage-ping record
When POSTed to /v1/records
Then the server validates it against the per-kind schema, stores raw JSON + indexed columns (kind, schema_version, received_day) in SQLite WAL, and returns 2xx without ever persisting the client IP

Given a record with an unknown record_kind, an oversized body (>32 KB), or a schema violation
When POSTed
Then the server rejects it (400/413) and stores nothing

Given a record with additional unknown top-level fields but a valid kind + schema_version
When POSTed
Then it is accepted (additive forward-compatibility) and the unknown fields survive in the raw JSON column

Given records older than the retention window (24 months)
When the retention prune job runs
Then they are deleted while aggregate tables remain

Given a single IP exceeds the rate limit (tunable ops constant, default 60 requests/hour)
When further records are POSTed from it
Then the server returns 429 without storing anything, and the IP is used only transiently in memory for this decision — never persisted
```

### Feature Area 5 — Fleet Mode & Read Path

```gherkin
Given owner.yaml sets telemetry.enabled: true on the operator host
When any of the adopted repos runs a session
Then payloads carry fleet: true and sync without a per-repo prompt, and SO_TELEMETRY_DISABLED=1 still wins per-shell

Given a week of ingested records
When the digest job runs
Then it produces an aggregate (top skills/commands, versions, platforms, fleet-vs-external split, active anon IDs) with zero record-level PII in the output
```

### Edge Case / Error Handling

```gherkin
Given the consent file is corrupt or unparsable
When telemetry state is read
Then the state degrades to "no consent" (fail-closed: nothing sent) and a stderr WARN suggests `telemetry status`

Given the ingest server is down for a week
When fleet repos keep working
Then sessions are never blocked or slowed beyond the 3s fire-and-forget budget, and queues cap instead of growing unbounded
```

## 4. Technical Notes

### Affected Files

- `scripts/lib/telemetry/consent.mjs` — NEW: consent state read/write, env precedence chain, headless detection.
- `scripts/lib/telemetry/schema.mjs` — NEW: usage-ping v1 field whitelist + `projectUsagePing()` (mirrors `scripts/lib/eval/schema.mjs` `SUBMISSION_FIELDS`/`projectSubmission()` pattern), roster whitelist loader (from shipped `skills/` + `commands/` inventory).
- `scripts/lib/telemetry/queue.mjs` — NEW: host-local NDJSON queue (`~/.config/session-orchestrator/telemetry-queue.ndjson`), bounded, atomic append via `scripts/lib/io.mjs` patterns.
- `scripts/lib/telemetry/sync.mjs` — NEW: batch build from local JSONL streams (session window), POST with timeout, DO_NOT_TRACK/env gating at the outermost seam.
- `scripts/telemetry.mjs` — NEW CLI: `status|enable|disable|show` with `--json` (CLI-design rules apply).
- `hooks/skill-invocation-telemetry.mjs` — EXTEND: after existing local append, trigger daily-fallback flush check (non-blocking).
- `skills/session-end/SKILL.md` — EXTEND: telemetry flush subphase (after metrics write, before summary; advisory, never blocks close).
- `skills/session-start/SKILL.md` — EXTEND: one-time consent AUQ (interactive only, once per host).
- `scripts/lib/owner-yaml.mjs` — EXTEND: `telemetry.enabled` / `telemetry.fleet` keys.
- `server/ingest/` — NEW: `server.mjs` (node:http + node:sqlite), `validate.mjs`, `retention.mjs`, `digest.mjs`, `Dockerfile`, `README.md` (excluded from the npm `files` whitelist by construction).
- `docs/telemetry.md` — NEW public transparency page; `README.md` — claim re-wording; `docs/telemetry/telemetry-claims.md` — reconcile.
- `tests/telemetry/*` — NEW: projection/roster/consent/queue/server suites incl. negative-assertion fake-regression for the privacy invariants.

### Architecture

- **Reuse over rebuild:** the client does not introduce a second event pipeline — it *projects* from the existing local JSONL streams (`skill-invocations.jsonl`, `sessions.jsonl`) at flush time. `emitEvent()` stays untouched; the optional Clank webhook remains a separate, unrelated channel.
- **Consent doctrine reuse:** the eval standard's §4 contract (opt-in, whitelist projection, no paths/prompts/repo names, `handle` optional) is the normative template; usage pings are strictly *more* anonymous (no handle in v1).
- **record_kind-generic envelope:** server validates `{record_kind, schema_version}` and dispatches to per-kind validators — `usage-ping` today; `session-eval` and `learning` register later as new validators + tables, no transport change (aligns with the eval PRD's `record_kind` reservation).
- **Schema evolution:** additive-only within a `schema_version`; breaking changes bump the version; server accepts current + previous version. This encodes the "aufbauend, best-practice-konform" requirement.
- **Deterministic constants (v1 defaults, tunable):** `duration_bucket` edges `<15m | 15–60m | 1–3h | >3h`; offline queue cap 50 batches / 256 KB (oldest-dropped); ingest rate limit 60 requests/hour/IP; POST timeout 3s; body cap 32 KB; anon-ID rotation 90 days; retention 24 months.
- **Privacy engineering:** IP never persisted (transient rate-limit use only, Caddy access log off for the vhost); anon ID random + rotating (avoids the Next.js persistent-ID correlation criticism); roster-whitelisted names; payload printable via debug flag; everything open source in this repo.
- **Ops synergy:** TLS terminates at the existing Caddy edge; the container runs on the existing multi-service host; the existing Prometheus/Grafana stack can later scrape a `/metrics` endpoint (explicitly optional, not v1 scope).

### Data Model Changes

Server SQLite (new, greenfield): `records(id, kind, schema_version, received_day, anon_id, fleet, raw_json)` + indexes on `(kind, received_day)`; `aggregates_weekly(week, kind, metric, value_json)`. Client side: no changes to existing JSONL schemas (projection is read-only); new host-local `telemetry.json` + `telemetry-queue.ndjson` outside every repo.

### API Changes

New public endpoint `POST https://telemetry.session-orchestrator.com/v1/records` (JSON body ≤32 KB, per-kind schema validation, 2xx/400/413/429). No other API surface changes.

### Roadmap (post-v1, for orientation — not scope)

1. **Phase 2:** `session-eval` submissions (existing design notes + `eval.handle`) → leaderboard data pool on the same endpoint.
2. **Phase 3:** anonymized `learning` submissions (schema has `anonymized` flag) → emergent cross-user rule library, consumed via the existing reconcile engine.
3. **Phase 4:** public aggregate stats on session-orchestrator.com fed from the digest job.

## 5. Risks & Dependencies

| Risk | Impact | Mitigation | Triage |
|------|--------|------------|--------|
| Accidental PII/identifier leak in payload | High | Whitelist projection + roster name filter + unit tests proving non-whitelisted fields drop + fake-regression test (plant a path, assert red) | Implement |
| Public write endpoint abuse (spam/DoS) | Medium | 32 KB body cap, schema validation, per-IP transient rate limit, SQLite behind Caddy; worst case: junk rows, prune | Implement |
| Trust damage from README-claim change ("no server" → telemetry exists) | High | Strict opt-in, transparency page shipped in the SAME release, debug flag, announce note; never silent | Implement |
| ePrivacy/GDPR exposure (AT operator) | Medium | Opt-in consent (Art. 5(3)-safe), no IP storage, pseudonym rotation, 24-month retention, documented | Implement |
| External opt-in rate ≈ 0 → little external data | Medium | Fleet mode delivers a real data stream from day 1; re-measure external rate 4 weeks post-release before investing further | Experiment |
| `node:sqlite` maturity on Node 24 | Low | Fallback `better-sqlite3` (SEC-020 allowlisted already); interface isolated in one module | Implement |
| Ops drift (manual Caddy/DNS steps on the edge host) | Medium | Written deploy runbook with verification commands; operator executes; smoke test in CI-adjacent script | Implement |
| Digest job rots (no consumer) | Low | Weekly digest lands as a dated artifact; first review is an explicit epic task; if unused after 8 weeks, sunset-review it | Defer |

### Dependencies

- **Domain live** (session-orchestrator.com on Vercel): DNS for the `telemetry.` subdomain must point to the ingest edge — operator step (Vercel DNS + Caddy vhost). Domain-registration issue #812 is factually done and should be closed in passing.
- **Eval standard (#803, shipped):** consent doctrine + projection pattern reused; leaderboard design notes (#815, open) consume the same envelope later.
- **Existing local telemetry (#645, shipped):** `skill-invocations.jsonl` is the primary projection source; its hook gains the daily-fallback trigger.
- **owner.yaml host-local config (#653 pattern, shipped):** carrier for fleet-mode enablement.
- **Distribution follow-ups (separate chores, not blockers):** marketplace pin refresh (~588 commits stale), submission-kit v3.16 updates.
