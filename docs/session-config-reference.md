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
| `enforcement-gates` | object | null | Per-gate toggles for enforcement hooks. Keys: `path-guard`, `command-guard`, `post-edit-validate`. Values are booleans. Missing keys default to enabled. Example: `{ path-guard: true, command-guard: true, post-edit-validate: false }`. Combined with `enforcement` (which controls strict/warn/off globally). |
| `reasoning-output` | boolean | `false` | Enable STATE:/PLAN: structured reasoning markers in agent prompts. When true, agents emit short transparency lines before tool calls. Opt-in — adds prompt overhead. |
| `grounding-check` | boolean | `true` | Enable file-level grounding verification in session-end Phase 1.1a (planned vs touched files). When true, session-end compares each agent's declared file scope against `git diff --name-only $SESSION_START_REF..HEAD` and reports scope creep + incomplete coverage. Informational — does not block session close. |
| `isolation` | string | `auto` | Agent isolation mode: `worktree`, `none`, or `auto`. Auto = worktree for feature/deep, none for housekeeping. |
| `max-turns` | integer or string | `auto` | Maximum agent turns before PARTIAL. Auto: housekeeping=8, feature=15, deep=25. |

## Planning

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `plan-baseline-path` | string | none | Path to projects-baseline directory (e.g., `~/Projects/projects-baseline`). Required for `/plan` skill. Error if missing when `/plan` is invoked. |
| `plan-default-visibility` | string | `internal` | Default repo visibility for `/plan new`: `internal`, `private`, or `public`. |
| `plan-prd-location` | string | `docs/prd/` | Directory where PRD documents are saved (relative to project root). |
| `plan-retro-location` | string | `docs/retro/` | Directory where retrospective documents are saved (relative to project root). |

## Vault Sync

Opt-in configuration for the `vault-sync` quality gate at session-end (see `skills/vault-sync/SKILL.md`). The gate validates YAML frontmatter against the canonical `vaultFrontmatterSchema` and flags dangling wiki-links across a markdown knowledge base. Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-sync` object, e.g. in `CLAUDE.md`:

```yaml
vault-sync:
  enabled: true
  mode: warn
  vault-dir: .
  exclude: [ "**/_MOC.md", "**/_overview.md", "**/README.md" ]
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-sync.enabled` | boolean | `false` | If true, session-end runs the vault-sync validator as part of Phase 2 Quality Gate. When false (or missing), the gate is skipped silently. |
| `vault-sync.mode` | string | `warn` | Gate severity. `hard` blocks session close on frontmatter/schema errors. `warn` reports errors in the quality gate report but does not block. `off` bypasses the validator entirely (useful during onboarding when `enabled` is flipped on but the vault is not yet clean). Dangling wiki-links are always warnings regardless of mode. |
| `vault-sync.vault-dir` | string | project root (`$PWD`) | Directory to scan for `.md` files. Passed to the validator via `VAULT_DIR`. Accepts absolute or project-relative paths. |
| `vault-sync.exclude` | list of glob strings | `[]` | File patterns to skip during validation (e.g. `**/_MOC.md`, `**/README.md`, `**/_overview.md`). Legitimate index files that do not carry full note frontmatter should be listed here. Matching files are counted in `excluded_count` but are not validated. Supports `**`, `*`, and `?` wildcards (fnmatch-style). |

## Defaults

If no `## Session Config` section exists in CLAUDE.md, skills use: `feature` type, 6 agents, 5 waves, and field-specific defaults listed above.
