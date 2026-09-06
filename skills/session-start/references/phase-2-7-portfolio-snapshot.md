# Phase 2.7: GitLab Portfolio Snapshot (#41)

> Sub-file of the session-start skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-start/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 2.7: GitLab Portfolio Snapshot (#41)

> Skip this phase if `gitlab-portfolio.enabled` is not `true` in Session Config (default: `false`). Also skip silently when `vault-integration.enabled` is `false` or `vault-integration.vault-dir` is absent.

When active, this phase surfaces a compact portfolio health banner at session-start without writing any file. It runs in **dry-run mode only** — the full write path is reserved for the `/portfolio` command.

### Config check

```bash
PORTFOLIO_ENABLED=$(echo "$CONFIG" | jq -r '."gitlab-portfolio".enabled // false')
VAULT_ENABLED=$(echo "$CONFIG" | jq -r '."vault-integration".enabled // false')
VAULT_DIR=$(echo "$CONFIG" | jq -r '."vault-integration"."vault-dir" // empty')
PORTFOLIO_MODE=$(echo "$CONFIG" | jq -r '."gitlab-portfolio".mode // "warn"')

if [ "$PORTFOLIO_ENABLED" != "true" ] || [ "$VAULT_ENABLED" != "true" ] || [ -z "$VAULT_DIR" ]; then
  exit 0  # silent no-op
fi
if [ "$PORTFOLIO_MODE" = "off" ]; then
  exit 0  # silent no-op
fi
```

### Dispatch

Invoke `scripts/lib/gitlab-portfolio/cli.mjs` in dry-run mode (same orchestrator used by `/portfolio`):

```bash
node scripts/lib/gitlab-portfolio/cli.mjs \
  --vault-dir "$VAULT_DIR" \
  --dry-run \
  --session-start-snapshot   # instructs cli.mjs to emit the compact JSON summary for banner rendering
```

The CLI emits a single-line JSON to stdout:

```json
{ "repos": 16, "openIssues": 42, "critical": 3, "stale": 5, "lastRefresh": "2026-05-16T08:00:00Z" }
```

### Banner rendering

Parse the JSON and render the banner into the Session Overview:

```
📊 Portfolio: 16 repos · 42 open issues · 3 critical · 5 stale (>30d)
    Last refresh: 2026-05-16 08:00 UTC
    Run /portfolio to refresh.
```

### Failure behavior

Governed by the `mode` field from `gitlab-portfolio:` config:

- `warn` (default): if the CLI exits non-zero or emits invalid JSON, append `⚠ partial (<X>/<N> repos failed)` to the banner and continue session-start normally. Do NOT halt.
- `strict`: if the CLI fails, emit a single-line banner `❌ portfolio snapshot failed — run /portfolio for details` into the Session Overview. Do NOT halt session-start — session-start must never be blocked by portfolio failures.
- `off`: silent no-op (already handled by the config check above).

### Performance budget

Must complete within **8 seconds** for portfolios of ≤16 repos (matches the D3 timeout used by vault-staleness and CI-status probes). If the CLI has not exited after 8 seconds, terminate it, skip banner rendering, and emit a single WARN line to `.orchestrator/metrics/sweep.log`:

```json
{"timestamp":"<ISO>","event":"portfolio-snapshot-timeout","detail":{"timeout_ms":8000}}
```

Proceed to Phase 3 without blocking.

### Cross-reference

See `commands/portfolio.md` for the `/portfolio` command (full write path, `--dry-run`, `--repo` single-repo testing).

