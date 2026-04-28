# Session Orchestrator Plugin

Claude Code plugin for session-level orchestration. This is a **plugin repo** — not an application.

> **Für Installation, CLI-Nutzung und Kommando-Referenz:** Siehe [`README.md`](./README.md).

## Structure

- `skills/` — 22 skills (bootstrap, session-start, session-plan, wave-executor, session-end, claude-md-drift-check, ecosystem-health, gitlab-ops, quality-gates, discovery, plan, evolve, vault-sync, vault-mirror, daily, docs-orchestrator, skill-creator, mcp-builder, hook-development, **architecture**, **domain-model**, **ubiquitous-language**)
- `commands/` — 8 commands (/session, /go, /close, /discovery, /plan, /evolve, /bootstrap, /harness-audit)
- `agents/` — 7 agents (code-implementer, test-writer, ui-developer, db-specialist, security-reviewer, session-reviewer, docs-writer)
- `hooks/` — 6 event matchers covering 7 hook handlers: SessionStart (banner + init), PreToolUse/Edit|Write (scope enforcement), PreToolUse/Bash (destructive-command guard + enforce-commands), PostToolUse (edit validation), Stop (session events), SubagentStop (agent events)
- `.orchestrator/policy/` — runtime policy files (e.g. `blocked-commands.json`, 13 rules for destructive-command guard)
- `.claude/rules/` — always-on contributor rules (e.g. `parallel-sessions.md`)

## Development

Edit skills directly. Test by running `/session feature` in any project repo.

Skills are loaded by Claude Code from the plugin directory — no build step needed.

## Destructive-Command Guard

`hooks/pre-bash-destructive-guard.mjs` blocks destructive shell commands in the main session (alongside subagent waves). Policy lives in `.orchestrator/policy/blocked-commands.json` (13 rules). Bypass per-session via Session Config:

```yaml
allow-destructive-ops: true
```

Rule source of truth: `.claude/rules/parallel-sessions.md` (PSA-003). See issue #155.

## Rules

