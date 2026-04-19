# Session Config Reference

> Canonical field reference for Session Config. All skills reference this file instead of maintaining inline copies.
> Users: see `docs/USER-GUIDE.md` Section 4 for examples and usage guidance.

## Config File Location

- **Claude Code**: Add `## Session Config` to your project's `CLAUDE.md`
- **Codex**: Add `## Session Config` to your project's `AGENTS.md`

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
| `learnings-surface-top-n` | integer | `15` | Cap on how many learnings the session-start Phase 5.6 and session-plan Step 0.5 sections surface, ranked by confidence descending. `0` = do not surface any learnings. Applies to Project Intelligence output. |
| `learning-decay-rate` | float (0.0 ≤ x < 1.0) | `0.05` | Confidence decay applied to every untouched learning at session-end (after touched-set update, before prune). `0.0` = disable decay. A learning starting at `0.5` confidence survives ~10 untouched sessions with default decay. |
| `enforcement` | string | `warn` | Hook enforcement level for scope and command restrictions: `strict`, `warn`, or `off`. |
| `enforcement-gates` | object | null | Per-gate toggles for enforcement hooks. Keys: `path-guard`, `command-guard`, `post-edit-validate`. Values are booleans. Missing keys default to enabled. Example: `{ path-guard: true, command-guard: true, post-edit-validate: false }`. Combined with `enforcement` (which controls strict/warn/off globally). |
| `allow-destructive-ops` | boolean | `false` | When `true`, disables the main-session destructive-command guard (`hooks/pre-bash-destructive-guard.mjs`). Set to `true` for intentional maintenance sessions that need `git reset --hard`, `rm -rf`, etc. Defaults to `false` (safe). See issue #155 and `.claude/rules/parallel-sessions.md` (PSA-003). Example: `allow-destructive-ops: true` |
| `reasoning-output` | boolean | `false` | Enable STATE:/PLAN: structured reasoning markers in agent prompts. When true, agents emit short transparency lines before tool calls. Opt-in — adds prompt overhead. |
| `grounding-check` | boolean | `true` | Enable file-level grounding verification in session-end Phase 1.1a (planned vs touched files). When true, session-end compares each agent's declared file scope against `git diff --name-only $SESSION_START_REF..HEAD` and reports scope creep + incomplete coverage. Informational — does not block session close. |
| `grounding-injection-max-files` | integer | `3` | Max files with recent `edit-format-friction` stagnation history to inject as line-numbered GROUNDING blocks into each agent's prompt before dispatch (wave-executor pre-dispatch step). Per-agent scope; selects top N by recency. `0` disables the feature. Gated on `persistence: true`. (#85) |
| `isolation` | string | `auto` | Agent isolation mode: `worktree`, `none`, or `auto`. Auto = worktree for feature/deep, none for housekeeping. |
| `max-turns` | integer or string | `auto` | Maximum agent turns before PARTIAL. Auto: housekeeping=8, feature=15, deep=25. |

## Planning

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseline-ref` | string (git ref) or null | null | Git ref (branch, tag, or SHA) on the baseline GitLab project from which to fetch canonical `.claude/rules/*.md` and `.claude/agents/*.md` during `/bootstrap`. When null, rules arrive via Clank's weekly baseline sync MRs (legacy path). See [baseline-ref](#baseline-ref) below. |
| `baseline-project-id` | string or number | `"52"` | GitLab project ID of the baseline repository. Defaults to `"52"` (`infrastructure/projects-baseline`). Has no effect when `baseline-ref` is unset. See [baseline-project-id](#baseline-project-id) below. |
| `plan-baseline-path` | string | none | Path to projects-baseline directory (e.g., `~/Projects/projects-baseline`). Optional. When absent, `/bootstrap` falls back to plugin-bundled minimal templates. Previously required for `/plan new` repo scaffolding; now only required if you want to scaffold from your own baseline. |
| `plan-default-visibility` | string | `internal` | Default repo visibility for `/plan new`: `internal`, `private`, or `public`. |
| `plan-prd-location` | string | `docs/prd/` | Directory where PRD documents are saved (relative to project root). |
| `plan-retro-location` | string | `docs/retro/` | Directory where retrospective documents are saved (relative to project root). |

### baseline-ref

- **Type:** string (git ref) | null
- **Default:** null
- **Used by:** bootstrap (rules-fetch bridge)

The git ref (branch name, tag, or commit SHA) on the baseline GitLab project from which to fetch canonical `.claude/rules/*.md` and `.claude/agents/*.md` during `/bootstrap`. When set, the rules-fetch bridge runs as a post-scaffold step.

When `null` (the default), rules arrive in the repo via Clank's weekly baseline sync MRs (the legacy path). Setting `baseline-ref: main` short-circuits that delay so a freshly-bootstrapped repo starts with current rules immediately.

Pin to a specific SHA for reproducible bootstraps:
```yaml
baseline-ref: a1b2c3d4
```

Or float on a branch for always-current rules:
```yaml
baseline-ref: main
```

Requires:
- `GITLAB_TOKEN` env var set with read scope on the baseline project
- `scripts/lib/fetch-baseline.sh` present in the session-orchestrator plugin

If the fetch fails (network error, auth error, missing file), bootstrap continues without aborting — rules will arrive via the legacy Clank sync path. A warning is printed.

See: session-orchestrator issue #110, projects-baseline `docs/REPO-STATUS.md`.

### baseline-project-id

- **Type:** string | number
- **Default:** `"52"` (infrastructure/projects-baseline on gitlab.gotzendorfer.at)
- **Used by:** bootstrap (rules-fetch bridge)

The numeric GitLab project ID of the baseline repository. Defaults to `"52"` which corresponds to `infrastructure/projects-baseline`. Override only when adopting this plugin against a different baseline source.

Used together with `baseline-ref`. Has no effect when `baseline-ref` is unset.

## Vault Sync

Opt-in configuration for the `vault-sync` quality gate at session-end (see `skills/vault-sync/SKILL.md`). The gate validates YAML frontmatter against the canonical `vaultFrontmatterSchema` and flags dangling wiki-links across a markdown knowledge base. Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-sync` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

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

## Vault Integration

Opt-in configuration for the `vault-mirror` auto-sync that writes learnings and session summaries into the Meta-Vault after each session (see `scripts/vault-mirror.mjs`). When enabled, the session-end skill invokes the mirror script after writing JSONL metrics, and the evolve skill mirrors new learnings after each learning atomic-rewrite. Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-integration` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-integration.enabled` | boolean | `false` | If true, session-end and evolve skills invoke `vault-mirror.mjs` to sync learnings and sessions into the vault. When false (or missing), mirroring is skipped silently. |
| `vault-integration.vault-dir` | string or null | `null` | Absolute path to the vault repository. Falls back to `$VAULT_DIR` env variable if not set. Required when `enabled` is true. |
| `vault-integration.mode` | string | `warn` | Mirror error handling. `strict` blocks session close if the mirror exits non-zero. `warn` reports errors but does not block. `off` bypasses mirror invocation entirely (useful when transitioning). |

## Defaults

If no `## Session Config` section exists in the platform config host file (`CLAUDE.md` or `AGENTS.md`), skills use: `feature` type, 6 agents, 5 waves, and field-specific defaults listed above.
