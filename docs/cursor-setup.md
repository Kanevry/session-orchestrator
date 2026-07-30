# Cursor IDE Setup Guide

Guide for using Session Orchestrator with Cursor IDE.

## Prerequisites

- [Cursor IDE](https://cursor.com) installed (version 1.7+ recommended for hooks support)
- jq installed (`brew install jq` / `apt install jq`)
- A project repository with git initialized

## Installation

### Option 1: Clone and symlink (recommended)
```bash
# 1. Clone the session-orchestrator repo and install its dependencies
git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator
cd ~/Projects/session-orchestrator && npm install

# 2. Symlink Cursor rules into your project
node ~/Projects/session-orchestrator/scripts/cursor-install.mjs /path/to/your/project
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

test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
agents-per-wave: 6
waves: 5
persistence: true
enforcement: warn
vcs: github
```

Note: `agents-per-wave` is ignored on Cursor since tasks execute sequentially (no parallel Agent dispatch).

### Hooks (Optional — not yet enforcing)

> **The hook handlers do not currently fire on Cursor (#919).** Both are written
> against Claude Code's `PreToolUse` payload — they require `tool_name === "Bash"`
> plus `tool_input.command`, and they signal a decision with a Claude Code
> `hookSpecificOutput` envelope. Fed a Cursor `beforeShellExecution` payload,
> `hooks/enforce-commands.mjs` short-circuits at its first gate and writes **0
> bytes to stdout and 0 bytes to stderr, exit 0** — so the harness sees no
> decision and **the command runs**. It is a silent no-op, not a block and not
> even a warning. Making this real needs a Cursor input/output adapter, the way
> Pi has `scripts/lib/pi-hook-bridge.mjs`; no such adapter exists yet.
>
> Until then, treat `hooks/hooks-cursor.json` as the *intended* mapping and do
> not rely on it for command or scope enforcement on Cursor.

Cursor supports hooks via Settings > Hooks. The intended mapping is:

- **afterFileEdit**: `hooks/enforce-scope.mjs` for scope enforcement (post-hoc warning)
- **beforeShellExecution**: `hooks/enforce-commands.mjs` for dangerous-command enforcement

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
| Pre-edit enforcement | PreToolUse hook (blocks) | None today — `afterFileEdit` handler is a no-op (#919) |
| Command enforcement | PreToolUse hook (blocks) | None today — `beforeShellExecution` handler is a no-op (#919) |
| Model | Claude via API | Model selected in Cursor settings |
| Plan mode | EnterPlanMode tool | Instruction-based |

## Limitations

1. **No parallel agents** — All wave tasks execute sequentially. Sessions take longer than in Claude Code.
2. **No hook enforcement yet (#919)** — the handlers in `hooks/hooks-cursor.json` are Claude Code `PreToolUse` handlers. On a Cursor payload both `enforce-commands.mjs` and `enforce-scope.mjs` short-circuit at their first gate and produce **0 bytes on stdout and stderr with exit 0** — a silent no-op, so nothing is blocked and nothing is warned. Two independent adapters are missing: Cursor's payload field names differ from `tool_name` / `tool_input.*`, and Cursor does not read Claude Code's `hookSpecificOutput` decision envelope. Even once adapted, Cursor's `afterFileEdit` fires *after* the edit, so scope enforcement could at best warn, never prevent.
3. **Model preference advisory** — The `model-preference-cursor` frontmatter in skills is advisory only. Select your model in Cursor settings.
4. **No native plugin loader** — Skills are delivered as `.cursor/rules/*.mdc` files, not loaded from a plugin directory.

## Shared Knowledge

All platforms share knowledge via `.orchestrator/metrics/`:
- `sessions.jsonl` — Session history (all platforms write here with a `platform` field)
- `learnings.jsonl` — Cross-session intelligence

Switch freely between Claude Code, Codex, and Cursor on the same project — all benefit from accumulated learnings.

## Troubleshooting

- **Rules not loading**: Ensure `.cursor/rules/` exists in your project root with `.mdc` files
- **Commands not recognized**: Check that `000-session-orchestrator.mdc` has `alwaysApply: true`
- **Hooks not firing**: Verify hooks are configured in Cursor Settings > Hooks
- **jq not found**: Install jq for scope enforcement hooks
- **State files not created**: Check `.cursor/` directory exists and is writable
