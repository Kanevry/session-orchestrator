# Session Orchestrator Plugin

Claude Code plugin for session-level orchestration. This is a **plugin repo** — not an application.

## Structure

- `skills/` — 13 skills (bootstrap, session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops, quality-gates, discovery, plan, evolve, vault-sync, daily)
- `commands/` — 7 commands (/session, /go, /close, /discovery, /plan, /evolve, /bootstrap)
- `agents/` — 6 agents (code-implementer, test-writer, ui-developer, db-specialist, security-reviewer, session-reviewer)
- `hooks/` — 5 event hooks: SessionStart (banner + init), PreToolUse (scope enforcement + command guard), PostToolUse (edit validation), Stop (session events), SubagentStop (agent events)

## Development

Edit skills directly. Test by running `/session feature` in any project repo.

Skills are loaded by Claude Code from the plugin directory — no build step needed.

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

## v3.0 Migration (in progress)

Bash → Node.js (zx 8) migration for native Windows support. Epic #124. Current
branch: `feat/windows-native-v3`. Foundation wave (issues #125–#130, #132) landed;
hook migrations (#137–#142) and test migration (#143–#145) pending in future
sessions.

Development prerequisite: **Node 20+**. Run `npm ci` after cloning. Test with
`npm test` (vitest) plus `bash scripts/test/run-all.sh` (legacy shell suite —
will be retired in a later wave). Lint: `npm run lint`.

## v2.0 Features

- Session persistence via STATE.md + session memory files
- Scope & command enforcement hooks (PreToolUse)
- Circuit breaker: maxTurns limit + spiral detection
- Worktree isolation for parallel agent execution
- 5 new Session Config fields (persistence, enforcement, circuit breaker, worktrees, ecosystem-health)
- Session metrics tracking with historical trends (sessions.jsonl)
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
