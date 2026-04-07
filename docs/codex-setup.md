# Codex CLI Setup Guide

Guide for using Session Orchestrator with OpenAI's Codex CLI.

## Prerequisites

- [Codex CLI](https://developers.openai.com/codex/cli) installed and configured
- jq installed (`brew install jq` / `apt install jq`)
- A project repository with git initialized

## Installation

### Option 1: Clone as local plugin
```bash
git clone https://github.com/Kanevry/session-orchestrator.git ~/.codex/plugins/session-orchestrator
```

### Option 2: Project-local
```bash
git clone https://github.com/Kanevry/session-orchestrator.git .codex/plugins/session-orchestrator
```

## Configuration

### 1. Session Config in AGENTS.md

Add a `## Session Config` section to your project's `AGENTS.md`. The format is identical to Claude Code's CLAUDE.md config:

```markdown
## Session Config

agents-per-wave: 6
waves: 5
persistence: true
enforcement: warn
```

See `docs/templates/AGENTS-session-config.md` for a complete template.

### 2. Enable Multi-Agent Support

Add to your `.codex/config.toml`:
```toml
[features]
multi_agent = true
```

### 3. Agent Roles (Optional)

Copy the agent definitions from `.codex-plugin/agents/` to your project's `.codex/agents/`:
```bash
cp -r path/to/session-orchestrator/.codex-plugin/agents/ .codex/agents/
```

### 4. Hooks (Experimental)

Codex hooks are experimental. To enable:
```toml
[features]
hooks = true
```

Copy `hooks/hooks-codex.json` to `.codex/hooks.json`.

## Usage

Commands work the same as in Claude Code:
- `/session [housekeeping|feature|deep]` -- Start a session
- `/go` -- Execute the agreed plan
- `/close` -- End session with verification
- `/plan [new|feature|retro]` -- Plan a project/feature
- `/discovery [scope]` -- Run quality probes
- `/evolve [analyze|review|list]` -- Manage learnings

## Key Differences from Claude Code

| Aspect | Claude Code | Codex CLI |
|--------|------------|-----------|
| Interactive choices | AskUserQuestion tool | Numbered Markdown lists |
| Agent dispatch | Agent() tool | Multi-agent roles (explorer, wave-worker, session-reviewer) |
| State directory | .claude/ | .codex/ |
| Config file | CLAUDE.md | AGENTS.md |
| Task tracking | TaskCreate/TaskUpdate | Text-based checklists |
| Model | Claude Opus 4.6 / Sonnet 4.6 | GPT-5.4 / GPT-5.4-mini |

## Shared Knowledge

Both platforms share knowledge via `.orchestrator/metrics/`:
- `sessions.jsonl` -- Session history (both platforms write here)
- `learnings.jsonl` -- Cross-session intelligence

This means you can switch between Claude Code and Codex CLI on the same project and both will benefit from accumulated learnings.

## Platform Limitations

### Agent Specialization

Claude Code uses 5 domain-specific agents (code-implementer, test-writer, db-specialist, ui-developer, security-reviewer) with specialized prompts for each role. Codex CLI maps all implementation tasks to the generic `wave-worker` role, which means:

- All agents share the same base prompt and capabilities
- Domain-specific instructions (e.g., test quality rules, security review patterns) are included in the task prompt rather than the agent definition
- The practical impact is minimal for most tasks — the task prompt carries the specialization

**Workaround:** Create project-level agents in `.codex/agents/` with domain-specific TOML files. These take precedence over plugin-level agents during dispatch.

## Troubleshooting

- **Commands not recognized**: Ensure AGENTS.md has the Session Config section
- **Hooks not firing**: Check that hooks are enabled in config.toml
- **Agent dispatch fails**: Verify multi_agent is enabled and agent TOMLs are in place
- **jq not found**: Install jq for scope enforcement hooks
