# Session Config Template (Baseline)

> Project-instruction file: this lives under `## Session Config` in CLAUDE.md (Claude Code / Cursor) or AGENTS.md (Codex CLI). See [skills/_shared/instruction-file-resolution.md](../skills/_shared/instruction-file-resolution.md) for the alias resolution rule.

> Canonical field reference (types, defaults, edge cases): [docs/session-config-reference.md](./session-config-reference.md). This template is the **adopter-facing** companion: copy-paste blocks plus a structural walk-through of every field.

## How to use this template

1. Pick the host file: `CLAUDE.md (or AGENTS.md on Codex CLI)`. Never both.
2. Add a single `## Session Config` H2. The header must match exactly — `skills/_shared/config-reading.md` parses the block under that heading.
3. Start from the [Full minimal baseline](#full-minimal-baseline-copy-paste) at the bottom of this document. Add opt-in blocks one at a time as you adopt features.
4. Run `/bootstrap --retroactive` to schema-validate the result.
5. Validate at any time with `node scripts/parse-config.mjs --json`.

The format is the same on every platform. Fields not listed here are silently ignored — typos do **not** raise.

## Where this file lives

The session-orchestrator plugin reads its Session Config from the per-repo project-instruction file. Exactly which file it picks depends on the platform:

### CLAUDE.md (Claude Code, Cursor IDE)

Claude Code and Cursor IDE both read `CLAUDE.md` natively. Add the `## Session Config` H2 anywhere in that file.

### AGENTS.md (Codex CLI)

Codex CLI uses `AGENTS.md` as its canonical instruction file. Same `## Session Config` H2, same field set.

The plugin resolves the file via [`scripts/lib/common.mjs::resolveInstructionFile`](../scripts/lib/common.mjs); the rule is documented in [`skills/_shared/instruction-file-resolution.md`](../skills/_shared/instruction-file-resolution.md). `CLAUDE.md` always wins ties when both files exist.

## Mandatory fields (schema-validated)

These seven fields are enforced by `scripts/lib/config-schema.mjs`. Validation is gated by the `enforcement` field itself: `off` skips, `warn` reports + emits, `strict` reports + exits 1.

```yaml
test-command: npm test                # non-empty string — quality-gate test runner
typecheck-command: npm run typecheck   # non-empty string — `tsgo --noEmit` is canonical
lint-command: npm run lint             # non-empty string — Full Gate lint runner
agents-per-wave: 6                     # integer ≥ 2 (or { default: 6, deep: 18 })
waves: 5                               # integer ≥ 3 — execution wave count
persistence: true                      # boolean — STATE.md + memory file resumption
enforcement: warn                      # strict | warn | off — hook strictness AND validator gate
```

Read by: `scripts/parse-config.mjs`, `scripts/validate-config.mjs`, `skills/_shared/config-reading.md`, every quality-gate skill.

## Session Structure

Controls wave count, parallelism, and freeform per-repo notes the orchestrator must follow.

```yaml
agents-per-wave: 6                     # integer or "6 (deep: 18)" override syntax
waves: 5                               # integer ≥ 3
recent-commits: 20                     # how many commits to display at session-start
special: "any repo-specific instructions"   # freeform — orchestrator reads + obeys
```

Read by: `skills/session-start/SKILL.md` (Phase 4.5), `skills/session-plan/SKILL.md`, `skills/wave-executor/wave-loop.md`.

## VCS & Infrastructure

```yaml
vcs: gitlab                            # github | gitlab — auto-detected from remote when unset
gitlab-host: gitlab.example.com        # only if remote URL doesn't expose it
mirror: github                         # auto-push to mirror after every commit (none | github)
cross-repos: [related-repo-1]          # repos under ~/Projects/ to snapshot at session-start
pencil: path/to/design.pen             # design-code alignment input
ecosystem-health: true                 # toggle health-endpoint probes
health-endpoints:
  - { name: API, url: https://api.example.com/health }
issue-limit: 50                        # max issues fetched at session-start
stale-branch-days: 7                   # branch-age threshold for stale flag
stale-issue-days: 30                   # issue-age threshold for triage flag
```

Read by: `skills/session-start/SKILL.md`, `skills/ecosystem-health/SKILL.md`, `skills/gitlab-ops/SKILL.md`.

## Quality Gates

```yaml
test-command: npm test                 # mandatory
typecheck-command: npm run typecheck   # mandatory; `skip` for non-TS projects
lint-command: npm run lint             # mandatory
ssot-files: [STATUS.md, STATE.md]      # files watched for staleness
ssot-freshness-days: 5                 # days before SSOT flagged
plugin-freshness-days: 30              # days before the plugin itself flagged
```

Read by: `skills/quality-gates/SKILL.md`, `skills/session-end/SKILL.md`. The three `*-command` fields are overridden by `.orchestrator/policy/quality-gates.json` when that file exists (#183).

## Discovery

```yaml
discovery-on-close: auto               # session-type aware: housekeeping=false, feature/deep=true (#264)
discovery-probes: [all]                # all | code | infra | ui | arch | session
discovery-exclude-paths: []            # globs (e.g. "vendor/**", "dist/**")
discovery-severity-threshold: low      # critical | high | medium | low
discovery-confidence-threshold: 60     # 0–100; below this auto-defers
discovery-parallelism: 5               # 1..16 probe agents in parallel
```

Read by: `skills/discovery/SKILL.md` and the probe modules under `skills/discovery/probes-*.md`.

## Persistence & Safety

```yaml
persistence: true                      # mandatory
memory-cleanup-threshold: 5            # recommend /memory-cleanup after N memory files
learning-expiry-days: 30               # learnings auto-expire after N days untouched
learnings-surface-top-n: 15            # how many learnings appear in Project Intelligence
learning-decay-rate: 0.05              # 0.0..<1.0 untouched-learning confidence decay
enforcement: warn                      # mandatory; strict | warn | off
enforcement-gates:
  path-guard: true
  command-guard: true
  post-edit-validate: true
allow-destructive-ops: false           # disables destructive-command guard when true
reasoning-output: false                # opt-in STATE:/PLAN: agent transparency markers
grounding-check: true                  # session-end Phase 1.1a planned-vs-touched diff
grounding-injection-max-files: 3       # 0 disables (#85)
isolation: auto                        # worktree | none | auto (graduated default #194)
max-turns: auto                        # housekeeping=8, feature=15, deep=25
```

Read by: `skills/session-start/SKILL.md`, `skills/session-end/SKILL.md`, `hooks/pre-edit-scope.mjs`, `hooks/pre-bash-destructive-guard.mjs`, `hooks/pre-bash-enforce-commands.mjs`, `hooks/post-edit-validate.mjs`.

## Resource Awareness (env-aware)

Introduced by Epic #157. Lets session-start sense host RAM/CPU/SSH/peers and adapt wave planning. Safe to omit — defaults are conservative.

```yaml
resource-awareness: true               # master toggle for env-aware runtime
enable-host-banner: true               # emit host + resource banner at session-start
resource-thresholds:
  ram-free-min-gb: 4                   # below: cap agents-per-wave at 2
  ram-free-critical-gb: 2              # below: recommend coordinator-direct
  cpu-load-max-pct: 80                 # sustained above: cap agents-per-wave at 2
  concurrent-sessions-warn: 5          # warn at this many peer Claude sessions
  ssh-no-docker: true                  # SSH session: avoid Docker-based tests
  zombie-threshold-min: 30             # min idle time before stale-process flag (#178)
```

Read by: `hooks/on-session-start.mjs`, `scripts/lib/resource-probe.mjs`, `scripts/lib/wave-sizing.mjs`.

## Planning

```yaml
baseline-ref: null                     # git ref on baseline project (or null = legacy MR sync)
baseline-project-id: "52"              # GitLab project ID of baseline (default: infrastructure/projects-baseline)
plan-baseline-path: ~/Projects/projects-baseline   # local baseline clone for /plan new
plan-default-visibility: internal      # internal | private | public — for /plan new
plan-prd-location: docs/prd            # PRD output directory
plan-retro-location: docs/retro        # retro output directory
```

Read by: `skills/plan/SKILL.md` and the three plan modes (`mode-new`, `mode-feature`, `mode-retro`).

## Vault Sync

Quality gate at session-end Phase 2 that validates YAML frontmatter against `vaultFrontmatterSchema` and flags dangling wiki-links. Opt-in.

```yaml
vault-sync:
  enabled: false                       # opt-in
  mode: warn                           # warn | hard | off — `hard` blocks session close
  vault-dir: .                         # absolute or repo-relative
  exclude:
    - "**/_MOC.md"
    - "**/_overview.md"
    - "**/README.md"
```

Read by: `skills/vault-sync/SKILL.md` + `skills/vault-sync/validator.mjs`.

## Vault Integration

Auto-sync that writes learnings + session summaries into a Meta-Vault after each session, and (with `--session-id`) auto-commits the result.

```yaml
vault-integration:
  enabled: false                       # opt-in
  vault-dir: ~/Projects/vault          # absolute path to vault repo
  mode: warn                           # warn | strict | off
  gitlab-groups:                       # optional — for /plan retro vault-backfill sub-mode
    - infrastructure
    - clients
```

Read by: `scripts/vault-mirror.mjs`, `scripts/vault-backfill.mjs`, `skills/session-end/session-metrics-write.md`, `skills/evolve/SKILL.md`, `skills/plan/mode-retro.md`.

## Vault Staleness

Vault-drift discovery probes. Used by `/discovery vault` and (when `enabled`) session-end Phase 2.3.

```yaml
vault-staleness:
  enabled: false                       # opt-in
  mode: warn                           # warn | strict | off (NOT 'hard'; canonical per #217)
  thresholds:
    top: 30                            # tier=top narrative staleness (days)
    active: 60                         # tier=active
    archived: 180                      # tier=archived
```

Read by: `skills/discovery/probes/vault-staleness.mjs`, `skills/discovery/probes/vault-narrative-staleness.mjs`, `skills/session-end/SKILL.md` Phase 2.3.

## CLAUDE.md Drift Check

Narrative-drift gate at session-end Phase 2.2. Four checks: absolute-path resolution, project-count claims, issue-reference freshness, session-file existence.

```yaml
drift-check:
  enabled: false                       # opt-in
  mode: warn                           # warn | hard | off
  include-paths:
    - CLAUDE.md
    - _meta/**/*.md
  check-path-resolver: true
  check-project-count-sync: true
  check-issue-reference-freshness: true
  check-session-file-existence: true
```

Read by: `skills/claude-md-drift-check/SKILL.md`, `skills/claude-md-drift-check/checker.mjs`.

## Docs Orchestrator

Audience-split (User / Dev / Vault) doc generation, hooked into session-start Phase 2.5, session-plan Step 1.5/1.8, session-end Phase 3.2.

```yaml
docs-orchestrator:
  enabled: false                       # opt-in; activates the docs-writer agent
  audiences: [user, dev, vault]        # subset allowed
  mode: warn                           # warn | strict | off
```

Read by: `skills/docs-orchestrator/SKILL.md`, `skills/session-start/phase-2-5-docs-planning.md`, `skills/session-end/phase-3-2-docs-verification.md`, `agents/docs-writer.md`.

## Events Rotation

Size-based rotation of `.orchestrator/metrics/events.jsonl` (#251). Fires only at session-start.

```yaml
events-rotation:
  enabled: true                        # default true
  max-size-mb: 10                      # 1..1024
  max-backups: 5                       # 1..20
```

Read by: `hooks/on-session-start.mjs`, `scripts/lib/events-rotation.mjs`.

## Express Path

Codified coordinator-direct flow for housekeeping + simple single-issue sessions (#214). Activates when session-type=housekeeping AND issues ≤ 3 AND no parallel agents.

```yaml
express-path:
  enabled: true                        # default true; set false to always use full 5-wave flow
```

Read by: `skills/session-start/phase-8-5-express-path.md`, `skills/session-plan/SKILL.md` (express-path short-circuit).

## Webhooks

Opt-in webhook notifications. The `scripts/lib/webhook-url.mjs` resolver checks env first (`SO_WEBHOOK_<KIND>_URL`), then this Session Config block. **No personal-domain default** — callers must supply a URL or the resolver throws.

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

Read by: `scripts/lib/webhook-url.mjs`, hooks that emit events (`hooks/on-stop.mjs`, `hooks/on-subagent-stop.mjs`).

The internal Clank Event Bus uses two separate env vars (`CLANK_EVENT_SECRET`, `CLANK_EVENT_URL`) — both required for the fire-and-forget POST.

## Hook Runtime Profile (env-only, not config)

`SO_HOOK_PROFILE` and `SO_DISABLED_HOOKS` are environment variables, **not Session Config fields**. They control hook execution at runtime without editing `hooks.json`.

| Variable | Values | Default | Effect |
|----------|--------|---------|--------|
| `SO_HOOK_PROFILE` | `full` \| `minimal` \| `off` | `full` | Preset bundle — `minimal` keeps only `on-session-start` + `pre-bash-destructive-guard`. |
| `SO_DISABLED_HOOKS` | comma-separated hook names | _(none)_ | Per-hook override; takes precedence over the profile. |

Read by: `hooks/_lib/profile-gate.mjs`. See [docs/session-config-reference.md § Hook Runtime Profile Control](./session-config-reference.md#hook-runtime-profile-control-211).

## Agent Mapping

Explicit role-to-agent binding. Without this block, session-plan auto-matches tasks to agents based on description content.

```yaml
agent-mapping:
  impl: code-implementer
  test: test-writer
  ui: ui-developer
  db: db-specialist
  security: security-reviewer
  docs: docs-writer
  perf: code-implementer
```

Read by: `skills/session-plan/SKILL.md`, `skills/wave-executor/wave-loop.md`.

The dispatch resolution is three-tier: project agents (`.claude/agents/`) > plugin agents (`session-orchestrator:*`) > `general-purpose`.

## Full minimal baseline (copy-paste)

The smallest valid Session Config — passes `validate-config` without warnings on a typical Node/TS repo:

```yaml
## Session Config

test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
agents-per-wave: 6
waves: 5
persistence: true
enforcement: warn
```

That's enough for `/session feature` → `/go` → `/close` to work end-to-end. Every other field falls back to documented defaults.

## Full opt-in baseline (copy-paste)

Everything turned on for a project that wants the full feature surface (vault, docs, drift checks, env-aware sizing, webhooks). Trim to taste:

```yaml
## Session Config

# Mandatory
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
agents-per-wave: 6 (deep: 18)
waves: 5
persistence: true
enforcement: warn

# Session structure
recent-commits: 20
special: "follow .claude/rules/parallel-sessions.md"

# VCS & infrastructure
vcs: gitlab
mirror: github
cross-repos: []
ecosystem-health: true
health-endpoints: []
issue-limit: 50
stale-branch-days: 7
stale-issue-days: 30

# Quality
ssot-files: [STATE.md]
ssot-freshness-days: 5
plugin-freshness-days: 30

# Discovery
discovery-on-close: auto
discovery-probes: [all]
discovery-exclude-paths: ["vendor/**", "dist/**", "node_modules/**"]
discovery-severity-threshold: low
discovery-confidence-threshold: 60
discovery-parallelism: 5

# Persistence & safety
memory-cleanup-threshold: 5
learning-expiry-days: 30
learnings-surface-top-n: 15
learning-decay-rate: 0.05
enforcement-gates:
  path-guard: true
  command-guard: true
  post-edit-validate: true
allow-destructive-ops: false
reasoning-output: false
grounding-check: true
grounding-injection-max-files: 3
isolation: auto
max-turns: auto

# Env-aware
resource-awareness: true
enable-host-banner: true
resource-thresholds:
  ram-free-min-gb: 4
  ram-free-critical-gb: 2
  cpu-load-max-pct: 80
  concurrent-sessions-warn: 5
  ssh-no-docker: true
  zombie-threshold-min: 30

# Planning
baseline-ref: main
baseline-project-id: "52"
plan-baseline-path: ~/Projects/projects-baseline
plan-default-visibility: internal
plan-prd-location: docs/prd
plan-retro-location: docs/retro

# Vault sync
vault-sync:
  enabled: true
  mode: warn
  vault-dir: .
  exclude: ["**/_MOC.md", "**/_overview.md", "**/README.md"]

# Vault integration
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn
  gitlab-groups: []

# Vault staleness
vault-staleness:
  enabled: true
  mode: warn
  thresholds:
    top: 30
    active: 60
    archived: 180

# CLAUDE.md drift check
drift-check:
  enabled: true
  mode: warn
  include-paths: [CLAUDE.md, "_meta/**/*.md"]
  check-path-resolver: true
  check-project-count-sync: true
  check-issue-reference-freshness: true
  check-session-file-existence: true

# Docs orchestrator
docs-orchestrator:
  enabled: true
  audiences: [user, dev, vault]
  mode: warn

# Events rotation
events-rotation:
  enabled: true
  max-size-mb: 10
  max-backups: 5

# Express path
express-path:
  enabled: true

# Webhooks (URLs are required when used — no defaults)
# webhooks:
#   slack:
#     url: https://hooks.slack.com/services/...
#   gitlab-pipeline-status:
#     url: https://gitlab.example.com/hooks/pipeline

# Agent mapping
agent-mapping:
  impl: code-implementer
  test: test-writer
  ui: ui-developer
  db: db-specialist
  security: security-reviewer
  docs: docs-writer
  perf: code-implementer
```

## Validation & Bootstrap

- **Validate manually:** `node scripts/parse-config.mjs --json` (writes to stdout) or `node scripts/validate-config.mjs` (mandatory-field check).
- **Auto-validate at session-start:** Always runs. Behavior is gated by `enforcement` (`off`/`warn`/`strict`).
- **Bypass:** `SO_SKIP_CONFIG_VALIDATION=1`.
- **Patch missing fields:** `/bootstrap --retroactive` adds the seven mandatory fields to an existing config without overwriting custom values.

## Cross-reference

- [docs/session-config-reference.md](./session-config-reference.md) — full canonical reference, types, edge cases.
- [skills/_shared/instruction-file-resolution.md](../skills/_shared/instruction-file-resolution.md) — CLAUDE.md ↔ AGENTS.md alias rule.
- [skills/_shared/config-reading.md](../skills/_shared/config-reading.md) — runtime parser used by every skill.
- [docs/USER-GUIDE.md](./USER-GUIDE.md) — adopter walk-through with examples.
- [docs/examples/](./examples/) — Session Config samples for Next.js, Express, Swift.
