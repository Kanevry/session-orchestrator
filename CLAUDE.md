# Session Orchestrator Plugin

Claude Code plugin for session-level orchestration. This is a **plugin repo** — not an application.

## Structure

- `skills/` — 16 skills (bootstrap, session-start, session-plan, wave-executor, session-end, claude-md-drift-check, ecosystem-health, gitlab-ops, quality-gates, discovery, plan, evolve, vault-sync, vault-mirror, daily, docs-orchestrator)
- `commands/` — 7 commands (/session, /go, /close, /discovery, /plan, /evolve, /bootstrap)
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
