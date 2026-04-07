# Cursor IDE Setup Guide

Guide for using Session Orchestrator with Cursor IDE.

## Prerequisites

- [Cursor IDE](https://cursor.com) installed (version 1.7+ recommended for hooks support)
- jq installed (`brew install jq` / `apt install jq`)
- A project repository with git initialized

## Installation

### Option 1: Clone and symlink (recommended)
```bash
# 1. Clone the session-orchestrator repo
git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator

# 2. Symlink Cursor rules into your project
bash ~/Projects/session-orchestrator/scripts/cursor-install.sh /path/to/your/project
```

### Option 2: Manual copy
```bash
# Copy .cursor/rules/ into your project
cp -r path/to/session-orchestrator/.cursor/rules/ .cursor/rules/
```

## Configuration

### Session Config in CLAUDE.md

Cursor reads CLAUDE.md natively — no separate config file needed! Add a `## Session Config` section to your project's `CLAUDE.md`:

```markdown
## Session Config

agents-per-wave: 6
waves: 5
persistence: true
enforcement: warn
```

Note: `agents-per-wave` is ignored on Cursor since tasks execute sequentially (no parallel Agent dispatch).

### Hooks (Optional)

Cursor supports hooks via Settings > Hooks. Configure:

- **afterFileEdit**: Run `hooks/enforce-scope.sh` for scope enforcement (post-hoc warning)
- **beforeShellExecution**: Run `hooks/enforce-commands.sh` to block dangerous commands

See `hooks/hooks-cursor.json` for the hook mapping reference.

## Usage

Commands work the same as in Claude Code:
- `/session [housekeeping|feature|deep]` — Start a session
- `/go` — Execute the agreed plan
- `/close` — End session with verification
- `/plan [new|feature|retro]` — Plan a project/feature
- `/discovery [scope]` — Run quality probes
- `/evolve [analyze|review|list]` — Manage learnings

## Key Differences from Claude Code

| Aspect | Claude Code | Cursor IDE |
|--------|------------|------------|
| Interactive choices | AskUserQuestion tool | Numbered Markdown lists |
| Agent dispatch | Agent() tool (parallel) | Sequential execution (no subagents) |
| State directory | .claude/ | .cursor/ |
| Config file | CLAUDE.md | CLAUDE.md (same!) |
| Task tracking | TaskCreate/TaskUpdate | Text-based checklists |
| Pre-edit enforcement | PreToolUse hook (blocks) | afterFileEdit hook (warns after) |
| Command enforcement | PreToolUse hook (blocks) | beforeShellExecution hook (blocks) |
| Model | Claude via API | Model selected in Cursor settings |
| Plan mode | EnterPlanMode tool | Instruction-based |

## Limitations

1. **No parallel agents** — All wave tasks execute sequentially. Sessions take longer than in Claude Code.
2. **Post-hoc scope enforcement** — Cursor's `afterFileEdit` fires after the edit, not before. It can warn but not prevent out-of-scope edits.
3. **Model preference advisory** — The `model-preference-cursor` frontmatter in skills is advisory only. Select your model in Cursor settings.
4. **No native plugin loader** — Skills are delivered as `.cursor/rules/*.mdc` files, not loaded from a plugin directory.

## Shared Knowledge

All platforms share knowledge via `.orchestrator/metrics/`:
- `sessions.jsonl` — Session history (all platforms write here with a `platform` field)
- `learnings.jsonl` — Cross-session intelligence

Switch freely between Claude Code, Codex CLI, and Cursor on the same project — all benefit from accumulated learnings.

## Troubleshooting

- **Rules not loading**: Ensure `.cursor/rules/` exists in your project root with `.mdc` files
- **Commands not recognized**: Check that `000-session-orchestrator.mdc` has `alwaysApply: true`
- **Hooks not firing**: Verify hooks are configured in Cursor Settings > Hooks
- **jq not found**: Install jq for scope enforcement hooks
- **State files not created**: Check `.cursor/` directory exists and is writable
