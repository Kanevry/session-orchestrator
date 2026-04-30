# Session Config Reference

> Canonical field reference for Session Config. All skills reference this file instead of maintaining inline copies.
> Users: see `docs/USER-GUIDE.md` Section 4 for examples and usage guidance.

## Config File Location

- **Claude Code**: Add `## Session Config` to your project's `CLAUDE.md`
- **Codex**: Add `## Session Config` to your project's `AGENTS.md`

The format and all fields are identical on both platforms. The section header must be exactly `## Session Config`.

## Schema Validation (#182)

The 7 mandatory fields enforced by `scripts/lib/config-schema.mjs` are:

| Field | Rule |
|-------|------|
| `test-command` | non-empty string |
| `typecheck-command` | non-empty string |
| `lint-command` | non-empty string |
| `agents-per-wave` | integer ≥ 2 (or object with `default` ≥ 2) |
| `waves` | integer ≥ 3 |
| `persistence` | boolean |
| `enforcement` | one of `strict` / `warn` / `off` |

Validation runs automatically via `scripts/parse-config.mjs` → `scripts/validate-config.mjs`. Behavior is driven by the `enforcement` field itself:

- `enforcement: off` → skip validation entirely
- `enforcement: warn` → print errors to stderr, still emit config (exit 0)
- `enforcement: strict` → print errors to stderr, suppress output, exit 1

Bypass via `SO_SKIP_CONFIG_VALIDATION=1`. Missing fields can be patched into an existing config file via `/bootstrap --retroactive`.

## Policy Files

Some sub-configs live in dedicated policy files under `.orchestrator/policy/`:

