# Session Orchestrator Plugin

Claude Code plugin for session-level orchestration. This is a **plugin repo** — not an application.

## Structure

- `skills/` — 8 skills (session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops, quality-gates, discovery)
- `commands/` — 4 commands (/session, /go, /close, /discovery)
- `agents/` — 1 agent (session-reviewer)
- `hooks/` — SessionStart notification

## Development

Edit skills directly. Test by running `/session feature` in any project repo.

Skills are loaded by Claude Code from the plugin directory — no build step needed.

## Key Conventions

- Skills use Markdown with YAML frontmatter
- Commands use `$ARGUMENTS` for user input
- Agent definitions need `<example>` blocks in description
- Hooks use the Claude Code hooks.json format
