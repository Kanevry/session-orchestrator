# Steering: Repo Structure

> Stable directory layout and inventory for session context injection. Not session narrative.
> Maintained by: coordinator or `/plan new` scaffolding.
> Do NOT commit secrets. Do NOT include session-specific state here.

## Top-Level Directory Map

| Path | Purpose |
|------|---------|
| `skills/` | 48 user-facing skills (+ `_shared/` internal) |
| `commands/` | 28 slash-commands (e.g. `/session`, `/close`, `/go`, `/plan`, `/test`, `/portfolio`, `/dispatcher`, `/eval`) |
| `agents/` | 15 sub-agent definitions (YAML frontmatter + Markdown body, + `schemas/` subdirectory) |
| `hooks/` | Hook event matchers + handlers (18 matcher entries / 25 plugin-wired handler files [26 on-disk; the 26th is Husky-wired — see Inventory below], 10 distinct events) |
| `.orchestrator/policy/` | Runtime policy: `blocked-commands.json` (14 rules) |
| `.orchestrator/steering/` | This directory — persistent stable context docs |
| `.orchestrator/metrics/` | Runtime JSONL telemetry: sessions, learnings, autopilot, events, subagents |
| `.claude/rules/` | Always-on rule files loaded by Claude Code |
| `scripts/` | Node.js automation scripts (`.mjs` only) — includes Phase 1 migration helpers `vault-consolidate.mjs` (#499), `migrate-vault-paths.mjs` (#499), `migrate-cold-start-seed.mjs` (#507) |
| `scripts/lib/` | Shared library modules (no `.sh` — bash-free since 2026-04-30) — includes `cold-start-detector.mjs` (#500), `auto-dream.mjs` (#502), `loop-readiness-banner.mjs` (#633), `config/{cold-start,vault-mirror-quality}.mjs` parsers, `sessions-canonical.mjs` (#1167), `config/health-endpoints.mjs` (#1174), and `vault-status/board-lock.mjs` (#1180) |
| `tests/` | vitest test suite mirroring `scripts/lib/` + `tests/skills/` |
| `templates/` | Vendorable scaffolding (`_shared/loop.md` bare-`/loop` baseline #633, `_shared/rules/`) copied into consumer repos |
| `docs/` | PRDs, ADRs, retros, marketplace, CI setup |
| `.claude-plugin/` | Claude Code plugin manifest |
| `.codex-plugin/` | Codex CLI plugin manifest |
| `assets/` | Repo assets (`icon.svg`, `og-card.svg`) |

## Inventory (canonical)

- **Skills:** 48 user-facing skills (`skills/` has 49 dirs but `_shared/` is internal docs, not a skill) — measured 2026-09-02 (`ls -d skills/*/ | grep -v _shared | wc -l`)
- **Commands:** 28 — measured 2026-09-02 (`ls commands/*.md | wc -l`) (`/session`, `/close`, `/go`, `/plan`, `/evolve`, `/discovery`, `/bootstrap`, `/autopilot`, `/autopilot-multi`, `/dispatcher`, `/repo-audit`, `/harness-audit`, `/test`, `/memory-cleanup`, `/portfolio`, `/brainstorm`, `/debug`, `/persona-panel`, `/grill`, `/sunset-review`, `/templates-ack`, `/reconcile`, `/eval`, `/spinout`, `/contract-version-bump`, `/eli5`, `/journey-audit`, `/release`)
- **Agents:** 15 (`code-implementer`, `test-writer`, `ui-developer`, `db-specialist`, `security-reviewer`, `session-reviewer`, `docs-writer`, `architect-reviewer`, `qa-strategist`, `analyst`, `ux-evaluator`, `dialectic-deriver`, `memory-proposal-collector`, `skill-applied-judge`, `eval-judge`) — measured 2026-09-02 (`ls agents/*.md | grep -v AGENTS.md | wc -l`)
- **Hook event matchers / handlers:** 18 matcher entries / 25 plugin-wired handler files (26 on-disk) — measured 2026-09-02 (`hooks/hooks.json` walked for distinct `.mjs` command citations; `ls hooks/*.mjs | wc -l`). The 26th, `hooks/wave-scope-commit-guard.mjs`, is intentionally NOT a plugin hook — it is wired as the repository's Git pre-commit guard via Husky (`.husky/pre-commit:139`), because it guards git index/commit state (staged-path scope + cross-agent staging-fence) rather than a plugin lifecycle event (#821, supersedes the #801 unwired-on-disk framing). Counting basis: "plugin-wired" = distinct `.mjs` filenames referenced inside `hooks/hooks.json`; "Husky-wired" = referenced inside `.husky/pre-commit`; "on-disk" = `ls hooks/*.mjs`. 10 distinct events: SessionStart, SessionEnd, PreToolUse (×4: Skill + Edit\|Write\|MultiEdit + Bash + AskUserQuestion), PostToolUse (×4: Edit\|Write + Edit\|Write\|MultiEdit + Bash + `*`), Stop, SubagentStop, PostToolUseFailure, PostToolBatch (×2: wave-signal + operator-steer), SubagentStart, CwdChanged.
- **Validators:** 33 `scripts/lib/validate/check-*.mjs` modules — measured 2026-09-02 (`ls scripts/lib/validate/check-*.mjs | wc -l`). The newest, `check-skill-script-paths.mjs` (#1176), scans `skills/`/`commands/`/`agents/` for dead `scripts/**.mjs` citations and is wired as a BLOCKING check inside `scripts/validate-plugin.mjs` (`runCheck('check-skill-script-paths.mjs')`), not merely advisory.
- **ADRs:** 18 — measured 2026-09-02 (`ls docs/adr/*.md | wc -l`). The newest is `docs/adr/0014-peer-visibility-under-advisory-lock.md` (GH#67).

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
| PreToolUse | `Bash` | `hooks/pre-bash-destructive-guard.mjs` + `hooks/pre-bash-staging-fence.mjs` + `hooks/pre-bash-memory-propose-audit.mjs` + `hooks/pre-bash-sessions-ledger-guard.mjs` + `hooks/pre-bash-templates-first.mjs` + `hooks/pre-bash-issue-budget.mjs` + `hooks/enforce-commands.mjs` |
| PreToolUse | `Agent` | `hooks/pre-task-scope-disjoint.mjs` |
| PreToolUse | `AskUserQuestion` | `hooks/pre-auq-clarity.mjs` |
| PostToolUse | `Edit\|Write` | `hooks/post-edit-validate.mjs` |
| PostToolUse | `Edit\|Write\|MultiEdit` | `hooks/post-tooluse-frontend-slop.mjs` |
| PostToolUse | `Bash` | `hooks/post-bash-write-verify.mjs` |
| PostToolUse | `*` | `hooks/loop-guard.mjs` |
| Stop | `""` | `hooks/on-stop.mjs` |
| SubagentStop | `""` | `hooks/on-stop.mjs` + `hooks/subagent-telemetry.mjs` + `hooks/post-subagent-discovery-validator.mjs` |
| PostToolUseFailure | `""` | `hooks/post-tool-failure-corrective-context.mjs` |
| PostToolBatch | `""` | `hooks/post-tool-batch-wave-signal.mjs` |
| PostToolBatch | `""` | `hooks/operator-steer.mjs` |
| SubagentStart | `""` | `hooks/subagent-telemetry.mjs` |
| CwdChanged | `""` | `hooks/cwd-change-restore.mjs` |

> Table is exhaustive: one row per matcher entry — **18 matcher entries / 25 plugin-wired handler files** across these 10 events — see `hooks/hooks.json` (SSOT). `hooks/wave-scope-commit-guard.mjs` is on-disk (26 total `.mjs` files under `hooks/`) but wired through a DISTINCT channel — the repository's Husky-managed Git pre-commit guard (`.husky/pre-commit`, not `hooks/hooks.json`) — because it guards git commit/index state rather than a plugin lifecycle event (#821). Counting basis: "plugin-wired" counts distinct `.mjs` filenames referenced inside `hooks/hooks.json`; "on-disk" counts `ls hooks/*.mjs`. Measured 2026-09-02.
