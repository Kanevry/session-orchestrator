# Ingest Server Deploy Runbook

Operator runbook for deploying the anonymous usage-telemetry ingest server
(`server/ingest/`) to `https://telemetry.session-orchestrator.com`. Epic #841,
S6 / GitLab #847; PRD
[`docs/prd/2026-07-20-anonymous-usage-telemetry.md`](../prd/2026-07-20-anonymous-usage-telemetry.md)
§2 "Deploy runbook".

This page is public (this repo is mirrored to GitHub) and contains
**placeholders only** — no real hostnames, IPs, ssh aliases, or account names.
The operator fills in every placeholder from their own private ops notes; see
the legend in [§0](#0-prerequisites--placeholder-legend) below. The two
exceptions are `session-orchestrator.com` and its `telemetry.` subdomain,
which are public by design — that is the whole point of this deployment.

Every step below pairs an exact command with a verification command and an
expected result. Do not consider a step done until the verification output
matches.

## 0. Prerequisites & Placeholder Legend

- SSH access to `<SSH_USER>@<SERVICE_HOST>` (the app-container host) and
  `<SSH_USER>@<EDGE_HOST>` (the Caddy TLS edge).
- `vercel` CLI installed and logged in to the account that manages
  `session-orchestrator.com` DNS.
- `docker` + `docker compose` (v2 plugin) on `<SERVICE_HOST>`.
- `git` and `rsync` available locally.

| Placeholder | Meaning | Where it comes from |
|---|---|---|
| `<EDGE_HOST>` | SSH-reachable hostname/alias of the Caddy TLS-termination edge | private ops notes |
| `<EDGE_IPV4>` | Public IPv4 of `<EDGE_HOST>`, used for the DNS `A` record | private ops notes |
| `<CADDY_CONTAINER>` | Docker container name of the Caddy instance running on `<EDGE_HOST>` (`NetworkMode=host`) | private ops notes |
| `<SERVICE_HOST>` | Hostname/alias of the app-container host the ingest server runs on | private ops notes |
| `<SERVICE_HOST_PRIVATE_IP>` | Private-VLAN IP of `<SERVICE_HOST>`, reachable only from `<EDGE_HOST>` | private ops notes |
| `<SSH_USER>` | SSH login user for both hosts | private ops notes |

**None of these real values live in this repository.** The operator resolves
them from a private ops notebook before running any command below.

## 1. Build the image on `<SERVICE_HOST>`

Only `server/ingest/` plus this compose file are needed on the host — a full
repo checkout is unnecessary. `rsync` just that subtree:

```sh
rsync -avz --delete \
  server/ingest/ \
  <SSH_USER>@<SERVICE_HOST>:/opt/services/telemetry-ingest/server/ingest/
```

The compose file's `build.context: ../..` expects the same two-levels-up
layout locally, so mirror the compose file to the parent directory it expects
(`/opt/services/telemetry-ingest/`), one level above the synced `server/`
subtree:

```sh
rsync -avz server/ingest/docker-compose.yml \
  <SSH_USER>@<SERVICE_HOST>:/opt/services/telemetry-ingest/server/ingest/docker-compose.yml
```

Build the image:

```sh
ssh <SSH_USER>@<SERVICE_HOST> \
  "cd /opt/services/telemetry-ingest/server/ingest && docker compose build"
```

**Verify:**

```sh
ssh <SSH_USER>@<SERVICE_HOST> "docker images | grep telemetry-ingest"
```

Expected: one `ingest-telemetry-ingest` (or similarly-named, compose-project-prefixed)
image row, built moments ago.

## 2. Start the container

The container binds to the **private VLAN address only** — never
`0.0.0.0` — so it is unreachable except via the Caddy edge:

```sh
ssh <SSH_USER>@<SERVICE_HOST> \
  "cd /opt/services/telemetry-ingest/server/ingest && \
   BIND_ADDR=<SERVICE_HOST_PRIVATE_IP> PORT=3300 docker compose up -d"
```

**Verify — container healthy:**

```sh
ssh <SSH_USER>@<SERVICE_HOST> \
  "docker inspect --format '{{.State.Health.Status}}' telemetry-ingest"
```

Expected: `healthy` (allow up to the Dockerfile's `start-period=5s` +
one `interval=30s` cycle before it settles).

**Verify — reachable from the edge, NOT from your laptop:**

```sh
# From <EDGE_HOST> (expected: {"status":"ok"})
ssh <SSH_USER>@<EDGE_HOST> \
  "curl -fsS http://<SERVICE_HOST_PRIVATE_IP>:3300/healthz"

# From your local machine (expected: connection failure — this is CORRECT,
# the private VLAN is not routable from outside <SERVICE_HOST>/<EDGE_HOST>)
curl -fsS --max-time 3 http://<SERVICE_HOST_PRIVATE_IP>:3300/healthz || \
  echo "unreachable as expected"
```

**Verify — WAL volume is a LOCAL mount, not NFS (load-bearing gotcha):**
SQLite WAL mode needs shared-memory-backed file locking that network
filesystems do not reliably provide (see `server/ingest/README.md` §
Storage). Confirm the volume's backing filesystem before trusting the data
directory:

```sh
ssh <SSH_USER>@<SERVICE_HOST> \
  "docker volume inspect ingest_telemetry-data --format '{{.Mountpoint}}'"
# then, using that Mountpoint path:
ssh <SSH_USER>@<SERVICE_HOST> "df -T <mountpoint-from-above>"
```

Expected: a local filesystem type (`ext4`, `xfs`, `apfs`, `btrfs`, …) — never
`nfs`, `nfs4`, `cifs`, or `smbfs`. If it IS a network filesystem, stop here
and relocate the Docker data-root or bind-mount a local path before
proceeding — do not run this service on network-backed storage.

## 3. Caddy vhost on `<EDGE_HOST>`

Create `sites/80-telemetry.caddy` alongside the existing `sites/*.caddy`
files (imported via `import sites/*.caddy` in the root Caddyfile):

```caddyfile
telemetry.session-orchestrator.com {
	import security_headers
	reverse_proxy <SERVICE_HOST_PRIVATE_IP>:3300 {
		header_up X-Forwarded-For {remote_host}
	}
	log {
		output discard
	}
}
```

`log { output discard }` disables access logging for this vhost only — this
is a hard PRD requirement (client IPs must never be persisted anywhere in
this pipeline, including web-server access logs), not a style choice.

`header_up X-Forwarded-For {remote_host}` verhindert XFF-Spoofing — der
Ingest-Server rate-limitet sonst auf einem client-kontrollierten Wert
(CWE-348). Dies ist Defense-in-Depth am Edge; der serverseitige Fix
(right-most-Hop statt left-most beim Parsen von `X-Forwarded-For`) läuft
parallel in `server/ingest/`.

**Validate the Caddyfile:**

```sh
ssh <SSH_USER>@<EDGE_HOST> \
  "docker run --rm -v /opt/.../caddy:/etc/caddy caddy:2-alpine \
     caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
```

Expected: exit 0, output ending in `Valid configuration`.

**Reload Caddy:**

```sh
ssh <SSH_USER>@<EDGE_HOST> \
  "docker exec <CADDY_CONTAINER> caddy reload --config /etc/caddy/Caddyfile"
```

**Verify:**

```sh
ssh <SSH_USER>@<EDGE_HOST> \
  "docker exec <CADDY_CONTAINER> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
```

Expected: exit 0.

## 4. DNS

`session-orchestrator.com` DNS is managed by Vercel. A wildcard `*` record
already points at Vercel's own edge; adding an explicit `telemetry` `A`
record overrides the wildcard **for that subdomain only** — nothing needs to
be removed beforehand:

```sh
vercel dns add session-orchestrator.com telemetry A <EDGE_IPV4>
```

**Verify (allow a few minutes for propagation):**

```sh
dig +short telemetry.session-orchestrator.com A @1.1.1.1
```

Expected: `<EDGE_IPV4>`. Before this record propagates, the same query
resolves to Vercel's own IPs (the wildcard) — that is the "before" state, not
an error.

## 5. Live smoke test

**Health endpoint:**

```sh
curl -s -o /dev/null -w "%{http_code}" https://telemetry.session-orchestrator.com/healthz
```

Expected: `200`.

**Valid record (usage-ping v1 — field list per `docs/telemetry.md`):**

```sh
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://telemetry.session-orchestrator.com/v1/records \
  -H 'Content-Type: application/json' \
  -d '{
    "record_kind": "usage-ping",
    "schema_version": 1,
    "anon_id": "4c9c9c1a-7e3b-4c1a-9c3b-1a7e3b4c1a9c",
    "sent_at": "2026-07-20T12:00:00.000Z",
    "plugin_version": "3.16.0",
    "platform": "claude",
    "os": "darwin",
    "arch": "arm64",
    "node_major": 24,
    "ci": false,
    "fleet": false,
    "session_type": "housekeeping",
    "duration_bucket": "<15m",
    "skills": ["session-start"],
    "commands": ["/close"]
  }'
```

Expected: `202`.

**Invalid record — unknown `record_kind`:**

```sh
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://telemetry.session-orchestrator.com/v1/records \
  -H 'Content-Type: application/json' \
  -d '{"record_kind": "not-a-real-kind", "schema_version": 1}'
```

Expected: `400`.

**Oversized body (> 32 KB body cap):**

```sh
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://telemetry.session-orchestrator.com/v1/records \
  -H 'Content-Type: application/json' \
  -d "{\"record_kind\": \"usage-ping\", \"pad\": \"$(head -c 40000 </dev/zero | tr '\0' 'a')\"}"
```

Expected: `413`.

**SQLite row landed (on `<SERVICE_HOST>`, confirms the valid-record POST
above was actually persisted):**

```sh
ssh <SSH_USER>@<SERVICE_HOST> \
  "docker exec telemetry-ingest node -e \
    \"const {DatabaseSync} = require('node:sqlite'); \
      const db = new DatabaseSync('/data/records.db', {readOnly: true}); \
      console.log(db.prepare('SELECT COUNT(*) AS n FROM records').get());\""
```

Expected: `{ n: <N> }` with `N >= 1`.

## 6. Rollback

```sh
# 1. Remove the DNS record (find its id first)
vercel dns ls session-orchestrator.com
vercel dns rm <record-id>

# 2. Remove the Caddy vhost and reload
ssh <SSH_USER>@<EDGE_HOST> "rm /opt/.../caddy/sites/80-telemetry.caddy"
ssh <SSH_USER>@<EDGE_HOST> \
  "docker exec <CADDY_CONTAINER> caddy reload --config /etc/caddy/Caddyfile"

# 3. Stop the ingest container (data volume is preserved — add `-v` only if
#    the intent is to also destroy the stored records)
ssh <SSH_USER>@<SERVICE_HOST> \
  "cd /opt/services/telemetry-ingest/server/ingest && docker compose down"
```

## 7. Operations

- **Retention.** The server prunes raw records older than
  `SO_INGEST_RETENTION_MONTHS` (default 24) on an internal schedule
  (`SO_INGEST_RETENTION_INTERVAL_MS`, default daily) — no manual step is
  required in normal operation. To force a one-off prune:

  ```sh
  ssh <SSH_USER>@<SERVICE_HOST> \
    "docker exec telemetry-ingest node server/ingest/retention.mjs"
  ```

  Expected output: `{"deleted":N}`.

- **Digest.** A weekly aggregate-digest job (`server/ingest/digest.mjs`)
  covers the most recently COMPLETED ISO week (Mon..Sun), never the
  in-progress current week. Run it on demand (or on a schedule) with:

  ```sh
  ssh <SSH_USER>@<SERVICE_HOST> \
    "docker exec telemetry-ingest node server/ingest/digest.mjs --db /data/records.db --out /data/digests"
  ```

  This writes `<week>.json` and `<week>.md` to `/data/digests`. The JSON
  artifact is the SSOT — built exclusively from the aggregate query shape,
  never raw `anon_id` values, only a `distinctAnonIds` count — and the
  Markdown artifact is a derived VIEW rendered from that JSON, not a second
  source of truth.

- **Updating the deployed image:**

  ```sh
  # from your local checkout — re-sync sources
  rsync -avz --delete server/ingest/ \
    <SSH_USER>@<SERVICE_HOST>:/opt/services/telemetry-ingest/server/ingest/

  # on the host — rebuild and replace the running container
  ssh <SSH_USER>@<SERVICE_HOST> \
    "cd /opt/services/telemetry-ingest/server/ingest && \
     docker compose build && \
     BIND_ADDR=<SERVICE_HOST_PRIVATE_IP> PORT=3300 \
       docker compose up -d --force-recreate"
  ```

  Verify with the health + SQLite-row checks in [§5](#5-live-smoke-test)
  after every update.

## See Also

- [`docs/telemetry.md`](../telemetry.md) — public transparency page: what is
  collected, what never is, consent mechanics, kill switches, retention.
- [`server/ingest/README.md`](../../server/ingest/README.md) — module map,
  HTTP API contract, full env-var configuration table.
