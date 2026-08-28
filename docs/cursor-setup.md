# Cursor IDE Setup Guide

Guide for using Session Orchestrator with Cursor IDE.

## Prerequisites

- [Cursor IDE](https://cursor.com) installed (version 1.7+ recommended for hooks support)
- Node.js 24+
- A project repository with git initialized

## Installation

```bash
git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator
cd ~/Projects/session-orchestrator && npm install
node ~/Projects/session-orchestrator/scripts/cursor-install.mjs /path/to/your-project
```

The installer links four Cursor-native surfaces into the target project:

| Surface | Path | What Cursor does with it |
|---|---|---|
| Rules | `.cursor/rules/*.mdc` | Always-on + intelligent-apply guidance |
| Commands | `.cursor/commands/*.md` | Slash commands (`/session`, `/go`, `/close`, …) |
| Skills | `.cursor/skills/<name>/SKILL.md` | Skill discovery; wrappers point at canonical `skills/` |
| Hooks | `.cursor/hooks.json` | Native hooks via `scripts/lib/cursor-hook-bridge.mjs` |

Working **in this repo** does not need the installer — those paths are committed. Reload Cursor (or start a new agent chat) after a pull so `/session` appears.

## Configuration

Cursor reads CLAUDE.md natively. Add a `## Session Config` section:

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

`agents-per-wave` is ignored on Cursor — tasks execute sequentially (no parallel Agent dispatch).

## Usage

- `/session [housekeeping|feature|deep]` — Start a session
- `/go` — Execute the agreed plan
- `/close` — End session with verification
- `/plan [new|feature|retro]` — Plan a project/feature
- `/discovery [scope]` — Run quality probes
- `/evolve [analyze|review|list]` — Manage learnings

Cursor has no Skill tool. Commands tell the agent to **Read** `skills/<name>/SKILL.md` and follow it.

## Key Differences from Claude Code

| Aspect | Claude Code | Cursor IDE |
|--------|------------|------------|
| Interactive choices | AskUserQuestion tool | Numbered Markdown lists |
| Agent dispatch | Agent() tool (parallel) | Sequential execution (no subagents) |
| State directory | .claude/ | .cursor/ |
| Config file | CLAUDE.md | CLAUDE.md (same!) |
| Task tracking | TaskCreate/TaskUpdate | Text-based checklists |
| Pre-edit enforcement | PreToolUse hook (blocks) | `preToolUse` via cursor-hook-bridge (blocks) |
| Command enforcement | PreToolUse hook (blocks) | `beforeShellExecution` via cursor-hook-bridge (blocks) |
| Post-edit | PostToolUse | `afterFileEdit` is post-hoc (cannot unwrite) |
| Model | Claude via API | Model selected in Cursor settings |
| Plan mode | EnterPlanMode tool | Instruction-based |

## Limitations

1. **No parallel agents** — All wave tasks execute sequentially. Sessions take longer than in Claude Code.
2. **afterFileEdit cannot prevent an edit** — it fires after the write. Scope blocking belongs on `preToolUse`.
3. **Model preference advisory** — The `model-preference-cursor` frontmatter in skills is advisory only. Select your model in Cursor settings.
4. **No Agent/Skill tools** — `pre-task-scope-disjoint` and `skill-invocation-telemetry` are not wired; commands Read skill files directly.

## Shared Knowledge

All platforms share knowledge via `.orchestrator/metrics/`:
- `sessions.jsonl` — Session history (all platforms write here with a `platform` field)
- `learnings.jsonl` — Cross-session intelligence

Switch freely between Claude Code, Codex, and Cursor on the same project — all benefit from accumulated learnings.

## Troubleshooting

- **`/session` missing**: Confirm `.cursor/commands/session.md` exists. Reload Cursor. If this is another project, re-run `node scripts/cursor-install.mjs .`
- **Rules not loading**: Ensure `.cursor/rules/` exists with `.mdc` files; `000-session-orchestrator.mdc` has `alwaysApply: true`
- **Hooks not firing**: Confirm `.cursor/hooks.json` exists. Open Cursor Settings → Hooks. Restart Cursor if it was open during install.
- **`'node' not found` in hook PATH**: See README troubleshooting. `hooks/run-node.sh` resolves Homebrew/nvm Node.
- **State files not created**: Check `.cursor/` is writable
