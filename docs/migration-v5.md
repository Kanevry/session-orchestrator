# Migrating to Session Orchestrator v5.0.0

Version 5 changes the agent-status deep-import API and enables close-time discovery by default. Node 24+, the four supported harnesses and the session state formats remain unchanged. No ledger rewrite is required.

## Agent-status reader

Consumers importing `readCurrentStatus` from `scripts/lib/agent-status.mjs` must stop treating its return value as the agent-id map. It now returns:

```js
const view = readCurrentStatus({ repoRoot });
// { entries, source, at, degraded? }
const agent = view.entries[agentId];
```

For the former bare-map interface, change the imported function and call site:

```js
import { readCurrentStatusEntries } from 'session-orchestrator/scripts/lib/agent-status.mjs';
const entries = readCurrentStatusEntries({ repoRoot });
const agent = entries[agentId];
```

Both readers use the same recovery rules. `agent-status.jsonl` is the source of truth; `agent-status-current.json` is a rebuildable cache. Results combine cache and ledger per agent, preferring the newest timestamp. The bounded ledger read defaults to 256 KiB (`maxBytes` can be specified).

| `source` | Meaning |
| --- | --- |
| `live-map` | Cache entries verified against the ledger. |
| `rebuilt-log` | At least part of the view was recovered from the ledger. |
| `stale-cache` | Only unverified cache data is usable. |
| `absent` | Neither ledger nor cache supplies status; normal for a new repo. |

`at` is an ISO timestamp or `null`. Inspect optional `degraded` details before presenting recovered state as healthy. Entry maps have a null prototype: use `Object.entries`, `Object.keys` or `Object.hasOwn` rather than calling `entries.hasOwnProperty`. The `binding` field is optional; absence means the entry came from cache, not that it is bound to the current session.

Find consumers before upgrading:

```sh
rg 'readCurrentStatus|agent-status-current.json' scripts hooks
```

Update callers and verify their missing-data and stale-cache paths. Direct readers of the cache should use the status API if they need recovery and provenance. Existing JSONL and cache files do not need deletion or conversion.

## Close-time discovery default

When Session Config omits `discovery-on-close`, `/close` now runs its discovery scan. The value `auto` also resolves to enabled. This adds one Explore agent and any critical/high issue findings consume the configured issue budget.

To retain the previous disabled behavior, put this in the existing Session Config block:

```yaml
discovery-on-close: false
```

An explicit `true` or `false` retains its meaning. No new account permission or scheduler is introduced.

## Operations route

The new time-bounded operations route is selected by the documented session-start entry conditions. It records a deadline, scope, queue and evidence expectations inside the current harness. It does not start a separate automation, replace a peer session lock, or change the development session schema. Existing development entry points remain available.

## Rollback

Pin the package or plugin checkout to 4.2.0 and restore any caller changes that depend on the v5 API. A `readCurrentStatusEntries` import is new in this release and cannot be assumed on 4.2.0. Preserve existing state files. If you explicitly set `discovery-on-close: false`, it is also understood by 4.2.0.

Full changes: [CHANGELOG.md](../CHANGELOG.md).
