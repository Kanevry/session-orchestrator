# Session Orchestrator Plugin

Claude Code plugin for session-level orchestration. This is a **plugin repo** — not an application.

> **Für Installation, CLI-Nutzung und Kommando-Referenz:** Siehe [`README.md`](./README.md).

## Structure

- `skills/` — 19 skills (bootstrap, session-start, session-plan, wave-executor, session-end, claude-md-drift-check, ecosystem-health, gitlab-ops, quality-gates, discovery, plan, evolve, vault-sync, vault-mirror, daily, docs-orchestrator, skill-creator, mcp-builder, hook-development)
- `commands/` — 8 commands (/session, /go, /close, /discovery, /plan, /evolve, /bootstrap, /harness-audit)
- `agents/` — 7 agents (code-implementer, test-writer, ui-developer, db-specialist, security-reviewer, session-reviewer, docs-writer)
- `hooks/` — 6 event matchers covering 7 hook handlers: SessionStart (banner + init), PreToolUse/Edit|Write (scope enforcement), PreToolUse/Bash (destructive-command guard + enforce-commands), PostToolUse (edit validation), Stop (session events), SubagentStop (agent events)
- `.orchestrator/policy/` — runtime policy files (e.g. `blocked-commands.json`, 13 rules for destructive-command guard)
- `.claude/rules/` — always-on contributor rules (e.g. `parallel-sessions.md`)

## Development

Edit skills directly. Test by running `/session feature` in any project repo.

Skills are loaded by Claude Code from the plugin directory — no build step needed.

## Destructive-Command Guard

`hooks/pre-bash-destructive-guard.mjs` blocks destructive shell commands in the main session (alongside subagent waves). Policy lives in `.orchestrator/policy/blocked-commands.json` (13 rules). Bypass per-session via Session Config:

```yaml
allow-destructive-ops: true
```

Rule source of truth: `.claude/rules/parallel-sessions.md` (PSA-003). See issue #155.

## Rules

