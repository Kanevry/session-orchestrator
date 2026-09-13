# Steering: Repo Structure

> Stable directory layout and inventory for session context injection. Not session narrative.
> Maintained by: coordinator or `/plan new` scaffolding.
> Do NOT commit secrets. Do NOT include session-specific state here.
>
> **All counts below were measured on 2026-09-06** in the working tree at `e4674109` (v4.0.0 preparation — the release removes public surfaces, so counts are lower than in the 3.24.0 line). Each line carries the command that produced it; re-run the command rather than trusting the number.

## Top-Level Directory Map

| Path | Purpose |
|------|---------|
| `skills/` | 44 user-facing skills (+ `_shared/` internal) |
| `commands/` | 26 slash-commands (e.g. `/session`, `/close`, `/go`, `/plan`, `/test`, `/portfolio`, `/dispatcher`, `/eval`) |
| `agents/` | 14 sub-agent definitions (YAML frontmatter + Markdown body, + `schemas/` subdirectory). The authoring spec is NOT here — it lives in `docs/agent-authoring.md`, because Claude Code registers every `agents/*.md` as a dispatchable agent by directory convention |
| `hooks/` | Hook event matchers + handlers (18 matcher entries / 26 plugin-wired handler files [27 on-disk; the extra one is Husky-wired — see Inventory below], 10 distinct events) |
| `.orchestrator/policy/` | Runtime policy: `blocked-commands.json` (14 rules — 10 `severity: block`, 4 `severity: warn`) |
| `.orchestrator/steering/` | This directory — persistent stable context docs |
| `.orchestrator/metrics/` | Runtime JSONL telemetry: sessions, learnings, autopilot, events, subagents |
| `.claude/rules/` | 26 always-on rule files loaded by Claude Code |
| `scripts/` | Node.js automation scripts (`.mjs` only) — includes `generate-agents-skills.mjs` (writes the portable cross-harness surface), `site-numbers.mjs` (the website census), `validate-plugin.mjs` |
| `scripts/lib/` | Shared library modules (no `.sh` — bash-free since 2026-04-30) — includes `plugin-update-banner.mjs` (installed-vs-published check), `sessions-canonical.mjs`, `session-lock.mjs`, `config/*.mjs` parsers |
| `scripts/lib/validate/` | 36 `check-*.mjs` validator modules wired into `scripts/validate-plugin.mjs` |
| `tests/` | vitest test suite mirroring `scripts/lib/` + `tests/skills/` (661 `*.test.mjs` files) |
| `templates/` | Vendorable scaffolding (`_shared/rules/`, `_shared/loop.md`) copied into consumer repos |
| `rules/` | The DELIVERABLE rule library shipped out via `/bootstrap --sync-rules` — opposite role to `.claude/rules/` |
| `docs/` | PRDs, ADRs, retros, audits, marketplace, CI setup, `agent-authoring.md` |
| `docs/adr/` | 18 architecture decision records |
| `.claude-plugin/` | Claude Code plugin manifest (`plugin.json`, `marketplace.json`) |
| `.codex-plugin/` | Codex CLI plugin manifest |
| `.cursor-plugin/plugin.json` | Portable plugin manifest; kept outside root so Codex resolves its native manifest |
| `AGENTS.md` (root) | Byte-identical GENERATED copy of `CLAUDE.md` for the 7 of 8 harnesses that read `AGENTS.md` |
| `.agents/skills/` | Portable GENERATED mirror of all 44 skills — spec-legal frontmatter + pointer body, never duplicated instructions |
| `skills/*/references/` | Progressive-disclosure detail split out of oversized SKILL.md bodies: `skills/session-start/references`, `skills/wave-executor/references`, `skills/session-end/references`, `skills/architecture/references` |
| `site/` | The public website (`index.html`, `llms.txt`, `llms-full.txt`, `_census.json`) |
| `assets/` | Repo assets (`icon.svg`, `og-card.svg`, `wave-lifecycle.svg` — the README's rendered wave diagram) |

## Inventory (canonical)

- **Skills:** 44 user-facing — measured 2026-09-13 (`ls -d skills/*/ | grep -v _shared | wc -l`). `_shared/` is internal docs, not a skill.
- **Commands:** 26 — measured 2026-09-13 (`ls commands/*.md | wc -l`): `/autopilot`, `/bootstrap`, `/brainstorm`, `/close`, `/debug`, `/discovery`, `/dispatcher`, `/eli5`, `/eval`, `/evolve`, `/go`, `/grill`, `/harness-audit`, `/memory-cleanup`, `/persona-panel`, `/plan`, `/portfolio`, `/reconcile`, `/release`, `/repo-audit`, `/session`, `/spinout`, `/sunset-review`, `/templates-ack`, `/test`, `/ux-grill`
- **Agents:** 14 — measured 2026-09-06 (`ls agents/*.md | wc -l`): `analyst`, `architect-reviewer`, `code-implementer`, `db-specialist`, `dialectic-deriver`, `docs-writer`, `eval-judge`, `qa-strategist`, `security-reviewer`, `session-reviewer`, `skill-applied-judge`, `test-writer`, `ui-developer`, `ux-evaluator`
- **Hook event matchers / handlers:** 18 matcher entries / 26 plugin-wired handler files (27 on-disk) — measured 2026-09-06 (`hooks/hooks.json` walked for distinct `.mjs` command citations; `ls hooks/*.mjs | wc -l`). `hooks/wave-scope-commit-guard.mjs` is on-disk but intentionally NOT a plugin hook — it is the repository's Git pre-commit guard via Husky (`.husky/pre-commit`), because it guards git index/commit state rather than a plugin lifecycle event. Counting basis: "plugin-wired" = distinct `.mjs` filenames referenced inside `hooks/hooks.json`; "Husky-wired" = referenced inside `.husky/pre-commit`; "on-disk" = `ls hooks/*.mjs`.
- **Rules:** 26 always-on files — measured 2026-09-06 (`ls .claude/rules/*.md | wc -l`). This number moves whenever the reconcile engine materialises or consolidates generated rules — re-measure, never quote from memory.
- **Validators:** 36 `scripts/lib/validate/check-*.mjs` modules — measured 2026-09-06 (`ls scripts/lib/validate/check-*.mjs | wc -l`).
- **ADRs:** 18 — measured 2026-09-06 (`ls docs/adr/*.md | wc -l`).
- **Tests:** 661 test files — measured 2026-09-06 (`find tests -name '*.test.mjs' | wc -l`). The runtime test-case total is only knowable from a `npm test` run; the static floor is 13,962 `it()`/`test()` definitions (`rg -c --no-filename -e '^\s*(it|test)(\.\w+)?\(' tests --glob '*.test.mjs'`, summed) and the real number is higher because of parameterised blocks.
- **Destructive-command policy:** 14 rules, 10 blocking and 4 warning — measured 2026-09-06 (`node -e "…require('./.orchestrator/policy/blocked-commands.json')…"`). "14 rules" alone is ambiguous: only 10 of them block.

## Key Skills (frequently referenced)

| Skill | Directory | Role |
|-------|-----------|------|
| session-start | `skills/session-start/` | Full session init, Phases 0–9 (detail under `references/`) |
| session-end | `skills/session-end/` | Metrics write, vault mirror, close (detail under `references/`) |
| session-plan | `skills/session-plan/` | Wave decomposition |
| wave-executor | `skills/wave-executor/` | Parallel agent orchestration (detail under `references/`) |
| evolve | `skills/evolve/` | Learning lifecycle (8 types) |
| reconcile | `skills/reconcile/` | Learnings → PROPOSED `.claude/rules/` entries |
| discovery | `skills/discovery/` | Probes: git, VCS, SSOT, arch, vault |
| architecture | `skills/architecture/` | Module depth + seams; absorbed the former `domain-model` flow (`references/`) |
| mode-selector | `skills/mode-selector/` | Mode recommendation from learnings |
| autopilot | `skills/autopilot/` | Headless driver loop |
| bootstrap | `skills/bootstrap/` | First-run setup, owner persona |
| vault-mirror | `skills/vault-mirror/` | Obsidian vault sync |
| test-runner | `skills/test-runner/` | Agentic E2E test orchestration (Playwright + Peekaboo) |
| debug | `skills/debug/` | 4-phase root-cause investigation |
| remote-offload | `skills/remote-offload/` | Route heavy wave roles to a declared remote host |

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
| PostToolUse | `Edit\|Write\|MultiEdit` | `hooks/post-tooluse-frontend-slop.mjs` + `hooks/post-edit-import-probe.mjs` |
| PostToolUse | `Bash` | `hooks/post-bash-write-verify.mjs` |
| PostToolUse | `*` | `hooks/loop-guard.mjs` |
| Stop | `""` | `hooks/on-stop.mjs` |
| SubagentStop | `""` | `hooks/on-stop.mjs` + `hooks/subagent-telemetry.mjs` + `hooks/post-subagent-discovery-validator.mjs` |
| PostToolUseFailure | `""` | `hooks/post-tool-failure-corrective-context.mjs` |
| PostToolBatch | `""` | `hooks/post-tool-batch-wave-signal.mjs` |
| PostToolBatch | `""` | `hooks/operator-steer.mjs` |
| SubagentStart | `""` | `hooks/subagent-telemetry.mjs` |
| CwdChanged | `""` | `hooks/cwd-change-restore.mjs` |

> Table is exhaustive: one row per matcher entry — **18 matcher entries / 26 plugin-wired handler files** across 10 distinct events — see `hooks/hooks.json` (SSOT). Measured 2026-09-06.
