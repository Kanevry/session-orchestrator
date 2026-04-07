# Session Config Reference

> Canonical field reference for Session Config. All skills reference this file instead of maintaining inline copies.
> Users: see `docs/USER-GUIDE.md` Section 4 for examples and usage guidance.

## Config File Location

- **Claude Code**: Add `## Session Config` to your project's `CLAUDE.md`
- **Codex CLI**: Add `## Session Config` to your project's `AGENTS.md`

The format and all fields are identical on both platforms. The section header must be exactly `## Session Config`.

## Session Structure

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `session-types` | list | `[feature]` | Which session types this repo supports. Controls what `/session <type>` accepts. |
| `agents-per-wave` | integer or integer with overrides | `6` | Maximum parallel subagents per wave. Supports session-type overrides: `6 (deep: 18)` outputs `{"default": 6, "deep": 18}`. Plain integers remain plain. |
| `agent-mapping` | object | null | Optional mapping of role keys to agent names for explicit agent binding. Keys: `impl`, `test`, `db`, `ui`, `security`, `compliance`, `docs`, `perf`. Example: `{ impl: code-editor, test: test-specialist }`. Overrides auto-discovery when present. |
| `waves` | integer | `5` | Number of execution waves for feature and deep sessions. |
| `recent-commits` | integer | `20` | Number of recent commits to display during session start git analysis. |
| `special` | string | none | Repo-specific instructions. Freeform text that the orchestrator reads and follows during sessions. |

## VCS & Infrastructure

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vcs` | string | auto-detect | Version control platform: `github` or `gitlab`. Auto-detected from git remote URL if not set. |
| `gitlab-host` | string | from remote | Custom GitLab hostname. Only needed if the host cannot be inferred from the git remote URL. |
| `mirror` | string | `none` | Mirror target after push. Set to `github` to automatically push to a GitHub remote after every session commit. |
| `cli-tools` | list | none | CLI tools available in this project (e.g., `glab`, `vercel`, `supabase`, `stripe`). Informs the orchestrator what commands it can use. |
| `cross-repos` | list | none | Related repositories under `~/Projects/`. The orchestrator checks their git state and critical issues during session start. |
| `pencil` | string | none | Path to a `.pen` design file (relative to project root). Enables design-code alignment reviews after Impl-Core and Impl-Polish waves. |
| `ecosystem-health` | boolean | `false` | Enable service health checks at session start. Requires `health-endpoints` to be configured. |
| `health-endpoints` | list | none | Service URLs to check health. Each entry is an object with `name` and `url` fields. |
| `issue-limit` | integer | `50` | Maximum issues to fetch when querying VCS during session start. |
| `stale-branch-days` | integer | `7` | Days of inactivity before a branch is flagged as stale. |
| `stale-issue-days` | integer | `30` | Days without progress before an issue is flagged for triage. |

## Quality

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `test-command` | string | `pnpm test --run` | Custom test command. Used by quality gates for all test invocations. |
| `typecheck-command` | string | `tsgo --noEmit` | Custom TypeScript check command. Set to `skip` for non-TS projects. |
| `lint-command` | string | `pnpm lint` | Custom lint command. Used by the Full Gate quality check at session end. |
| `ssot-files` | list | none | Single Source of Truth files to track for freshness (e.g., `STATUS.md`, `STATE.md`). Flagged if older than `ssot-freshness-days`. |
| `ssot-freshness-days` | integer | `5` | Days before an SSOT file is flagged as stale during session start. |
| `plugin-freshness-days` | integer | `30` | Days before the plugin itself is flagged as potentially outdated. |

## Discovery

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `discovery-on-close` | boolean | `false` | Run discovery probes automatically during `/close`. |
| `discovery-probes` | list | `[all]` | Probe categories to run: `all`, `code`, `infra`, `ui`, `arch`, `session`. |
| `discovery-exclude-paths` | list | `[]` | Glob patterns to exclude from discovery scanning (e.g., `vendor/**`, `dist/**`). |
| `discovery-severity-threshold` | string | `low` | Minimum severity for reported findings: `critical`, `high`, `medium`, `low`. |
| `discovery-confidence-threshold` | integer | `60` | Minimum confidence score (0-100) for discovery findings to be reported. Findings below this threshold are auto-deferred. |

## Persistence & Safety

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `persistence` | boolean | `true` | Enable session resumption via STATE.md and session memory files. |
| `memory-cleanup-threshold` | integer | `5` | Recommend `/memory-cleanup` after N accumulated session memory files. |
| `learning-expiry-days` | integer | `30` | Days until a learning expires. Confirmed learnings get their expiry reset. Adjust based on project velocity. |
| `enforcement` | string | `warn` | Hook enforcement level for scope and command restrictions: `strict`, `warn`, or `off`. |
| `isolation` | string | `auto` | Agent isolation mode: `worktree`, `none`, or `auto`. Auto = worktree for feature/deep, none for housekeeping. |
| `max-turns` | integer or string | `auto` | Maximum agent turns before PARTIAL. Auto: housekeeping=8, feature=15, deep=25. |

## Planning

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `plan-baseline-path` | string | none | Path to projects-baseline directory (e.g., `~/Projects/projects-baseline`). Required for `/plan` skill. Error if missing when `/plan` is invoked. |
| `plan-default-visibility` | string | `internal` | Default repo visibility for `/plan new`: `internal`, `private`, or `public`. |
| `plan-prd-location` | string | `docs/prd/` | Directory where PRD documents are saved (relative to project root). |
| `plan-retro-location` | string | `docs/retro/` | Directory where retrospective documents are saved (relative to project root). |

## Defaults

If no `## Session Config` section exists in CLAUDE.md, skills use: `feature` type, 6 agents, 5 waves, and field-specific defaults listed above.
