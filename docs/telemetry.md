# Telemetry

Session Orchestrator ships an **optional, strictly opt-in** anonymous
usage-telemetry client. This page is the transparency contract: exactly what
is collected, what is never collected, how consent works, every kill switch,
where the data goes, and how long it is kept. Nothing here is aspirational —
it is the locked v1 schema and consent precedence this plugin implements.

## TL;DR

- **Off by default.** Nothing is sent until you explicitly consent.
- **One prompt, ever.** An interactive session asks once, at most; the
  answer is saved locally and never asked again (until you reset it).
- **Trivial to turn off**, at any time, with an environment variable or a
  one-line CLI command — no restart, no config-file archaeology.
- **No CI/headless sends, ever.** Non-interactive sessions never prompt and
  never send, regardless of prior consent state.
- **Fully open source.** The client code and the ingest-server code both
  live in this repository — nothing is a black box.
- **Not the same thing as the local metrics used in marketing claims.** See
  [Relationship to `telemetry-claims.md`](#relationship-to-telemetry-claimsmd)
  below.

## What we collect

When telemetry is enabled and a batch is flushed, the payload is built from
a strict field whitelist — nothing outside this list is ever included, and a
projection unit test enforces the drop of any non-whitelisted input field.

| Field | Meaning |
|---|---|
| `record_kind` | Always `"usage-ping"` for this record type. |
| `schema_version` | Currently `1`. Additive-only evolution within a version — see [Schema evolution](#schema-evolution). |
| `anon_id` | A random UUID, not derived from any machine identifier. Rotates every 90 days; the old ID is discarded, not linked to the new one. |
| `sent_at` | Timestamp of the flush. |
| `plugin_version` | The installed plugin's semver. |
| `platform` | One of `claude`, `codex`, `cursor`, `pi`, `other`. |
| `os` | Operating system family (e.g. `darwin`, `linux`, `win32`). |
| `arch` | CPU architecture (e.g. `arm64`, `x64`). |
| `node_major` | Major Node.js version in use. |
| `ci` | Boolean — whether the run was detected as a CI environment. |
| `fleet` | Boolean — whether this send came from an operator's own fleet-mode host (`owner.yaml` opt-in), as opposed to an external install. |
| `session_type` | One of `housekeeping`, `feature`, `deep`, `other`. |
| `duration_bucket` | One of `<15m`, `15-60m`, `1-3h`, `>3h` — a coarse bucket, never an exact duration. |
| `skills[]` | Names of invoked skills, filtered against the shipped plugin roster — any name not in that roster becomes `"other"`. |
| `commands[]` | Same filtering rule as `skills[]`. |

## What we never collect

This list is a hard invariant, not a deferral:

- No repository names, no file paths, no git remotes.
- No prompts, no session transcripts, no free-form text of any kind.
- No command arguments — only whitelisted command/skill *names*, and only
  from the shipped roster (anything else is reduced to `"other"`).
- No hostnames.
- No IP addresses stored. The ingest server uses the requester's IP
  **transiently, in memory, only** to enforce a per-IP rate limit — it is
  never written to disk, and access logging is disabled on the telemetry
  vhost.
- No email addresses, no git author identity, no account identifiers.

If a skill or command name isn't part of the plugin's own shipped roster —
including any custom or third-party skill you've added locally — it never
leaves your machine; it is projected to `"other"` before the payload is
built.

## Consent & kill switches

Precedence, highest wins:

1. **`DO_NOT_TRACK`** — any non-empty value except `0`/`false` disables
   telemetry unconditionally. This is the industry-standard signal and
   overrides everything else, including a fleet force-enable.
2. **`SO_TELEMETRY_DISABLED=1`** — explicit per-shell disable.
3. **`SO_TELEMETRY=1`** — explicit per-shell force-enable (used for fleet
   testing without touching the consent file).
4. **`owner.yaml` `telemetry.enabled`** — host-local fleet-mode opt-in (see
   below); has no effect on a machine without that file.
5. **Saved consent** — `~/.config/session-orchestrator/telemetry.json`,
   written the first time you answer the consent prompt. Never inside any
   repository, never committed.
6. **First-run prompt** — shown at most once, **interactively only**. A
   headless or CI invocation never shows this prompt and never sends
   telemetry, regardless of any saved state.

If the consent file is corrupt or unreadable, the client fails **closed**:
telemetry state degrades to "no consent" (nothing sent) rather than
guessing, with a one-line stderr hint pointing at the CLI below.

**CLI:**

```bash
node scripts/telemetry.mjs status    # show current consent + kill-switch state
node scripts/telemetry.mjs enable    # opt in
node scripts/telemetry.mjs disable   # opt out
node scripts/telemetry.mjs show      # print the last built payload, don't send
```

**Debug flag:** set `SO_TELEMETRY_DEBUG=1` to print the exact payload that
*would* be sent to stderr instead of sending it — useful for verifying the
whitelist projection yourself before ever trusting it.

**Fleet mode.** An operator running many repos on one host can set
`telemetry.enabled: true` (and optionally `telemetry.fleet: true`) in their
own `owner.yaml` — a host-local, never-committed file outside every repo —
to enable telemetry across all adopted repos without a per-repo prompt.
Records sent this way carry `fleet: true`. `DO_NOT_TRACK` and
`SO_TELEMETRY_DISABLED=1` still win over fleet mode in the same shell.

## Where it goes

Consented payloads are sent as a batched `POST` to:

```
https://telemetry.session-orchestrator.com/v1/records
```

This endpoint is operated by the plugin's maintainer. The server-side code
is open source in this same repository, under `server/ingest/` — a
dependency-light Node service that validates the payload against the
per-`record_kind` schema, stores it in SQLite, and rejects anything that
doesn't fit the schema (unknown `record_kind`, oversized body, or a schema
violation). There is no third-party analytics vendor in this path — no
Segment, no Mixpanel, no Google Analytics.

The send is fire-and-forget with a short timeout; if the endpoint is
unreachable, the batch queues locally (bounded size, oldest entries dropped
first) and retries later. Telemetry never blocks or slows down a session
beyond that short timeout budget.

## Retention

- **Raw records:** kept 24 months, then pruned. The retention window exists
  to support year-over-year product decisions (what to deepen, what to
  sunset) without keeping data indefinitely.
- **Aggregates:** kept indefinitely; aggregates carry no record-level
  identifiers by construction.
- **Anonymous ID rotation:** every 90 days, independent of retention — a
  rotated ID cannot be linked back to the one it replaced.

## Schema evolution

The schema is **additive-only** within a given `schema_version`: new
optional fields may appear, but no field is ever repurposed or removed
without a version bump. The server accepts both the current and the
immediately previous `schema_version`, so a slightly-outdated client is
never hard-broken by a server-side schema update.

## Relationship to `telemetry-claims.md`

This page describes the **opt-in, client-side usage-telemetry pipeline**
above. It is a distinct data flow from
[`docs/telemetry/telemetry-claims.md`](telemetry/telemetry-claims.md), which
documents the methodology behind the maintainer's separate **local, private**
metrics aggregates (`.orchestrator/metrics/*.jsonl`, gitignored, never
transmitted anywhere) used in marketing claims such as "645 orchestrated
sessions." Neither pipeline feeds the other.
