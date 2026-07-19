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
| `hooks/` | Hook event matchers + handlers (15 matcher entries / 20 plugin-wired handler files [21 on-disk; the additional guard is Husky-wired — see Inventory below], 10 distinct plugin events) |
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
- **Plugin hook event matchers / handlers:** 15 matcher entries / 20 plugin-wired handler files (21 on-disk; `hooks/wave-scope-commit-guard.mjs` is the additional Husky-wired guard, invoked from `.husky/pre-commit` at commit time). Counting basis: "plugin-wired" = distinct `.mjs` filenames referenced inside `hooks/hooks.json`; "Husky-wired" = invoked from `.husky/pre-commit`; "on-disk" = `ls hooks/*.mjs`. The guard enforces staged Git paths at commit time rather than a Claude/Codex plugin lifecycle event, so it is intentionally absent from the plugin hook manifests `hooks/hooks.json` and `hooks/hooks-codex.json`. 10 distinct plugin events: SessionStart, SessionEnd, PreToolUse (×3: Skill + Edit\|Write\|MultiEdit + Bash), PostToolUse (×3: Edit\|Write + Edit\|Write\|MultiEdit + `*`), Stop, SubagentStop, PostToolUseFailure, PostToolBatch (×2: wave-signal + operator-steer), SubagentStart, CwdChanged.

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
| PreToolUse | `Skill` | `hooks/skill-invocation-telemetry.mjs` |
| PreToolUse | `Edit\|Write\|MultiEdit` | `hooks/enforce-scope.mjs` + `hooks/config-protection.mjs` |
| PreToolUse | `Bash` | `hooks/pre-bash-destructive-guard.mjs` + `hooks/pre-bash-staging-fence.mjs` + `hooks/pre-bash-memory-propose-audit.mjs` + `hooks/pre-bash-templates-first.mjs` + `hooks/enforce-commands.mjs` |
| PostToolUse | `Edit\|Write` | `hooks/post-edit-validate.mjs` |
| PostToolUse | `Edit\|Write\|MultiEdit` | `hooks/post-tooluse-frontend-slop.mjs` |
| PostToolUse | `*` | `hooks/loop-guard.mjs` |
| Stop | `""` | `hooks/on-stop.mjs` |
| SubagentStop | `""` | `hooks/on-stop.mjs` + `hooks/subagent-telemetry.mjs` + `hooks/post-subagent-discovery-validator.mjs` |
| PostToolUseFailure | `""` | `hooks/post-tool-failure-corrective-context.mjs` |
| PostToolBatch | `""` | `hooks/post-tool-batch-wave-signal.mjs` |
| PostToolBatch | `""` | `hooks/operator-steer.mjs` |
| SubagentStart | `""` | `hooks/subagent-telemetry.mjs` |
| CwdChanged | `""` | `hooks/cwd-change-restore.mjs` |

> Table is exhaustive for plugin lifecycle hooks: one row per matcher entry — **15 matcher entries / 20 plugin-wired handler files** across these 10 events — see `hooks/hooks.json` (SSOT). `hooks/wave-scope-commit-guard.mjs` is the 21st on-disk `.mjs` file and is separately Husky-wired from `.husky/pre-commit`; because it enforces staged Git paths at commit time rather than a Claude/Codex plugin lifecycle event, its absence from `hooks/hooks.json` and `hooks/hooks-codex.json` is intentional. Counting basis: "plugin-wired" counts distinct `.mjs` filenames referenced inside `hooks/hooks.json`; "Husky-wired" means invoked from `.husky/pre-commit`; "on-disk" counts `ls hooks/*.mjs`.
