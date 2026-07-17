# Steering: Repo Structure

> Stable directory layout and inventory for session context injection. Not session narrative.
> Maintained by: coordinator or `/plan new` scaffolding.
> Do NOT commit secrets. Do NOT include session-specific state here.

## Top-Level Directory Map

| Path | Purpose |
|------|---------|
| `skills/` | 44 user-facing skills (+ `_shared/` internal) |
| `commands/` | 24 slash-commands (e.g. `/session`, `/close`, `/go`, `/plan`, `/test`, `/portfolio`, `/dispatcher`, `/eval`) |
| `agents/` | 15 sub-agent definitions (YAML frontmatter + Markdown body, + `schemas/` subdirectory) |
| `hooks/` | Hook event matchers + handlers (14 matcher entries / 19 handler files, 10 distinct events) |
| `.orchestrator/policy/` | Runtime policy: `blocked-commands.json` (13 rules) |
| `.orchestrator/steering/` | This directory — persistent stable context docs |
| `.orchestrator/metrics/` | Runtime JSONL telemetry: sessions, learnings, autopilot, events, subagents |
| `.claude/rules/` | Always-on rule files loaded by Claude Code |
| `scripts/` | Node.js automation scripts (`.mjs` only) — includes Phase 1 migration helpers `vault-consolidate.mjs` (#499), `migrate-vault-paths.mjs` (#499), `migrate-cold-start-seed.mjs` (#507) |
| `scripts/lib/` | Shared library modules (no `.sh` — bash-free since 2026-04-30) — includes `cold-start-detector.mjs` (#500), `auto-dream.mjs` (#502), `loop-readiness-banner.mjs` (#633), and `config/{cold-start,vault-mirror-quality}.mjs` parsers |
| `tests/` | vitest test suite mirroring `scripts/lib/` + `tests/skills/` |
| `templates/` | Vendorable scaffolding (`_shared/loop.md` bare-`/loop` baseline #633, `_shared/rules/`) copied into consumer repos |
| `docs/` | PRDs, ADRs, retros, marketplace, CI setup |
| `.claude-plugin/` | Claude Code plugin manifest |
| `.codex-plugin/` | Codex CLI plugin manifest |
| `assets/` | Repo assets (`icon.svg`, `og-card.svg`) |

## Inventory (canonical)

- **Skills:** 44 user-facing skills (`skills/` has 45 dirs but `_shared/` is internal docs, not a skill)
- **Commands:** 24 (`/session`, `/close`, `/go`, `/plan`, `/evolve`, `/discovery`, `/bootstrap`, `/autopilot`, `/autopilot-multi`, `/dispatcher`, `/repo-audit`, `/harness-audit`, `/test`, `/memory-cleanup`, `/portfolio`, `/brainstorm`, `/debug`, `/persona-panel`, `/grill`, `/sunset-review`, `/templates-ack`, `/reconcile`, `/eval`, `/spinout`)
- **Agents:** 15 (`code-implementer`, `test-writer`, `ui-developer`, `db-specialist`, `security-reviewer`, `session-reviewer`, `docs-writer`, `architect-reviewer`, `qa-strategist`, `analyst`, `ux-evaluator`, `dialectic-deriver`, `memory-proposal-collector`, `skill-applied-judge`, `eval-judge`)
- **Hook event matchers / handlers:** 14 matcher entries / 19 handler files. 10 distinct events: SessionStart, SessionEnd, PreToolUse (×2: Edit\|Write + Bash), PostToolUse, Stop, SubagentStop, PostToolUseFailure, PostToolBatch (×2: wave-signal + operator-steer), SubagentStart, CwdChanged.

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
| test-runner | `skills/test-runner/` | Agentic E2E test orchestration (Playwright + Peekaboo) |
| gitlab-portfolio | `skills/gitlab-portfolio/` | Cross-repo health dashboard |
| brainstorm | `skills/brainstorm/` | Socratic design dialogue |
| debug | `skills/debug/` | 4-phase root-cause investigation |
| write-executable-plan | `skills/write-executable-plan/` | Bite-sized implementation plan generator |

## Hook Events

| Event | Matcher | Handler file(s) |
|-------|---------|-----------------|
| SessionStart | `startup\|clear\|compact` | `hooks/on-session-start.mjs` |
| SessionEnd | `""` | `hooks/on-session-end.mjs` |
| PreToolUse | `Edit\|Write` | `hooks/enforce-scope.mjs` |
| PreToolUse | `Bash` | `hooks/pre-bash-destructive-guard.mjs` + `hooks/enforce-commands.mjs` |
| PostToolUse | `Edit\|Write` | `hooks/post-edit-validate.mjs` |
| Stop | `""` | `hooks/on-stop.mjs` |
| SubagentStop | `""` | `hooks/on-stop.mjs` + `hooks/subagent-telemetry.mjs` |
| PostToolUseFailure | `""` | `hooks/post-tool-failure-corrective-context.mjs` |
| PostToolBatch | `""` | `hooks/post-tool-batch-wave-signal.mjs` |
| PostToolBatch | `""` | `hooks/operator-steer.mjs` |
| SubagentStart | `""` | `hooks/subagent-telemetry.mjs` |
| CwdChanged | `""` | `hooks/cwd-change-restore.mjs` |

> Table shows the primary matcher→handler mapping. The full manifest is **14 matcher entries / 19 handler files** across these 10 events — see `hooks/hooks.json` (SSOT).
