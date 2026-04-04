# Session Orchestrator Plugin

Claude Code plugin for session-level orchestration. This is a **plugin repo** — not an application.

## Structure

- `skills/` — 9 skills (session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops, quality-gates, discovery, plan)
- `commands/` — 5 commands (/session, /go, /close, /discovery, /plan)
- `agents/` — 1 agent (session-reviewer)
- `hooks/` — SessionStart notification + PreToolUse enforcement (scope + commands)

## Development

Edit skills directly. Test by running `/session feature` in any project repo.

Skills are loaded by Claude Code from the plugin directory — no build step needed.

## Key Conventions

- Skills use Markdown with YAML frontmatter
- Commands use `$ARGUMENTS` for user input
- Agent definitions need `<example>` blocks in description
- Hooks use the Claude Code hooks.json format

## v2.0 Features

- Session persistence via STATE.md + session memory files
- Scope & command enforcement hooks (PreToolUse)
- Circuit breaker: maxTurns limit + spiral detection
- Worktree isolation for parallel agent execution
- 5 new Session Config fields (persistence, enforcement, circuit breaker, worktrees, ecosystem-health)
- Session metrics tracking with historical trends (sessions.jsonl)
- Adaptive wave sizing based on complexity scoring
- Cross-session learning system with confidence-based intelligence