| File | Schema | Purpose |
|------|--------|---------|
| `blocked-commands.json` | inline | Destructive-command guard rules (#155). |
| `quality-gates.json` | `quality-gates.schema.json` | Canonical test/typecheck/lint commands (#183). Overrides the `test-command` / `typecheck-command` / `lint-command` Session Config fields when present. |

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
| `test-command` | string | `pnpm test --run` | Custom test command. Used by quality gates for all test invocations. Overridden by `.orchestrator/policy/quality-gates.json` when present (#183). |
| `typecheck-command` | string | `tsgo --noEmit` | Custom TypeScript check command. Set to `skip` for non-TS projects. Overridden by policy file when present. |
| `lint-command` | string | `pnpm lint` | Custom lint command. Used by the Full Gate quality check at session end. Overridden by policy file when present. |
| `ssot-files` | list | none | Single Source of Truth files to track for freshness (e.g., `STATUS.md`, `STATE.md`). Flagged if older than `ssot-freshness-days`. |
| `ssot-freshness-days` | integer | `5` | Days before an SSOT file is flagged as stale during session start. |
| `plugin-freshness-days` | integer | `30` | Days before the plugin itself is flagged as potentially outdated. |

## Discovery

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `discovery-on-close` | boolean | session-type aware: `false` for `housekeeping`, `true` for `feature`/`deep` (#264) | Run discovery probes automatically during `/close`. Default is `false` for housekeeping sessions and `true` for feature and deep sessions when not explicitly configured. An explicit value always overrides the session-type default. |
| `discovery-probes` | list | `[all]` | Probe categories to run: `all`, `code`, `infra`, `ui`, `arch`, `session`. |
| `discovery-exclude-paths` | list | `[]` | Glob patterns to exclude from discovery scanning (e.g., `vendor/**`, `dist/**`). |
| `discovery-severity-threshold` | string | `low` | Minimum severity for reported findings: `critical`, `high`, `medium`, `low`. |
| `discovery-confidence-threshold` | integer | `60` | Minimum confidence score (0-100) for discovery findings to be reported. Findings below this threshold are auto-deferred. |
| `discovery-parallelism` | integer | `5` | Maximum probe agents dispatched in parallel per category during Phase 3. Bounds: `1..16`; out-of-range values silently fall back to the default. Raise for large stacks to reduce wall-clock, lower to relieve a busy host. |

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
| `isolation` | string | `auto` | Agent isolation mode: `worktree`, `none`, or `auto`. `auto` resolves per-wave via the graduated default (#194): ≤2 agents → `none`, 3–4 agents on feature/deep → `worktree`, ≥5 agents → `worktree`, housekeeping 3–4 → `none`. Explicit `worktree` or `none` overrides the graduation. See [isolation graduation](#isolation-graduation) below. |
| `max-turns` | integer or string | `auto` | Maximum agent turns before PARTIAL. Auto: housekeeping=8, feature=15, deep=25. |

## Environment Awareness (v3.1.0)

Introduced by Epic #157 / issue #166. Lets session-start sense the host (RAM, CPU, SSH, peer sessions) and adapt wave planning accordingly. All fields are opt-in defaults — a project without this block behaves identically to v3.0.0.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `resource-awareness` | boolean | `true` | Master toggle for the env-aware runtime. When `false`, skips Phase 4.5 adaptive wave sizing and the host banner. |
| `enable-host-banner` | boolean | `true` | Whether `hooks/on-session-start.mjs` emits the host + resource banner at the top of every session. Set `false` to silence. |
| `resource-thresholds` | object | see below | Numeric thresholds that drive Phase 4.5 adaptive rules. Unset sub-keys fall back to defaults. Sub-keys: `ram-free-min-gb`, `ram-free-critical-gb`, `cpu-load-max-pct`, `concurrent-sessions-warn`, `ssh-no-docker`, `zombie-threshold-min`. |

### resource-thresholds

Sub-key defaults:

```yaml
resource-thresholds:
  ram-free-min-gb: 4            # below this, cap agents-per-wave at 2
  ram-free-critical-gb: 2       # below this, recommend coordinator-direct
  cpu-load-max-pct: 80          # sustained above this, cap agents-per-wave at 2
  concurrent-sessions-warn: 5   # warn when host has this many Claude sessions
  ssh-no-docker: true           # when session is over SSH, steer the plan away from Docker-based tests
  zombie-threshold-min: 30      # age (minutes) above which an idle Claude/Node process is a zombie candidate
```

**`zombie-threshold-min`** (default: `30`): When set, the resource probe runs a secondary `ps` pass that counts Claude and Node processes older than this many minutes **and** with CPU% ≤ 1%. These are "zombie candidates" — stale sessions or orphaned workers that still hold RAM. The probe exposes them via `zombie_processes_count` in the snapshot. The evaluator escalates the verdict to at least `warn` when `zombie_processes_count >= 1` **and** `claude_processes_count > 0` (i.e., there are active Claude processes alongside the zombies). The reason string surfaces the threshold and count so the session-start banner gives actionable context. Set to `0` to disable zombie detection entirely (the field is omitted from the default snapshot when absent from config).

Rationale: originated from the 2026-04-19 incident where 8 parallel Claude sessions on one Mac caused a hard freeze. The adaptive rules cap concurrent agent load when the host is under pressure, before a wave ever spawns subagents. See Epic #157 and Sub-Epic #158.

### isolation graduation

The graduated default implements `scripts/lib/wave-sizing.mjs::resolveIsolation`. Per-wave truth table:

| agentCount | sessionType | isolation |
|---|---|---|
| ≤ 2 | any | `none` |
| 3–4 | housekeeping | `none` |
| 3–4 | feature / deep | `worktree` |
| ≥ 5 | any | `worktree` |

**Plan-level override:** session-plan may emit `collision-risk: low | medium | high` alongside each wave spec. `high` forces `worktree` even at ≤2 agents — use it when agents will edit the same files.

**Config-level override:** setting `isolation: worktree` or `isolation: none` in Session Config disables the graduation entirely for every wave.

**Enforcement auto-promote (#194):** when isolation resolves to `none`, `enforcement: warn` auto-promotes to `strict` for that wave — the scope hook becomes the only barrier once worktrees are absent, so it must be hard. Explicit `enforcement: off` is respected (user opt-out).

Rationale: the verified learning `coordinator-over-worktree-on-shared-files` (confidence 0.75) showed that small waves on partitioned scopes merge cleaner in-place than under worktree isolation. Two consecutive deep sessions (2026-04-20 07:30, 09:00) hit worktree base-ref staleness on ≤2-agent waves — the graduated default eliminates that hot path.

### base-ref freshness (#195)

Independent of isolation choice, wave-executor now persists a per-worktree meta file (`.orchestrator/tmp/worktree-meta/<suffix>.json`) when dispatching with `isolation: worktree`. Before each merge-back, it calls `checkWorktreeBaseRefFresh` (from `scripts/lib/worktree-freshness.mjs`) which returns one of four decisions:

- **pass** — worktree base matches current `main` HEAD; merge-back proceeds.
- **warn** — `main` advanced since worktree creation but drift does not overlap the agent's scope; log and proceed.
- **block** — `main` advanced AND drift files overlap the agent's scope; merge-back is refused. The coordinator reconciles manually or rebases the agent's branch.
- **no-meta** — meta file missing or corrupted; fall back to manual diff review.

This guard converts the manual post-copy `git diff` check (used to rescue the 07:30 and 09:00 regressions) into a coded pre-copy gate. The check is non-blocking on `pass` / `warn` / `no-meta`; only `block` interrupts the wave.

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

## CLAUDE.md Drift Check

Opt-in narrative-drift gate at session-end Phase 2.2 (see `skills/claude-md-drift-check/SKILL.md`). Four checks run against top-level repo docs: (1) absolute paths in CLAUDE.md / _meta resolve on disk, (2) hardcoded `01-projects/` count claims match the actual folder count, (3) issue references inside forward-looking sections (What's Next, Backlog, Open Issues, Offene Themen, Todo, Next Steps, Roadmap) are not closed, (4) `50-sessions/YYYY-MM-DD-*.md` references exist on disk. Complementary to `vault-sync`: that gate validates frontmatter inside the vault tree; this gate validates narrative claims in top-level docs.

All fields live under a top-level `drift-check` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
drift-check:
  enabled: true
  mode: warn
  include-paths:
    - CLAUDE.md
    - _meta/**/*.md
  check-path-resolver: true
  check-project-count-sync: true
  check-issue-reference-freshness: true
  check-session-file-existence: true
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `drift-check.enabled` | boolean | `false` | If true, session-end runs the drift checker as part of Phase 2.2. When false (or missing), the gate is skipped silently. |
| `drift-check.mode` | string | `warn` | Gate severity. `hard` blocks session close on any drift. `warn` reports drift in the quality gate report but does not block. `off` bypasses the checker entirely. |
| `drift-check.include-paths` | list of strings | `["CLAUDE.md", "_meta/**/*.md"]` | Files to scan. Supports exact paths and `<dir>/**/*.<ext>` directory-recursive patterns (relative to repo root). |
| `drift-check.check-path-resolver` | boolean | `true` | Enable Check 1: every absolute `/Users/…` path in scope files must resolve via `existsSync`. Code-fence blocks are skipped. |
| `drift-check.check-project-count-sync` | boolean | `true` | Enable Check 2: hardcoded `(N registered)` / `(N projects)` claims must match the actual `01-projects/*/` count. Auto-skipped if no `01-projects/` directory exists. |
| `drift-check.check-issue-reference-freshness` | boolean | `true` | Enable Check 3: `#NN` references inside forward-looking sections (What's Next, Backlog, Open Issues, Offene Themen, Todo, Next Steps, Roadmap) must be open per `glab issue view`. Auto-skipped if `glab` is not on PATH or origin repo cannot be detected. |
| `drift-check.check-session-file-existence` | boolean | `true` | Enable Check 4: every `50-sessions/YYYY-MM-DD-*.md` reference must exist on disk at `<vault>/50-sessions/<file>`. |

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
| `vault-integration.gitlab-groups` | string[] or null | `null` | List of GitLab group paths to scan for repos missing `.vault.yaml`. Consumed by `scripts/vault-backfill.mjs` (via `readVaultIntegrationConfig()`) and the `/plan retro` vault-backfill sub-mode (`skills/plan/mode-retro.md` Phase 1.6 Step 1). When null/unset, the backfill CLI exits with a "no groups configured" notice. |

## Vault Staleness

Opt-in configuration for vault-drift discovery probes. Detects stale vault projects and narratives. Used by `/discovery vault` (on-demand probe execution) and session-end Phase 2.3 (automatic gate at close time). Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-staleness` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-staleness:
  enabled: false           # opt-in
  mode: warn               # warn | strict | off  (NOT 'hard'; canonical per #217)
  thresholds:
    top: 30                # days — tier=top narrative staleness threshold
    active: 60             # days — tier=active
    archived: 180          # days — tier=archived
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-staleness.enabled` | boolean | `false` | If true, vault-staleness probes are activated. When false (or missing), Phase 2.3 and `/discovery vault` probes are skipped silently. |
| `vault-staleness.mode` | string | `warn` | Gate severity. `warn` runs probes and reports findings in the Docs Health line but never blocks session close. `strict` runs probes and blocks session close when findings are present; an interactive override prompt is available and any deviation is logged to STATE.md. `off` skips Phase 2.3 entirely — no probe execution. |
| `vault-staleness.thresholds.top` | integer | `30` | Days before a `tier=top` project's `lastSync` or narrative file (`context.md`, `decisions.md`, `people.md`) is flagged as stale. |
| `vault-staleness.thresholds.active` | integer | `60` | Days before a `tier=active` project's narrative is flagged as stale. |
| `vault-staleness.thresholds.archived` | integer | `180` | Days before a `tier=archived` project's narrative is flagged as stale. |

**Mode behavior:**

| Mode | Phase 2.3 | Blocks close? | Notes |
|------|-----------|---------------|-------|
| `off` | Skipped | No | No probe execution at all. |
| `warn` (default) | Runs | No | Findings reported in session-end Docs Health line. |
| `strict` | Runs | Yes | Override available via interactive prompt; deviation logged to STATE.md. |

**Related skills and files:**
- `/discovery vault` — on-demand probe execution command
- `skills/discovery/probes/vault-staleness.mjs` — project-staleness probe (flags `01-projects` with `lastSync` age > threshold)
- `skills/discovery/probes/vault-narrative-staleness.mjs` — narrative-staleness probe (checks `context.md`, `decisions.md`, `people.md` by tier)
- `skills/session-end/SKILL.md` — Phase 2.3: staleness gating and interactive override
- `.orchestrator/metrics/vault-staleness.jsonl` — JSONL output from the project-staleness probe
- `.orchestrator/metrics/vault-narrative-staleness.jsonl` — JSONL output from the narrative-staleness probe
- GitLab issue `#232` (foundation), `#242` (Sub-Epic C integration)

## Docs Orchestrator

Opt-in configuration for the `docs-orchestrator` skill, which generates audience-split documentation (User / Dev / Vault) within sessions (see `skills/docs-orchestrator/SKILL.md`). When enabled, session-start runs a Phase 2.5 docs-context step, session-plan assigns a Docs role, and session-end runs a Phase 3.2 gap-reporting step. The `docs-writer` agent is made available automatically when `enabled: true`.

All fields live under a top-level `docs-orchestrator` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
docs-orchestrator:
  enabled: false                 # opt-in; when true, session-start Phase 2.5 runs + docs-writer agent available
  audiences: [user, dev, vault]  # allowed audiences — can be narrowed per project
  mode: warn                     # warn | strict | off — session-end Phase 3.2 gap reporting
```

| Field | Type | Default | Allowed values | Description |
|-------|------|---------|----------------|-------------|
| `docs-orchestrator.enabled` | boolean | `false` | `true` / `false` | If true, the docs-orchestrator lifecycle hooks activate: session-start Phase 2.5 runs a docs-context step, and session-end Phase 3.2 reports documentation gaps. When false (or missing), all docs-orchestrator steps are skipped silently. |
| `docs-orchestrator.audiences` | array of string | `[user, dev, vault]` | `user`, `dev`, `vault` | Audiences for which documentation is generated. Can be narrowed to a subset (e.g., `[user, dev]`) to skip vault-targeted docs on projects without a vault. Each value must be one of the three canonical audience identifiers. |
| `docs-orchestrator.mode` | string | `warn` | `warn` / `strict` / `off` | Gap-reporting severity at session-end Phase 3.2. `warn` reports undocumented changes but does not block session close. `strict` blocks session close when documentation gaps are detected. `off` bypasses gap reporting entirely (useful during onboarding). |

**Related skills and files:**
- `skills/docs-orchestrator/SKILL.md` — full skill spec, hook points, and source-citation rules
- `skills/docs-orchestrator/audience-mapping.md` — per-audience content rules and output formats
- `skills/session-start/SKILL.md` — Phase 2.5 docs-context step (activated when `enabled: true`)
- `skills/session-end/SKILL.md` — Phase 3.2 gap-reporting step (activated when `enabled: true`)
- `agents/docs-writer.md` — agent dispatched for documentation generation

## Events Rotation

Size-based rotation for `.orchestrator/metrics/events.jsonl` (#251). Rotation fires at **session-start only** — per-append overhead is rejected design given typical growth of ~6 KiB/day. When the active log exceeds `max-size-mb`, it is renamed to `events.jsonl.1`, older backups shift down (`.1` → `.2`, …, `.N-1` → `.N`), and the oldest backup (`events.jsonl.{max-backups}`) is deleted. Rotation failure never blocks session-start; errors are logged to stderr and swallowed.

All fields live under a top-level `events-rotation` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
events-rotation:
  enabled: true     # default true; set false to disable rotation entirely
  max-size-mb: 10   # default 10; integer, bounds 1..1024
  max-backups: 5    # default 5; integer, bounds 1..20
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `events-rotation.enabled` | boolean | `true` | If false, rotation is skipped entirely and `events.jsonl` grows unbounded. |
| `events-rotation.max-size-mb` | integer | `10` | Size threshold in MiB. When `events.jsonl` exceeds this, it is rotated at the next session-start. Bounds: `1..1024`; out-of-range values silently fall back to the default. |
| `events-rotation.max-backups` | integer | `5` | Number of retained backup files (`events.jsonl.1` … `events.jsonl.N`). The oldest is deleted before shifting. Bounds: `1..20`; out-of-range values silently fall back to the default. |

**Rename safety (POSIX):** Atomic rename is safe with in-flight writers. Open file descriptors continue writing to the original inode (now `events.jsonl.1`); new writers open the new file on next append. Maximum observed line size is 220 bytes, well under the 4096-byte PIPE_BUF atomicity guarantee.

## STATE.md Schema §Recommendations (v1.1)

> Added by Epic #271 Phase A (issues #272–#275). **Additive** — `schema-version` remains `1`. Absence of all 5 fields is a valid `schema-version: 1` STATE.md meaning "no recommendation available" (pre-v1.1 compatibility). Readers MUST treat missing fields identically to explicit nulls.

Session-end Phase 3.7a is the **only writer** of these fields. Session-start Phase 1.5 is the reader (renders a one-line banner on `status: completed`). Phase B Mode-Selector (planned) will consume these fields as its primary input.

### Fields

| Field | Type | Value range | Description |
|-------|------|-------------|-------------|
| `recommended-mode` | string | `housekeeping` \| `feature` \| `deep` \| `discovery` \| `evolve` \| `plan-retro` | v0 heuristic output: suggested mode for the next session. |
| `top-priorities` | integer[] | 0–5 entries | Carried-over issue IIDs, pre-sorted (priority:critical/high first, FIFO tiebreak). |
| `carryover-ratio` | float | `0.00`–`1.00` | `carryover_count / planned_issues` (0 when planned=0). Rounded to 2 decimals. |
| `completion-rate` | float | `0.00`–`1.00` | `completed_issues / planned_issues`. Rounded to 2 decimals. |
| `rationale` | string | ≤ 120 chars, single line | Which v0 rule branch fired (e.g. `"v0: completion <50% → retro"`). |

### Example frontmatter

```yaml
---
schema-version: 1
session-type: deep
branch: main
issues: [272, 273, 274, 275]
started_at: 2026-04-24T18:10:00+02:00
status: completed
current-wave: 5
total-waves: 5
recommended-mode: feature
top-priorities: [278, 283, 285]
carryover-ratio: 0.00
completion-rate: 1.00
rationale: "v0: default clean completion"
---
```

### v0 heuristic (deterministic)

Evaluated in order; first match wins:

1. `completion_rate < 0.50` → `plan-retro` (rationale: `v0: completion <50% → retro`)
2. `carryover_ratio >= 0.30` → `deep` (rationale: `v0: carryover ≥30% → deep`)
3. otherwise → `feature` (rationale: `v0: default clean completion`)

Implementation: `scripts/lib/recommendations-v0.mjs` → `computeV0Recommendation()`. Deterministic — same inputs always produce same output. Phase B will replace this with a learnings-driven selector; the contract (5 fields, same types) stays stable.

### Backward compatibility

- Pre-v1.1 STATE.md files (produced by sessions before Epic #271 shipped) simply do not contain these fields. The parser returns `null` from `parseRecommendations`; the banner silently no-ops.
- `schema-version` is NOT bumped to `1.1` in the frontmatter — the existing `schema-version: 1` remains canonical. The v1.1 label is documentation-only, describing the additive surface.
- Idle Reset (session-start Phase 1.5) archives these fields into the `## Previous Session` body block of STATE.md as a human-readable block, then removes them from the frontmatter — so a fresh session never inherits stale recommendations in its live frontmatter.

### Reader behavior

The banner renders with one of the following shapes:

- **All 5 fields present, `top-priorities` non-empty:**
  ```
  📋 Previous session recommended: deep — v0: carryover ≥30% → deep (completion: 85%, carryover: 40%)
    Suggested issues: #272, #273, #274
  ```
- **All 5 fields present, `top-priorities` empty:** banner line only (no "Suggested issues" line).
- **Partial fields (1–4 present):** banner still renders; missing numeric fields display as `—`; WARN event `state-md-partial-recommendation` written to `.orchestrator/metrics/sweep.log`.
- **`top-priorities` type-mismatch** (not an array): field treated as null; WARN `state-md-type-mismatch` written to sweep.log; other fields still render.
- **Unknown `recommended-mode`:** banner shows `(unknown-mode)` instead of the string.
- **Pre-v1.1 STATE.md (no fields at all):** silent no-op, no banner, no WARN.

### Consumer cross-reference

- **Writer:** `skills/session-end/SKILL.md` § Phase 3.7a "Compute and Write Recommendations" (runs after Phase 3.7 sessions.jsonl write, before Phase 3.4 `status: completed` setting).
- **Reader:** `skills/session-start/SKILL.md` § Phase 1.5 "Recommendations Banner" (renders on `status: completed` branch only).
- **Archival:** `skills/session-start/SKILL.md` § Idle Reset rule 6 (removes fields from frontmatter, prepends readable block to `## Previous Session`).
- **Future consumer:** Phase B Mode-Selector skill (planned in Epic #271) will read these fields as the primary input for autonomous mode selection.

## Hook Runtime Profile Control (#211)

Control which hooks run at runtime via environment variables — no settings-file edits required.

### Environment variables

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `SO_HOOK_PROFILE` | `full` \| `minimal` \| `off` | `full` | Preset bundle that enables/disables groups of hooks. |
| `SO_DISABLED_HOOKS` | Comma-separated hook names | _(none)_ | Disable individual hooks regardless of profile. |

### Profile bundles

| Profile | Enabled hooks |
|---------|--------------|
| `full` | All hooks (default — no behaviour change when env unset) |
| `minimal` | `on-session-start`, `pre-bash-destructive-guard` only |
| `off` | No hooks |

### Precedence

`SO_DISABLED_HOOKS` takes precedence over `SO_HOOK_PROFILE` for the listed names. Unknown `SO_HOOK_PROFILE` values fall back to `full` with a single stderr warning.

### Examples

```bash
# Disable all hooks for a quick one-shot run
SO_HOOK_PROFILE=off claude ...

# Keep only the safety guard active
SO_HOOK_PROFILE=minimal claude ...

# Disable only the typecheck-on-save hook, keep everything else
SO_DISABLED_HOOKS=post-edit-validate claude ...

# Disable two hooks independently
SO_DISABLED_HOOKS=enforce-scope,enforce-commands claude ...
```

### Hook name reference

| Hook name | hooks.json event |
|-----------|-----------------|
| `on-session-start` | SessionStart |
| `pre-bash-destructive-guard` | PreToolUse/Bash |
| `enforce-commands` | PreToolUse/Bash |
| `enforce-scope` | PreToolUse/Edit\|Write |
| `post-edit-validate` | PostToolUse/Edit\|Write |
| `on-stop` | Stop + SubagentStop |

### Implementation

Each hook handler imports `shouldRunHook` from `hooks/_lib/profile-gate.mjs` at the top level and calls `process.exit(0)` immediately when gated off. The exit is silent (no stdout, no stderr), so Claude Code sees an allow as if the hook had never run.

## Webhooks (#228)

Opt-in webhook notifications delivered by `scripts/lib/webhook-url.mjs`. The helper centralizes URL resolution so no personal-domain default ever silently fires — callers must supply a URL explicitly.

### Resolution order

For every supported kind the resolver checks sources in this order; the first non-empty string wins:

1. **Environment variable** `SO_WEBHOOK_<KIND>_URL` — uppercase kind, hyphens → underscores  
   e.g. `SO_WEBHOOK_SLACK_URL`, `SO_WEBHOOK_GITLAB_PIPELINE_STATUS_URL`
2. **Session Config** `webhooks.<kind>.url`
3. **Error** — `WebhookConfigError` is thrown. No silent personal-domain fallback.

### Supported kinds

| Kind | Env variable | Config key |
|------|-------------|------------|
| `slack` | `SO_WEBHOOK_SLACK_URL` | `webhooks.slack.url` |
| `discord` | `SO_WEBHOOK_DISCORD_URL` | `webhooks.discord.url` |
| `generic` | `SO_WEBHOOK_GENERIC_URL` | `webhooks.generic.url` |
| `gitlab-pipeline-status` | `SO_WEBHOOK_GITLAB_PIPELINE_STATUS_URL` | `webhooks.gitlab-pipeline-status.url` |

### Session Config example

```yaml
webhooks:
  slack:
    url: https://hooks.slack.com/services/REDACTED/REDACTED/REDACTED
  discord:
    url: https://discord.com/api/webhooks/REDACTED/REDACTED
  generic:
    url: https://example.com/hooks/session-events
  gitlab-pipeline-status:
    url: https://gitlab.example.com/hooks/pipeline
```

### Clank Event Bus (events.mjs / on-stop.mjs)

The internal Clank Event Bus webhook is controlled by two environment variables:

| Variable | Purpose |
|----------|---------|
| `CLANK_EVENT_SECRET` | Bearer token. **Required** — if absent, no POST is made. |
| `CLANK_EVENT_URL` | Target base URL. **Required** — if absent, no POST is made (no personal-domain default). |

Both variables must be set for the fire-and-forget POST to fire. Setting only `CLANK_EVENT_SECRET` without `CLANK_EVENT_URL` is a safe no-op.

## Express Path (#214)

Codified coordinator-direct flow for housekeeping and simple single-issue sessions. When the express path activates, session-start Phase 8.5 skips the full 5-wave plan decomposition and runs all tasks directly as the coordinator — no subagents dispatched, no inter-wave checkpoints.

> **Historical context:** The 13 coordinator-direct sessions documented in the project `CLAUDE.md` (2026-04 series: vault-mirror GH#31, phased-rollout #307, v3.2.0 release, Architecture-DDD-Trio, etc.) were running this pattern implicitly without a codified path. Issue #214 codifies it so that future housekeeping sessions gain the express path automatically without needing to know to opt in manually.

All fields live under a top-level `express-path` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
express-path:
  enabled: true   # default true; set false to always use the full 5-wave flow
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `express-path.enabled` | boolean | `true` | When `true`, session-start Phase 8.5 evaluates the express-path activation conditions. When `false`, the evaluation is skipped and the full session-plan 5-wave flow always runs. |

### Activation conditions

All three conditions must be true simultaneously for the express path to activate:

1. `express-path.enabled: true` (default)
2. Session type is `housekeeping` (confirmed in session-start Phase 8 Q&A)
3. Agreed issue scope is ≤ 3 issues AND no parallel agents are required

When any condition is false, the full 5-wave flow runs as before — the check is a transparent no-op.

### What changes when express path is active

- **session-start:** After Phase 8 Q&A, emits `"Express path activated — N tasks, coordinator-direct, no inter-wave checks."` banner and executes tasks directly as the coordinator. session-plan is called but receives the express-path signal.
- **session-plan:** Detects the banner in conversation context and emits a minimal 1-wave `coordinator-direct` plan (0 agents dispatched). Skips all role decomposition, complexity scoring, and wave splitting.
- **STATE.md:** Activation is logged in the `## Deviations` section for traceability.
- **Inter-wave checkpoints:** Skipped entirely — no Discovery → Impl-Core → Quality pipeline.

### When to disable

Set `express-path.enabled: false` when:

- You want all housekeeping sessions to go through the standard quality-gate pipeline (Discovery + Quality waves).
- The session involves ≥ 4 issues (the scope check already prevents activation, but disabling makes the intent explicit).
- You are running an automated `/autopilot` loop and want predictable wave counts across session types.

### Condition matrix

| Session type | Issue count | `express-path.enabled` | Parallel agents? | Activates? |
|---|---|---|---|---|
| `housekeeping` | 1–3 | `true` | No | **Yes** |
| `housekeeping` | 4+ | `true` | No | No — scope too large |
| `housekeeping` | 1–3 | `false` | No | No — opted out |
| `feature` | 1–3 | `true` | No | No — not housekeeping |
| `housekeeping` | 1–3 | `true` | Yes | No — parallel agents required |

**Related skills and files:**
- `skills/session-start/SKILL.md` — Phase 8.5: Express Path Evaluation (activation logic + banner)
- `skills/session-plan/SKILL.md` — Express Path Short-Circuit section (1-wave plan emission)
- GitLab issue `#214` (foundation and codification)

## Defaults

If no `## Session Config` section exists in the platform config host file (`CLAUDE.md` or `AGENTS.md`), skills use: `feature` type, 6 agents, 5 waves, and field-specific defaults listed above.
