# Platform Tool Reference

> Skills reference this document for platform-specific tool syntax. Both platforms share the same skill files — this reference resolves the differences.

## Platform Detection

The current platform is determined by the `scripts/lib/platform.sh` library:
- `$SO_PLATFORM` = `claude` | `codex`
- Environment: `$CLAUDE_PLUGIN_ROOT` (Claude Code) or `$CODEX_PLUGIN_ROOT` (Codex CLI)

## Identical Tools (no mapping needed)

These tools have the same name and behavior on both platforms:
- **Read** — read file contents
- **Write** — create/overwrite files
- **Edit** — string replacement in files
- **Bash** — execute shell commands
- **Glob** — file pattern matching
- **Grep** — content search (ripgrep)

## Platform-Specific Tool Mapping

| Function | Claude Code | Codex CLI |
|----------|------------|-----------|
| Present choices to user | `AskUserQuestion` tool with structured options | Numbered Markdown list as plain text, wait for user reply |
| Dispatch subagent | `Agent({ description, prompt, subagent_type })` | Describe the task; Codex routes to defined agent roles (explorer, wave-worker, session-reviewer) via `/agent` |
| Track tasks | `TaskCreate` / `TaskUpdate` / `TaskList` | Plain-text checklist in response context |
| Enter plan mode | `EnterPlanMode` / `ExitPlanMode` tools | `/plan` slash command (prompt-level, not tool-based) |
| Web search | `WebSearch` tool | Built-in web search (invoke via instruction) |
| Web fetch | `WebFetch` tool | Not available natively; use MCP or Bash curl |

## AskUserQuestion Fallback Pattern

When a skill instructs "Use the AskUserQuestion tool", apply this pattern:

**On Claude Code:** Use the AskUserQuestion tool with structured options as documented.

**On Codex CLI:** Present the same choices as a numbered Markdown list and ask the user to respond:
```
Choose one:
1. Option A — description
2. Option B — description  
3. Option C — description

Reply with the number of your choice.
```

## Agent Dispatch Pattern

**On Claude Code:**
```
Agent({
  description: "3-5 word summary",
  prompt: "full task context...",
  subagent_type: "general-purpose",
  run_in_background: false
})
```

**On Codex CLI:**
Describe the agent task in detail. Codex routes to the appropriate agent role:
- **explorer** — read-only evidence gathering (maps to Claude Code's `Explore` subagent)
- **wave-worker** — implementation tasks (maps to Claude Code's `general-purpose` subagent)
- **session-reviewer** — quality review (maps to Claude Code's `session-orchestrator:session-reviewer`)

## Model Preference Mapping

| Claude Code | Codex CLI | Use Case |
|------------|-----------|----------|
| opus | gpt-5.4 | Complex reasoning, architecture, session coordination |
| sonnet | gpt-5.4-mini | Implementation, review, routine tasks |
| haiku | gpt-5.4-mini | Simple lookups, fast checks |

Skills use `model-preference` (Claude) and `model-preference-codex` (Codex) in YAML frontmatter.

## State Directory

- **Claude Code:** `.claude/` (STATE.md, wave-scope.json)
- **Codex CLI:** `.codex/` (STATE.md, wave-scope.json)
- **Shared:** `.orchestrator/metrics/` (sessions.jsonl, learnings.jsonl) — both platforms read and write here

## Config File

- **Claude Code:** Session Config in `CLAUDE.md` under `## Session Config`
- **Codex CLI:** Session Config in `AGENTS.md` under `## Session Config`
- Format is identical on both platforms.