- `.claude/rules/parallel-sessions.md` — PSA-001/002/003/004 parallel-session discipline. Vendored to all consumer repos via bootstrap (issue #155).

## Key Conventions

- Skills use Markdown with YAML frontmatter
- Commands use `$ARGUMENTS` for user input
- Agent definitions need `<example>` blocks in description
- Hooks use the Claude Code hooks.json format

## Agent Authoring Rules

Agent files live in `agents/` as Markdown with YAML frontmatter. Required fields:

```yaml
---
name: kebab-case-name          # 3-50 chars, lowercase + hyphens only
description: Use this agent when [conditions]. <example>Context: ... user: "..." assistant: "..." <commentary>Why this agent is appropriate</commentary></example>
model: inherit                 # inherit | sonnet | opus | haiku
color: blue                    # blue | cyan | green | yellow | magenta | red
tools: Read, Grep, Glob, Bash  # COMMA-SEPARATED STRING, not JSON array!
---
```

**Critical pitfalls** (cause "agents: Invalid input" validation failure):
- `tools` MUST be a comma-separated string (`Read, Edit, Write`), NOT a JSON array (`["Read", "Edit"]`)
- `description` MUST be a single-line inline string, NOT a YAML block scalar (`>` or `|`). Put `<example>` blocks inline.
- All 4 fields (name, description, model, color) are required. `tools` is optional.

Reference: https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/agent-development/SKILL.md

## Current State

- **Plugin version:** v3.2.0 (shipped 2026-04-27 to GitHub — consolidated stable supersedes v3.0.0-rc.1; bundles Windows native + env-aware sessions + Mode-Selector + Autopilot). Public release at https://github.com/Kanevry/session-orchestrator/releases/tag/v3.2.0.
- **Active epic:** #271 v3.2 Autopilot — Phase A + B shipped, Phase C-1 + C-1.b + C-1.c + C-2 + C-5 complete. **Phase C-5 #302 closed**: `scripts/autopilot.mjs` (NEW, 406L) — headless walk-away CLI driver. `--headless` required flag; `--verbose` pipes child stdio; `--dry-run` round-trips without spawning. Wires four DI seams to live impls: `modeSelector` → `selectMode(buildLiveSignals())` (learnings surfaced once pre-loop), `sessionRunner` → `child_process.spawn('claude', ['-p', '/session <mode>'])` with `AUTOPILOT_RUN_ID` env propagation + tail-1 sessions.jsonl read on exit, `resourceEvaluator`/`peerCounter` → `Promise.all(probe(), detectPeers())` cached snapshot. `tests/fixtures/claude` stub binary (60L) + `tests/scripts/autopilot.test.mjs` (5 integration tests via PATH-override) cover dry-run, missing-flag, happy-path 2-iteration `autopilot_run_id` correlation, failed-wave kill-switch, sessionRunner-throw kill-switch. `commands/autopilot.md` documents `--headless` + Headless Mode section. **v3.2 Autopilot epic effectively closed** — only #297 calibration (needs 10+ runs) + #298 evolve type 8 (needs runtime data) remain, both blocked on autopilot RUNS not code. Live walk-away `/autopilot --headless` now unblocked.
- **Stack:** Node 20+, vitest 4.1.5, ESLint 9. Run `npm ci` after cloning. Test: `npm test`. Lint: `npm run lint`.
- **Tests:** 2160 passed / 11 skipped (after 2026-04-28 deep session +269). Coverage above thresholds 70 / 65 / 70 / 60.
- **Backlog:** ~30 open issues (after closing 25 in 2026-04-28 deep session). Remaining cluster: epics (#309, #229, #271, #181, #161, #124), baseline-MR-blocked (#314, #315), autopilot-RUNS-blocked (#297, #298), v3 release tracking (#152, #153, #154, #213), plus a thin tail of priority:low chores.
- **GH#31 vault-mirror auto-commit (2026-04-27):** `scripts/vault-mirror.mjs` (+134L) gains an opt-in auto-commit phase triggered by `--session-id <id>`. After writing artifacts, stages `40-learnings/` + `50-sessions/`, runs per-file `_generator: session-orchestrator-vault-mirror@1` frontmatter check, commits as `chore(vault): mirror <id> — N learnings + M sessions` when staged set is all-mirror, unstages + warns + emits `auto-commit-skipped/non-mirror-staged-changes` action on mismatch, idempotent no-op on empty staged set. Eliminates 1+ day Vault-mirror-backlog pattern (76×40-learnings + 28×50-sessions @ 2026-04-27 vault discovery). 8 regression tests (`tests/unit/vault-mirror.test.mjs` describe-block "auto-commit (#31)"): happy/mismatch/idempotent/dry-run/no-commit/missing-dirs/backlog-catchup/non-git-vault.
- **GH#31 phased-rollout completion + #307 close (2026-04-27 PM):** `skills/session-end/session-metrics-write.md` Phase 3.7 step 5 (+1L) + `skills/evolve/SKILL.md` Step 9c (+3L: `EVOLVE_SESSION_ID="evolve-$(date -u +%Y-%m-%d-%H%M)"` derivation) now pass `--session-id` to vault-mirror, activating the auto-commit phase end-to-end. evolve commits land as `chore(vault): mirror evolve-<date> — N learnings + 0 sessions`. **#307 closed:** evolve Step 4 source_session bullet rewritten to require non-empty kebab-slug string with explicit `String(<object>)` warning + optional jq pre-write validation. NEW `tests/skills/vault-mirror-session-id-wiring.test.mjs` (45L, 3 tests) locks both wirings + the prompt contract. 4 waves coord-direct, ~15 min, 1868→1871 tests (+3).
- **2026-04-28 deep session — 25-issue agent-driven throughput:** 5 waves × 6 parallel agents under coordinator-direct orchestration in `main`, isolation:none enforcement:strict cap=6. Closed in single atomic commit `503e15a` (86 files / +9161 / -2921): #303 #304 (learnings/sessions JSONL writer Zod validation + migrate-* CLIs), #290 + #203 (bootstrap.lock plugin_version + MS_PER_DAY const), #289 (idempotent ecosystem-wizard), #178 (zombie-threshold-min wired end-to-end), #211 (SO_HOOK_PROFILE/SO_DISABLED_HOOKS profile gate), #283 #284 #285 (vault-mirror/config/categories splits — 679L→152L, 1075L→294L, 956L→17L barrel + 7 modules), #227 (pass/fail options-object with shim), #208 (ecosystem-wizard + worktree-freshness complexity), #228 (webhook-url.mjs centralize, personal-domain default removed), #308 (close auto-strip status:* labels), #269 (claude-md-drift command-count probe), #212 (CLAUDE_PLUGIN_ROOT 4-level fallback), #214 (express-path Phase 8.5 codified), #247 (vault-backfill YAML injection CWE-1336 yamlScalar fix), #156 (PSA-001 'aware' vs PSA-002 'pause' decision-tree), #266 (policy-cache effectiveness validation: KEEP, 100% hit-rate JSONL-on-disk), #264 (discovery-on-close session-type-aware default), #279 (schema-drift CI 403 → SCHEMA_DRIFT_TOKEN deploy-token + docs/ci-setup.md), #113 #112 (daily + vault-sync validator tests), #222 (harness-audit integration JSON truncation: maxBuffer=16MB + fixture pollution cleanup). Tests 1891 → 2160 (+269). Inter-wave Quality-Lite caught 3 minor lint regressions, fixed inline. GitLab origin push OK; GitHub mirror blocked by secret scanner false positive on `${SCHEMA_DRIFT_TOKEN}` placeholder URL pattern (manual unblock or amend of `.gitlab-ci.yml` auth pattern needed).
- **v3.2.0 GitHub release (2026-04-27 evening):** Consolidated stable cut covering 135 commits since v2.0.0. `package.json` 3.0.0-dev → 3.2.0, README badge sync, hooks/{hooks,hooks-codex}.json banner version sync (caught by `tests/hooks/banner-version-sync.test.mjs` on first quality run), `CHANGELOG.md` `[3.0.0] - Unreleased` + `[Unreleased] (dev trail)` blocks consolidated into a single `[3.2.0] - 2026-04-27` block (Added/Changed/Removed/Security/Quality/Migration sections covering v3.0+v3.1+v3.2 surfaces); old dev trail demoted to `## Internal Development Trail (pre-v3.2.0)` appendix. Public-voice `RELEASE_NOTES_v3.2.0.md` (4.3 KB) drafted (zero `gitlab.gotzendorfer.at`/`GH#`/`infrastructure/` refs), consumed by `gh release create v3.2.0 --latest --notes-file ...` then deleted. Tag pushed to both `github` (Kanevry/session-orchestrator) and `origin` (gitlab) — v3.0.0-rc.1 auto-demoted from Latest → Pre-release via `--latest` flag. 4 waves coord-direct, ~25 min, 1871 tests still green. Commit `e9a38bf chore(release): v3.2.0 — consolidated stable`.

For full release history, architectural decisions, and meta-audit narratives see [[01-projects/session-orchestrator/decisions]] in the Meta-Vault. The PRDs for v3.2 Autopilot live at [[01-projects/session-orchestrator/prd/2026-04-24-state-md-recommendations-contract|Phase A]] / [[01-projects/session-orchestrator/prd/2026-04-25-mode-selector|Phase B]] / [[01-projects/session-orchestrator/prd/2026-04-25-autopilot-loop|Phase C]].

## v2.0 Features

- Session persistence via STATE.md + session memory files
- Scope & command enforcement hooks (PreToolUse)
- Circuit breaker: maxTurns limit + spiral detection
- Worktree isolation for parallel agent execution
- 5 new Session Config fields (persistence, enforcement, circuit breaker, worktrees, ecosystem-health)
- Session metrics tracking with historical trends (sessions.jsonl)
- Coordinator snapshots: pre-dispatch `git stash create` refs under `refs/so-snapshots/` for crash recovery (#196)
- CWD-drift guard: `restoreCoordinatorCwd` after every worktree-isolated Agent dispatch (#219)
- Harness audit scorecard: deterministic 7-category rubric (RUBRIC_VERSION pinned), JSON to stdout + JSONL trend in `.orchestrator/metrics/audit.jsonl`, `/discovery audit` probe, `/harness-audit` command (#210)
- Docs-orchestrator skill + docs-writer agent: audience-split (User/Dev/Vault) doc generation within sessions. Opt-in via `docs-orchestrator.enabled`. Source-cited only (diff/git-log/session-memory/affected-files); sourceless sections get `<!-- REVIEW: source needed -->`. Canonical four source types with hard abort when ALL absent. Three hook points: session-start Phase 2.5 (audience detection + AskUserQuestion, #233), session-plan Step 1.5/1.8 (Docs role classification + docs-writer auto-match + machine-readable `### Docs Tasks` SSOT emission, #234), session-end Phase 3.2 (per-task ok/partial/gap verification, mode warn/strict/off, #235). Config schema fields documented at `docs/session-config-reference.md § Docs Orchestrator` (#236). Umbrella #229 + foundation #230.
- Isolation:none default for new-directory waves (#243): `wave-executor/wave-loop.md` Pre-Dispatch New-Directory Detection inspects each agent's file scope — if ANY agent's target parent directory doesn't exist AND `configIsolation: 'auto'`, forces `isolation: 'none'` (NOT worktree). Avoids the Claude Code Agent-tool merge-back regression where new-dir writes silently fail to sync back. Enforcement auto-promotes `warn` → `strict` to keep the scope hook hard. Explicit `isolation: 'worktree'` overrides are honored with a `⚠` warning. 3rd-consecutive-session learning (conf 0.90).
- Vault-staleness discovery probes: `/discovery vault` activates two `.mjs` probes — `vault-staleness` flags 01-projects with `lastSync` age > 24h; `vault-narrative-staleness` flags `context.md`/`decisions.md`/`people.md` by tier thresholds (top=30d, active=60d, archived=180d). JSONL under `.orchestrator/metrics/vault-*.jsonl` (#232)
- Vault-backfill CLI (#241): `scripts/vault-backfill.mjs` scans configured GitLab groups (`vault-integration.gitlab-groups`), dry-run by default, `--apply` generates canonical `.vault.yaml` from projects-baseline template per repo, `--yes <manifest>` skips confirmation. Surfaced as `/plan retro` sub-mode via `skills/plan/mode-retro.md` Phase 1.6 (vault-backfill path). Umbrella #229.
- Session-end Phase 2.3 vault staleness check (#242): opt-in via `vault-staleness.enabled: true`; runs both `vault-staleness` + `vault-narrative-staleness` probes via Node import at close time. `mode: warn` surfaces findings in the Phase 6 Final Report Docs Health line; `mode: strict` blocks session-end with AskUserQuestion override. Umbrella #229.
- Architecture-DDD-Trio (Epic #309, derived from `mattpocock/skills@90ea8ee`, MIT): three coordinated skills + a discovery probe for AI-navigable codebases. (a) `architecture` surfaces *deepening opportunities* (Ousterhout — shallow modules, hypothetical seams, pass-through adapters) using a precise vocabulary from `LANGUAGE.md` (Module / Interface / Implementation / Depth / Seam / Adapter / Leverage / Locality). (b) `domain-model` runs grilling sessions that stress-test plans against the existing domain model, sharpens fuzzy terminology inline, and offers ADRs sparingly under a 3-criteria gate (`disable-model-invocation: true` — explicit-invocation only). (c) `ubiquitous-language` extracts a DDD glossary from the current conversation into `UBIQUITOUS_LANGUAGE.md`, flagging ambiguities and synonyms (`disable-model-invocation: true`). (d) `skills/discovery/probes-arch.md` gains an `architectural-friction` probe with concrete grep regex for shallow-module / pass-through-adapter / one-adapter-seam, whose `recommended_fix` routes to the `architecture` skill. Vendor inventory and full upstream MIT notice live in repo-root `NOTICE`. PRD: `docs/prd/2026-04-27-architecture-ddd-trio.md`.
- Adaptive wave sizing based on complexity scoring
- Cross-session learning system with confidence-based intelligence
- Intelligent agent dispatch: project agents > plugin agents > general-purpose
- Agent-mapping Session Config for explicit role-to-agent binding
- Model selection matrix (haiku/sonnet/opus per task type)

## Session Config

persistence: true
enforcement: warn
recent-commits: 20
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
stale-branch-days: 7
plugin-freshness-days: 30
plan-baseline-path: ~/Projects/projects-baseline
plan-prd-location: docs/prd
plan-retro-location: docs/retro
plan-default-visibility: internal
vcs: gitlab
docs-orchestrator:
  enabled: false           # opt-in; when true, session-start Phase 2.5 runs + docs-writer agent available
  audiences: [user, dev, vault]
  mode: warn               # warn | strict | off
vault-staleness:
  enabled: false           # opt-in vault-drift probes (runs in /discovery vault)
  thresholds:
    top: 30                # days — tier=top narrative staleness threshold
    active: 60             # days — tier=active
    archived: 180          # days — tier=archived
  mode: warn               # warn | strict | off