- `.claude/rules/parallel-sessions.md` — PSA-001/002/003/004 parallel-session discipline. Vendored to all consumer repos via bootstrap (issue #155).

## Key Conventions

- Skills use Markdown with YAML frontmatter
- Commands use `$ARGUMENTS` for user input
- Agent definitions need `<example>` blocks in description
- Hooks use the Claude Code hooks.json format

## Agent Authoring Rules

Agent files live in `agents/` as Markdown with YAML frontmatter. Required fields:

```yaml
---
name: kebab-case-name          # 3-50 chars, lowercase + hyphens only
description: Use this agent when [conditions]. <example>Context: ... user: "..." assistant: "..." <commentary>Why this agent is appropriate</commentary></example>
model: inherit                 # inherit | sonnet | opus | haiku
color: blue                    # blue | cyan | green | yellow | magenta | red
tools: Read, Grep, Glob, Bash  # COMMA-SEPARATED STRING, not JSON array!
---
```

**Critical pitfalls** (cause "agents: Invalid input" validation failure):
- `tools` MUST be a comma-separated string (`Read, Edit, Write`), NOT a JSON array (`["Read", "Edit"]`)
- `description` MUST be a single-line inline string, NOT a YAML block scalar (`>` or `|`). Put `<example>` blocks inline.
- All 4 fields (name, description, model, color) are required. `tools` is optional.

Reference: https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/agent-development/SKILL.md

## v3.0 Migration

Bash → Node.js migration for native Windows support. Epic #124 complete:
foundation (#125–#130, #132), hooks (#137–#142), tests (#143–#145), and legacy
cleanup (#151). Legacy `.sh` scripts under `hooks/`, `scripts/lib/` (except
`common.sh`, retained for install tooling), and `scripts/test/` have been
removed. Entry point is `scripts/parse-config.mjs`.

Development prerequisite: **Node 20+**. Run `npm ci` after cloning. Test with
`npm test` (vitest). Lint: `npm run lint`.

## v3.1.0 Release — Environment-Aware Sessions (Epic #157)

Shipped 2026-04-24 via cascade-merge of !15/!10/!12 into !9 → main. Four sub-epics:

- **Sub-Epic A+B — Host-Identity + Pre-Session Resource Gate (#158)**: `scripts/lib/host-identity.mjs` (device fingerprint + SSH detection, #162), `scripts/lib/resource-probe.mjs` (live RAM/CPU/process snapshot + `evaluate()` verdict, #163), `hooks/on-session-start.mjs` host+resource banner + `peer_count` event payload (#164), `skills/session-start` Phase 4.5 adaptive wave sizing (#165), new `resource-awareness` / `enable-host-banner` / `resource-thresholds` Session Config block (#166).
- **Sub-Epic B — Pre-Dispatch Resource Gate (#192 #193)**: `scripts/lib/wave-resource-gate.mjs` 8-rule decision chain (`proceed`/`reduce`/`coordinator-direct`); probe failure + missing thresholds degrade to `proceed` so the gate never blocks. New `worktree-exclude` Session Config field plus `applyWorktreeExcludes` post-`git worktree add` helper (default: node_modules, dist, build, .next, .nuxt, coverage, .cache, .turbo, .vercel, out).
- **Sub-Epic C+E — Hardware-Pattern Learnings + Privacy Tiers (#170 #171 #172)**: `scripts/lib/learnings.mjs` `scope: local | private | public` + `host_class` + `anonymized` schema. Privacy validator enforces `{scope:'public', anonymized:false}` throws. `scripts/lib/hardware-pattern-detector.mjs` 5 detection signals (oom-kill, heartbeat-gap, concurrent-session-pressure, disk-full, thermal-throttle) + `/evolve` type 7 handler. `scripts/export-hw-learnings.mjs --promote` CLI (anonymize → set `scope:public`/`anonymized:true` → validate → rewrite with `.bak-<ISO>`). Anonymization: macOS+Linux system paths (incl. `/root`, `/var`, `/opt`, `/tmp`, `/mnt`, `/srv`), Windows paths (forward + back slash), IPv4, GitHub/GitLab URLs.
- **Sub-Epic F — Multi-Session Registry + Heartbeat (#167 #168 #169)**: `scripts/lib/session-registry.mjs` (atomic writes via temp+rename, sha256 repo-path hash, configurable `registryBaseDir`, zombie sweep with threshold), `hooks/on-session-start.mjs` register-self + detect-peers + sweep with peer banner, `hooks/on-stop.mjs` idempotent deregister. Both hooks now emit `register-failed`/`deregister-failed` breadcrumbs to `sweep.log` via `logSweepEvent` helper (silent-failure observability). Default registry: `~/.config/session-orchestrator/sessions/active/`, overridable via `SO_SESSION_REGISTRY_DIR`.
- **CI flake remediation (#268)**: Root cause was vitest 2.1.9 + tinypool worker exit-hang AFTER all tests pass. Remediated in `.gitlab-ci.yml` via bounded `timeout --preserve-status` + per-file `✓`/`✗` marker count (decouples CI green signal from vitest exit sequence). Also added `vitest.config.mjs` hardening: `pool: 'forks'`, `teardownTimeout: 15000`, `hookTimeout: 30000`, `include` narrowed to `['tests/**/*.test.mjs']` (excludes `skills/vault-sync/tests/schema-drift.test.mjs` which runs standalone in the `schema-drift-check` CI stage).

## Meta-Audit #265 Sweep — Telemetry-JSONL Cluster (2026-04-24)

Second meta-audit pass shipped alongside v3.1.0. Closes 1 CRIT + 2 HIGH from Epic #265 plus 3 MED checklist items:

- **events.jsonl rotation (#251, CRIT)**: New `scripts/lib/events-rotation.mjs` — size-based rotation (default 10 MB, configurable 1..1024), backup-shift-and-drop (default 5 backups, configurable 1..20), POSIX-atomic rename, never-throws contract. Triggered once per session from `hooks/on-session-start.mjs` (post-emitEvent, try/caught so rotation failure never blocks session-start). Per-append rotation explicitly rejected design — session-start trigger is predictable and low-frequency. Session Config block: `events-rotation: { enabled, max-size-mb, max-backups }`.
- **agent-mapping validation (#255, HIGH)**: `scripts/lib/config.mjs` `agent-mapping` parse now throws on invalid role keys (outside `['impl', 'test', 'db', 'ui', 'security', 'compliance', 'docs', 'perf']`) or empty/non-string values. Plain-JS validator matches repo convention (no Zod). Fix-forward after review: `_coerceObject` changed from `if (k && v)` to `if (k)` so empty values reach the validator instead of being silently filtered.
- **discovery-parallelism configurable (#259, HIGH)**: New integer Session Config field `discovery-parallelism` (default 5, bounds 1..16, silent-fallback on out-of-range). `skills/discovery/SKILL.md:91` now references `$CONFIG['discovery-parallelism']` instead of hardcoded 5.
- **learnings schema versioning (M7)**: `scripts/lib/learnings.mjs` introduces `CURRENT_SCHEMA_VERSION = 1`. New records auto-stamped with `schema_version: 1`. `validateLearning` accepts v0 (legacy, missing field) and v1. `normalizeLearning` tags untagged records as v0 with a **deduplicated** `console.error` WARN (module-level `Set` keyed on record id — warns at most once per unique id per process, preventing log spam on large files).
- **learnings.jsonl data cleanup (M1)**: 6 records missing `expires_at` (lines 69, 81–85) patched with `created_at + 30d` ISO 8601. Atomic write via tmp + rename. Original backed up to `.bak-<ISO>`. Restores harness-audit score from 9.4 → 10.
- **session-end single-pass read (M9)**: `skills/session-end/metrics-collection.md` Phase 1.7 now reads `events.jsonl` exactly once via `jq -s` partition into stagnation + grounding arrays (was: two separate reads). Per-field `total == 0` omission rules preserved.

## v2.0 Features

- Session persistence via STATE.md + session memory files
- Scope & command enforcement hooks (PreToolUse)
- Circuit breaker: maxTurns limit + spiral detection
- Worktree isolation for parallel agent execution
- 5 new Session Config fields (persistence, enforcement, circuit breaker, worktrees, ecosystem-health)
- Session metrics tracking with historical trends (sessions.jsonl)
- Coordinator snapshots: pre-dispatch `git stash create` refs under `refs/so-snapshots/` for crash recovery (#196)
- CWD-drift guard: `restoreCoordinatorCwd` after every worktree-isolated Agent dispatch (#219)
- Harness audit scorecard: deterministic 7-category rubric (RUBRIC_VERSION pinned), JSON to stdout + JSONL trend in `.orchestrator/metrics/audit.jsonl`, `/discovery audit` probe, `/harness-audit` command (#210)
- Docs-orchestrator skill + docs-writer agent: audience-split (User/Dev/Vault) doc generation within sessions. Opt-in via `docs-orchestrator.enabled`. Source-cited only (diff/git-log/session-memory/affected-files); sourceless sections get `<!-- REVIEW: source needed -->`. Canonical four source types with hard abort when ALL absent. Three hook points: session-start Phase 2.5 (audience detection + AskUserQuestion, #233), session-plan Step 1.5/1.8 (Docs role classification + docs-writer auto-match + machine-readable `### Docs Tasks` SSOT emission, #234), session-end Phase 3.2 (per-task ok/partial/gap verification, mode warn/strict/off, #235). Config schema fields documented at `docs/session-config-reference.md § Docs Orchestrator` (#236). Umbrella #229 + foundation #230.
- Isolation:none default for new-directory waves (#243): `wave-executor/wave-loop.md` Pre-Dispatch New-Directory Detection inspects each agent's file scope — if ANY agent's target parent directory doesn't exist AND `configIsolation: 'auto'`, forces `isolation: 'none'` (NOT worktree). Avoids the Claude Code Agent-tool merge-back regression where new-dir writes silently fail to sync back. Enforcement auto-promotes `warn` → `strict` to keep the scope hook hard. Explicit `isolation: 'worktree'` overrides are honored with a `⚠` warning. 3rd-consecutive-session learning (conf 0.90).
- Vault-staleness discovery probes: `/discovery vault` activates two `.mjs` probes — `vault-staleness` flags 01-projects with `lastSync` age > 24h; `vault-narrative-staleness` flags `context.md`/`decisions.md`/`people.md` by tier thresholds (top=30d, active=60d, archived=180d). JSONL under `.orchestrator/metrics/vault-*.jsonl` (#232)
- Vault-backfill CLI (#241): `scripts/vault-backfill.mjs` scans configured GitLab groups (`vault-integration.gitlab-groups`), dry-run by default, `--apply` generates canonical `.vault.yaml` from projects-baseline template per repo, `--yes <manifest>` skips confirmation. Surfaced as `/plan retro` sub-mode via `skills/plan/mode-retro.md` Phase 1.6 (vault-backfill path). Umbrella #229.
- Session-end Phase 2.3 vault staleness check (#242): opt-in via `vault-staleness.enabled: true`; runs both `vault-staleness` + `vault-narrative-staleness` probes via Node import at close time. `mode: warn` surfaces findings in the Phase 6 Final Report Docs Health line; `mode: strict` blocks session-end with AskUserQuestion override. Umbrella #229.
- Adaptive wave sizing based on complexity scoring
- Cross-session learning system with confidence-based intelligence
- Intelligent agent dispatch: project agents > plugin agents > general-purpose
- Agent-mapping Session Config for explicit role-to-agent binding
- Model selection matrix (haiku/sonnet/opus per task type)

## Session Config

persistence: true
enforcement: warn
recent-commits: 20
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
stale-branch-days: 7
plugin-freshness-days: 30
plan-baseline-path: ~/Projects/projects-baseline
plan-prd-location: docs/prd
plan-retro-location: docs/retro
plan-default-visibility: internal
vcs: gitlab
docs-orchestrator:
  enabled: false           # opt-in; when true, session-start Phase 2.5 runs + docs-writer agent available
  audiences: [user, dev, vault]
  mode: warn               # warn | strict | off
vault-staleness:
  enabled: false           # opt-in vault-drift probes (runs in /discovery vault)
  thresholds:
    top: 30                # days — tier=top narrative staleness threshold
    active: 60             # days — tier=active
    archived: 180          # days — tier=archived
  mode: warn               # warn | strict | off
