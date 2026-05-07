# Steering: Repo Structure

> Stable directory layout and inventory for session context injection. Not session narrative.
> Maintained by: coordinator or `/plan new` scaffolding.
> Do NOT commit secrets. Do NOT include session-specific state here.

## Top-Level Directory Map

| Path | Purpose |
|------|---------|
| `skills/` | 26 user-facing skills (+ `_shared/` internal) |
| `commands/` | 10 slash-commands (e.g. `/session`, `/close`, `/go`, `/plan`) |
| `agents/` | 7 sub-agent definitions (YAML frontmatter + Markdown body) |
| `hooks/` | Hook event matchers + handlers (6 matchers / 6 handlers) |
| `.orchestrator/policy/` | Runtime policy: `blocked-commands.json` (13 rules) |
| `.orchestrator/steering/` | This directory — persistent stable context docs |
| `.orchestrator/metrics/` | Runtime JSONL telemetry: sessions, learnings, autopilot |
| `.claude/rules/` | Always-on rule files loaded by Claude Code |
| `scripts/` | Node.js automation scripts (`.mjs` only) |
| `scripts/lib/` | Shared library modules (no `.sh` — bash-free since 2026-04-30) |
| `tests/` | vitest test suite mirroring `scripts/lib/` + `tests/skills/` |
| `docs/` | PRDs, ADRs, retros, marketplace, CI setup |
| `.claude-plugin/` | Claude Code plugin manifest |
| `.codex-plugin/` | Codex CLI plugin manifest |

## Inventory (canonical)

- **Skills:** 26 user-facing skills (`skills/` has 27 dirs but `_shared/` is internal)
- **Commands:** 10 (`/session`, `/close`, `/go`, `/plan`, `/evolve`, `/discovery`, `/bootstrap`, `/autopilot`, `/repo-audit`, `/harness-audit`)
- **Agents:** 7 (`code-implementer`, `db-specialist`, `docs-writer`, `security-reviewer`, `session-reviewer`, `test-writer`, `ui-developer`)
- **Hook event matchers / handlers:** 6 matchers / 6 handlers (hooks.json has 5 event keys with 6 matcher entries because PreToolUse splits into Edit|Write + Bash)

## Key Skills (frequently referenced)

| Skill | Directory | Role |
|-------|-----------|------|
| session-start | `skills/session-start/` | Full session init, Phases 0–9 |
| session-end | `skills/session-end/` | Metrics write, vault mirror, close |
| session-plan | `skills/session-plan/` | Wave decomposition |
| wave-executor | `skills/wave-executor/` | Parallel agent orchestration |
| evolve | `skills/evolve/` | Learning lifecycle (8 types) |
| discovery | `skills/discovery/` | Probes: git, VCS, SSOT, arch, vault |
| mode-selector | `skills/mode-selector/` | Mode recommendation from learnings |
| autopilot | `skills/autopilot/` | Headless driver loop |
| bootstrap | `skills/bootstrap/` | First-run setup, owner persona |
| vault-mirror | `skills/vault-mirror/` | Obsidian vault sync |

## Hook Events

| Event | Handler file |
|-------|-------------|
| PreToolUse (Edit/Write) | `hooks/post-edit-validate.mjs` |
| PreToolUse (Bash) | `hooks/pre-bash-destructive-guard.mjs` |
| PostToolUse | `hooks/enforce-commands.mjs` |
| SessionStart | `hooks/on-session-start.mjs` |
| Stop | `hooks/on-stop.mjs` |
| SubagentStop | `hooks/enforce-scope.mjs` |
