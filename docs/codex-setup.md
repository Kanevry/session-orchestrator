# Codex Setup Guide

Guide for using Session Orchestrator with OpenAI Codex.

## Prerequisites

- Codex installed and configured
- jq installed (`brew install jq` / `apt install jq`)
- A project repository with git initialized

## Installation

### Option 1: Home-local plugin
```bash
git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator
bash ~/Projects/session-orchestrator/scripts/codex-install.sh
```

The installer auto-detects the active Codex desktop plugin catalog at `~/.codex/.tmp/plugins` and falls back to a home-local marketplace when that catalog is not present.

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

### 2. What the installer does

- Copies the plugin bundle into the active Codex plugin store
- Registers `session-orchestrator` in the matching marketplace JSON
- Enables the plugin in `~/.codex/config.toml`
- Prints the final restart hint

Restart Codex after running the installer so the command index refreshes.

### 3. Agent Roles (Optional)

Copy the agent definitions from `.codex-plugin/agents/` to your project's `.codex/agents/`:
```bash
cp -r path/to/session-orchestrator/.codex-plugin/agents/ .codex/agents/
```

### 4. Hooks (Optional)

The plugin manifest points Codex at `hooks/hooks-codex.json`. If your Codex build supports plugin hooks, they are loaded from the manifest. If your build still expects a project-level hook file, copy `hooks/hooks-codex.json` to the appropriate local hook config.

## Usage

After restart, the plugin exposes these commands:
- `/session [housekeeping|feature|deep]` -- Start a session
- `/go` -- Execute the agreed plan
- `/close` -- End session with verification
- `/plan [new|feature|retro]` -- Plan a project/feature
- `/discovery [scope]` -- Run quality probes
- `/evolve [analyze|review|list]` -- Manage learnings

## Key Differences from Claude Code

| Aspect | Claude Code | Codex |
|--------|------------|-----------|
| Interactive choices | AskUserQuestion tool | Numbered Markdown lists |
| Agent dispatch | Agent() tool | Codex subagents / typed roles |
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

- **Commands not recognized**: Re-run `bash scripts/codex-install.sh`, then restart Codex completely
- **Hooks not firing**: Verify your Codex build supports plugin hooks or copy `hooks/hooks-codex.json` into your local hook config
- **Agent dispatch fails**: Verify Codex subagent support is available in your build and the agent TOMLs exist in `.codex-plugin/agents/`
- **jq not found**: Install jq for scope enforcement hooks
