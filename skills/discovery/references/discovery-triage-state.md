# Discovery — Discovery Triage State (#419)

> Reference of the `discovery` skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.

## Discovery Triage State (#419)

Persistent triage state prevents re-presenting the same finding on every `/discovery` run. State is stored in an append-only JSONL file and keyed by a stable fingerprint.

### State File

**Location:** `.orchestrator/metrics/discovery-triage.jsonl` (gitignored via `.orchestrator/metrics/*.jsonl` pattern — machine-local, never committed)

**Format:** One JSON object per line:
```json
{"fingerprint":"aabb1122ccdd3344","state":"dismissed","user_decision":"intentional — debug log","timestamp":"2026-05-17T10:00:00.000Z","session_id":"deep-2"}
{"fingerprint":"eeff5566aabb7788","state":"promoted-to-#119","issue_id":119,"timestamp":"2026-05-17T10:01:00.000Z","session_id":"deep-2"}
```

### Fingerprint

`computeFingerprint({probe, file, severity, ruleId})` → 16-char hex (sha256 prefix).

`line_number` is **intentionally excluded** — it drifts on refactoring without the underlying issue changing. A finding is considered "the same" as long as the probe, file path, severity, and ruleId match.

### State Enum

| State | Meaning |
|---|---|
| `open` | Actively needs triage or was explicitly marked for re-review |
| `dismissed` | User dismissed as intentional or false positive — suppressed on future runs |
| `accepted-as-known` | Known issue, accepted without creating a VCS issue — suppressed on future runs |
| `reopened` | Previously suppressed but re-surfaced by user decision — shown again |
| `promoted-to-#NNN` | VCS issue created; shown informational ("tracked in #NNN") on future runs |

### Re-run Semantics

On each `/discovery` run, Phase 5 loads the state file and partitions findings before presenting them:

- **New findings** (no fingerprint entry) → always shown
- **`open` or `reopened`** → shown for triage
- **`dismissed` or `accepted-as-known`** → suppressed (silent — no user interaction needed)
- **`promoted-to-#NNN`** → informational line only ("tracked in #NNN")

A suppressed finding re-appears only if its fingerprint changes — i.e., the probe, file path, severity, or ruleId changes. No TTL on dismissed state.

### Module

`scripts/lib/discovery/triage-state.mjs` — pure ESM, Node stdlib only. Exports:
- `computeFingerprint({probe, file, severity, ruleId}): string`
- `loadTriageState(stateFilePath?): Promise<Map<fingerprint, entry>>`
- `appendTriageEntry(stateFilePath, entry): Promise<void>`
- `filterFindings({findings, stateMap}): {toShow, suppressed, tracked}`

