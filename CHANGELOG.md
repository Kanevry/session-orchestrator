# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Shared hardening module** (GL#76) — `scripts/lib/hardening.sh` with pure, independently-testable helpers (`require_jq`, `source_platform`, `find_scope_file`, `get_enforcement_level`, `gate_enabled`, `path_matches_pattern`, `command_matches_blocked`, `emit_deny`, `emit_warn`, `suggest_for_*`). All three enforcement hooks now source this module instead of duplicating logic.
- **test-hardening.sh** — 33 assertions covering path matching (directory prefix, `**`, single-segment glob, exact), command word-boundary matching, scope-file discovery, enforcement-level parsing, gate toggles, and suggestion content.
- **Per-gate enforcement toggles** (GL#77) — new `enforcement-gates` Session Config field. Object with boolean values for `path-guard`, `command-guard`, `post-edit-validate`. Missing entries default to enabled. Wave-scope.json gains optional `gates` field; `gate_enabled()` in hardening.sh drives skip logic.
- **Actionable suggestions in hook denials** (GL#78) — `enforce-scope.sh` and `enforce-commands.sh` now include a context-aware suggestion in their denial reason (e.g., force-push denial points to `--force-with-lease`; scope violation lists the allowed paths and next steps).
- **STATE:/PLAN: structured reasoning** (GL#79) — new `reasoning-output` Session Config field (boolean, default `false`). When enabled, wave-executor appends a STATE/PLAN transparency block to every agent prompt. Opt-in — adds prompt overhead.

### Changed
- `hooks/enforce-scope.sh`, `hooks/enforce-commands.sh`, `hooks/post-edit-validate.sh` refactored to source `scripts/lib/hardening.sh`. Behavior is unchanged in the default configuration; new behavior surfaces only when `enforcement-gates` or `reasoning-output` are set.
- `scripts/validate-wave-scope.sh` now validates the optional `gates` field (must be an object of booleans).
- `scripts/parse-config.sh` adds `enforcement-gates` and `reasoning-output` fields; `json_bool_object()` helper coerces string values to real JSON booleans.
- `docs/session-config-reference.md` documents both new fields in the Session & Enforcement section.
- `.mcp.json` now falls back to `git rev-parse --show-toplevel` when `$CLAUDE_PLUGIN_ROOT` is unset, allowing local development inside this repo to connect the MCP server without reinstalling as a plugin.

### Sanitized
- Public-surface cleanup: `skills/vault-sync/SKILL.md` and `skills/_shared/model-selection.md` no longer reference private project names or absolute user paths.
- `.orchestrator/metrics/*.jsonl` removed from git tracking (per-project observability data belongs locally, not in the public repo).
- `docs/specs/` removed from git tracking (internal design artifacts).
- `.gitignore` updated accordingly.

### Tests
- 328 → 367 passing (33 new in test-hardening.sh, 6 new in test-parse-config.sh).

## [2.0.0-beta.1] - 2026-04-08 — Beta Release

### Added
- **Clank Event Bus integration** (GL#53) — `scripts/lib/events.sh` with `so_emit_event()` function for async event emission to Clank's Event Bus (`events.gotzendorfer.at/api/events`). Bearer-auth via `CLANK_EVENT_SECRET`, graceful degradation when unconfigured.
- **SessionStart event hook** — `hooks/on-session-start.sh` emits `orchestrator.session.started` with platform and project context
- **Stop/SubagentStop event emission** — existing hooks now emit `orchestrator.session.stopped` and `orchestrator.agent.stopped` events
- **Output Styles** (GL#56) — 3 output style definitions (`output-styles/session-report.md`, `wave-summary.md`, `finding-report.md`) for consistent session reporting format
- **test-events.sh** — 12 assertions covering event library loading, graceful degradation, hook integration, and registration

### Changed
- hooks.json + hooks-codex.json: SessionStart now includes async event notification hook
- Plugin version: alpha.15 → beta.1
- Tests: 172+ → 184+ passing (12 new event bus assertions)

### Closed
- GL#53 (HTTP Hooks — reimplemented as Clank Event Bus integration)
- GL#56 (Output Styles)
- GL#47 (Epic: Plugin API Alignment — all sub-issues resolved)

## [2.0.0-alpha.15] - 2026-04-08 — Plugin API Alignment

### Added
- **plugin.json component paths** — `commands`, `agents`, `hooks`, `mcpServers` fields per Plugin API spec
- **validate-plugin.sh** (GL#48) — 18-check validation script: manifest schema, component path resolution, hooks JSON, agent frontmatter, mcpServers validity
- **test-validate-plugin.sh** — 17 assertions covering valid plugin, missing fields, invalid JSON, broken paths, bad frontmatter
- **Stop hook** (GL#52) — `hooks/on-stop.sh` persists session state to metrics on unexpected exit
- **SubagentStop hook** (GL#52) — `hooks/on-subagent-stop.sh` logs agent completion for wave-executor metrics
- **MCP Server skeleton** (GL#54) — `.mcp.json` + `scripts/mcp-server.sh` exposing `session_config` and `session_metrics` tools via JSON-RPC 2.0 stdio

### Changed
- **Issue triage** (GL#60) — verified all 14 epic issues against actual Plugin API docs: 6 closed (not in API), 2 deferred, 4 implemented, 1 epic tracking
- hooks.json + hooks-codex.json now include `Stop` and `SubagentStop` event types
- Tests: 155 → 172+ passing (17 new validate-plugin assertions)

### Closed (not in Plugin API)
- GL#49 (`userConfig`), GL#50 (`CLAUDE_PLUGIN_DATA`), GL#51 (agent extended frontmatter), GL#55 (`bin/` auto-PATH), GL#57 (skill `paths`), GL#58 (LLM hook types)

### Deferred
- GL#53 (HTTP hooks), GL#56 (output styles)

## [2.0.0-alpha.14] - 2026-04-07 — Cross-Platform + Housekeeping

### Added
- **Codex CLI full support** — platform detection (`scripts/lib/platform.sh`), `.orchestrator/metrics/` shared knowledge layer, `.codex-plugin/` with 3 agent TOMLs (explorer, wave-worker, session-reviewer), hooks-codex.json, codex-setup.md
- **Cursor IDE rules-based integration** — 9 `.cursor/rules/*.mdc` files, sequential execution model (no Agent() tool), platform.sh cursor detection, cursor-setup.md, hooks-cursor.json, cursor-install.sh
- **Intelligent agent dispatch** — 3-tier resolution: project agents > plugin agents > general-purpose fallback. 5 domain agents (code-implementer, test-writer, db-specialist, ui-developer, security-reviewer)
- **Worktree tests** (GL#39) — `scripts/test/test-worktree.sh` with 10 assertions covering create/cleanup/cleanup_all
- **Platform slow-path tests** (GL#42) — 8 assertions for marker directory detection without env vars

### Changed
- **DRY hook scripts** (GL#41) — all 3 hooks now source `platform.sh` instead of duplicating `find_project_root()`
- **Removed orphan config fields** (GL#40) — `session-types` and `cli-tools` removed from parser, docs, tests, and 23 files total
- **Codex agent specialization** documented as known limitation (GL#43) — Platform Limitations section in codex-setup.md
- **Test-writer hardening** — 3 anti-greenwashing rules: hardcoded assertions, mandatory error tests, falsification self-check
- **Lifecycle Simulation v3** — 37 gaps found across 3-platform trace, 28 fixed (session-end, wave-executor, session-plan, discovery, evolve, hooks, .cursor/rules)
- All 10 SKILL.md files now include `model-preference-cursor` frontmatter
- `skills/_shared/platform-tools.md` extended with Cursor column
- `skills/_shared/config-reading.md` updated with Cursor fallback paths
- Tests: 130 → 155 passing (10 worktree + 8 platform slow-path + adjustments for removed fields)

### Fixed
- **3 discovery issues created** — GL#44 (post-edit-validate.sh JSON injection), GL#45 (Session Config dogfooding), GL#46 (.claudeignore)

## [2.0.0-alpha.13] - 2026-04-06 — Validate Refactor + Probes Split + PostToolUse Hook

- **refactor:** extract 4 helpers from `validate()` in validate-wave-scope.sh — 109→22 lines (#25)
- **refactor:** split `probes.md` (943 lines) into 6 category files — code, infra, ui, arch, session + intro (#26)
- **feat:** PostToolUse hook for incremental typecheck after Edit/Write — informational, never blocks (#20)
  - `hooks/post-edit-validate.sh` — resolves typecheck command from config, 2s timeout, macOS-compatible
  - hooks.json updated with PostToolUse section
- **test:** 33 new test assertions (wave-scope edge cases + hook test suite)
- **fix:** macOS `date +%s%3N` compatibility in post-edit-validate.sh (BSD date lacks `%N`)

## [2.0.0-alpha.12] - 2026-04-06 — /evolve + Skill Splits

- **feat:** `/evolve` command + skill — extract, review, and list cross-session learnings (#21)
  - `analyze` mode: extract patterns from session history (5 learning types), present via AskUserQuestion, atomic write
  - `review` mode: interactive management (boost/reduce/delete/extend) of existing learnings
  - `list` mode: read-only display grouped by type with confidence and expiry summary
- **refactor:** extract `verification-checklist.md` from session-end SKILL.md Phase 2 (#18)
- **refactor:** extract `wave-template.md` from session-plan SKILL.md Step 4 (#18)
- **feat:** seed initial `learnings.jsonl` with 4 learnings from 8-session history (effective-sizing, scope-guidance)

## [2.0.0-alpha.11] - 2026-04-06 — Deterministic Scripts

- **feat:** `scripts/parse-config.sh` — deterministic Session Config parser with type validation, 36 fields, defaults from reference doc (#19)
- **feat:** `scripts/run-quality-gate.sh` — 4 quality gate variants (baseline, incremental, full-gate, per-file) with structured JSON output (#19)
- **feat:** `scripts/validate-wave-scope.sh` — wave-scope.json validator with security checks (path traversal, absolute paths) (#19)
- **feat:** `scripts/lib/common.sh` — shared library (find_project_root, require_jq, die, warn, resolve_plugin_root)
- **feat:** 94 bash tests across 3 test suites with 8 fixtures
- **refactor:** skills updated to reference scripts (session-start, discovery, plan, wave-executor, session-end, quality-gates)

## [2.0.0-alpha.10] - 2026-04-05

### v2.0.0-alpha.10

**Quality & Architecture**

- fix: remove hardcoded archetype/style/group mappings in plan mode-new — now discovered dynamically from `$BASELINE_PATH` (#11)
- feat: shared Session Config reference at `docs/session-config-reference.md` — single source of truth for all 36 fields (#12)
- refactor: deduplicate Phase 0 config lists across session-start, discovery, and plan skills (#12)
- refactor: extract session-start Phase 7 presentation template to `presentation-format.md` (#18)
- refactor: session-start SKILL.md reduced from 290 to 210 lines (28% reduction) (#18)

## [2.0.0-alpha.9] - 2026-04-05 — Cross-Repo Learnings + Competitive Analysis

- **feat:** cross-repo learnings — anti-pattern detection, skill metadata extraction, confidence-based filtering
- **feat:** skill frontmatter extended with `tags` and `model-preference` fields
- **fix:** discovery probe consistency fixes (false positive reduction, deduplication logic)
- **analysis:** competitive analysis of everything-claude-code, projects-baseline, claude-code-skills repos

## [2.0.0-alpha.8] - 2026-04-04

### Fixed
- **enforce-scope.sh**: default enforcement changed from `warn` (fail-open) to `strict` (fail-closed) when `enforcement` field missing from `wave-scope.json`
- **enforce-commands.sh**: same fail-closed default applied
- **enforce-scope.sh**: incomplete regex metacharacter escaping — `+`, `?`, `|`, `[`, `]`, `(`, `)` now escaped before glob→regex conversion
- **enforce-scope.sh**: symlink bypass — `realpath` canonicalization added for both PROJECT_ROOT and FILE_PATH (directory-level resolution for new files)
- **enforce-commands.sh**: hardcoded fallback safety blocklist (`rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, `git checkout -- .`) enforced when `blockedCommands` absent from `wave-scope.json`
- **Both hooks**: `CLAUDE_PROJECT_DIR` environment variable now validated — must contain `.claude/` directory to be trusted
- **wave-executor**: jq prerequisite check added to Pre-Execution phase (step 4) — warns user if jq missing before wave dispatch

### Changed
- Plugin version alpha.7 → alpha.8
- SECURITY.md expanded with Enforcement Architecture, Prerequisites, Known Limitations, Credential Safety sections
- README.md: jq listed as prerequisite for enforcement hooks
- USER-GUIDE.md: credential safety warning added to Session Config section

## [2.0.0-alpha.7] - 2026-04-04

### Added
- **`/plan` skill** — structured project planning & PRD generation (#27)
- `/plan new` — project kickoff with 3-wave requirement gathering, full PRD, and repo setup
- `/plan feature` — compact feature PRD with 1-2 wave discovery
- `/plan retro` — data-driven retrospective from session metrics
- 3 PRD templates: full (8 sections), feature (5 sections), retro (metrics + actions)
- PRD reviewer prompt with 6-criteria quality review and max 3 iteration protocol
- Product Strategist soul identity (`skills/plan/soul.md`)
- 4 new Session Config fields: `plan-baseline-path`, `plan-default-visibility`, `plan-prd-location`, `plan-retro-location`

### Changed
- Plugin version alpha.6 → alpha.7
- SessionStart hook message updated to include `/plan [new|feature|retro]`
- Component counts updated: 8→9 skills, 4→5 commands

## [2.0.0-alpha.6] - 2026-04-04

### Fixed
- **Worktree enforcement bypass** — `find_project_root()` fallback added to both hook scripts (#21 prep)
- **Quality wave scope conflict** — two-phase scope enforcement: simplification agents get production file scope, then test/review agents get test-only scope (#21 prep)
- **Undefined `<session-start-ref>`** — `SESSION_START_REF` captured at session start, used in 3 locations (#21 prep)
- **PARTIAL/SPIRAL/FAILED detection** — STATUS reporting protocol with coordinator detection rules and definitions table (#21 prep)
- **Discovery embedded mode return contract** — JSON schema for findings + stats between discovery and session-end (#21 prep)
- **Learnings I/O** — in-memory tracking in Phase 3.5a, atomic rewrite in Phase 3.6, explicit conditions (#21 prep)
- 8 medium/low consistency fixes: subject matching, cross-module scope definition, sort order, gate headers, field naming, enforcement docs (M1-M6, L1-L2)

### Changed
- Version bumped alpha.5 → alpha.6 across 5 files
- Validation checklist expanded from 11 to 17 scenarios

## [2.0.0-alpha.5] - 2026-04-03

### Added
- **Confidence-based scoring for discovery probes** (#22) — 0-100 confidence score per finding based on pattern specificity, file context, and historical signal. Auto-defers low-confidence findings below configurable threshold (`discovery-confidence-threshold`, default: 60). Critical findings never auto-deferred.
- **Post-implementation simplification pass** (#23) — Quality wave now dispatches simplification agents before test writers, applying `slop-patterns.md` patterns to clean AI-generated code (unnecessary try-catch, over-documentation, redundant boolean logic, re-implemented stdlib functions).
- **Session-reviewer specialized review sections** (#24) — 3 new review sections: Silent Failure Analysis (catch blocks that swallow errors), Test Depth Check (assertion quality, mock boundaries), Type Design Spot-Check (overly broad types, missing unions). Per-finding confidence scoring (>=80 threshold).
- **CLAUDE.md quality audit probe** (#25) — New `claude-md-audit` probe in session category: validates Session Config paths, checks rules freshness against codebase, detects stale CLAUDE.md, cross-references technology mentions against package.json.
- **Session effectiveness tracking** (#26) — Extended `sessions.jsonl` schema with `discovery_stats`, `review_stats`, and `effectiveness` fields. Session-start surfaces completion rate trends, low-value probe detection, and carryover pattern analysis after 5+ sessions.
- Confidence Scoring Reference section in `probes.md` with per-category guidance
- Discovery Phase 6 (Capture Discovery Stats) for standalone mode

## [2.0.0-alpha.4] - 2026-04-03

### Fixed
- **enforce-scope.sh**: glob matching now supports `**` recursive patterns via regex conversion (was limited to single-level globs)
- **enforce-commands.sh**: word-boundary matching prevents false positives (e.g., `rm -rflag` no longer blocked by `rm -rf` pattern)
- **session_id uniqueness**: format changed from `<branch>-<YYYY-MM-DD>` to `<branch>-<YYYY-MM-DD>-<HHmm>` to prevent same-day collisions
- **Spiral detection scope**: clarified as per-agent (not per-wave) — two agents editing the same file is expected, not a spiral
- **Complexity tier boundaries**: rebalanced to Simple (0-1), Moderate (2-3), Complex (4-6) for better distribution
- **Dynamic scaling threshold**: "fast" defined as under 3 minutes wall-clock (was undefined)
- **Worktree merge strategy**: defined sequential merge protocol with conflict resolution heuristics
- **Directory creation**: explicit `mkdir -p` commands instead of prose instructions for STATE.md and metrics
- **JSONL write safety**: documented POSIX-atomic `>>` append, warned against read-modify-write
- **USER-GUIDE spiral wording**: corrected "per wave" to "per agent" to match authoritative circuit-breaker.md

### Added
- `deviation-pattern` learning type — session-end now reads STATE.md deviations for cross-session pattern extraction
- Discovery role enforcement: `allowedPaths: []` + read-only prompt instruction
- Quality role scope restriction: `allowedPaths` limited to test file patterns (`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`)
- Role combination verification example (Discovery+Impl-Core → Incremental checks)
- 6+ wave splitting criteria (by module/dependency boundary)
- jq prerequisite documentation in USER-GUIDE.md with install commands
- Integration test reference config (`docs/examples/integration-test-config.md`) covering all 30 Session Config fields
- Validation checklist (`docs/validation-checklist.md`) mapping to #21's 11 test plan items

### Changed
- Hook jq-missing warnings now explicitly state that enforcement is fully disabled
- `enforce-scope.sh` matching has 4 branches: directory prefix → recursive glob → simple glob → exact match

## [2.0.0-alpha.3] - 2026-04-03

### Added
- Session metrics tracking — wall-clock time, agent counts, files changed per wave (#8)
- Historical trend display in session-start showing last 5 sessions
- Adaptive wave sizing with complexity scoring (simple/moderate/complex tiers) (#19)
- Dynamic agent scaling between waves based on performance signals
- Cross-session learning system with confidence scoring (#20)
- Project Intelligence sections in session-start and session-plan from accumulated learnings
- Structured quality-gates output format (JSON) for metrics integration

### Changed
- Circuit breaker and worktree isolation extracted to `circuit-breaker.md` sub-reference
- session-plan steps renumbered (new Step 3: Complexity Assessment)
- session-end Final Report expanded with per-wave metrics breakdown and learnings summary
- Quality gates Variants 2 and 3 have structured JSON output specifications

## [2.0.0-alpha.2] - 2026-04-03

### Added
- Hybrid session persistence via STATE.md lifecycle (init/update/clear) + session memory files (#16)
- PreToolUse hook enforcement: enforce-scope.sh (Edit/Write), enforce-commands.sh (Bash) (#17)
- Circuit breaker with maxTurns limit and spiral detection (#18)
- Worktree isolation for parallel agent execution (#18)
- 5 new Session Config fields: persistence, memory-cleanup-threshold, enforcement, isolation, max-turns
- SESSION-START Phase 0.5 (Session Continuity) and Phase 5.5 (Memory Recall)

### Changed
- USER-GUIDE.md: 2 new sections (Session Persistence, Safety Features) + config fields + cheat sheet
- wave-executor: STATE.md initialization, post-wave updates, scope manifest, circuit breaker

## [2.0.0-alpha] - 2026-04-02

### Added
- quality-gates reference skill — canonical commands for typecheck, test, lint with 4 variants (Baseline, Incremental, Full Gate, Per-File)
- 9 new Session Config fields: test-command, typecheck-command, lint-command, ssot-freshness-days, plugin-freshness-days, recent-commits, issue-limit, stale-branch-days, stale-issue-days
- Role-to-wave mapping table — waves dynamically map to 5 roles (Discovery, Impl-Core, Impl-Polish, Quality, Finalization) based on configured wave count (3-6+)
- discovery skill with /discovery command — systematic quality audit with 22 probes across 5 categories (code, infra, ui, arch, session)
- 4 new Session Config fields for discovery: discovery-on-close, discovery-probes, discovery-exclude-paths, discovery-severity-threshold

### Changed
- gitlab-ops is now the single source of truth for all VCS operations — consuming skills reference it instead of duplicating commands (#11)
- Quality checks across all skills now reference quality-gates instead of hardcoding commands (#12)
- Session Config documentation consolidated — USER-GUIDE.md Section 4 is the authoritative field reference (#13)
- All hardcoded thresholds (SSOT freshness, plugin age, stale branches, etc.) are now configurable via Session Config (#14)
- Wave execution model rewritten from hardcoded wave numbers to role-based assignment (#15)
- Pencil design review triggers now reference Impl-Core and Impl-Polish roles instead of Wave 2/3
- Label taxonomy in CONTRIBUTING.md and USER-GUIDE.md now points to gitlab-ops as SSOT

### Removed
- ~80 lines of duplicated VCS detection/command logic across 4 skills
- ~30 lines of duplicated quality check commands across 4 skills
- ~60 lines of duplicated Session Config documentation across 3 files
- All hardcoded "Wave 1/2/3/4/5" references in favor of role names

## [1.0.0] - 2026-04-02

### Added
- 6 skills: session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops
- 3 commands: /session, /go, /close
- 1 agent: session-reviewer (inter-wave quality gate)
- SessionStart hook with startup notification
- Soul personality system (soul.md)
- VCS auto-detection with dual GitLab + GitHub support
- 5-wave execution pattern with configurable agent counts
- Inter-wave Pencil design-code alignment reviews
- Ecosystem health monitoring (service endpoints + cross-repo scanning)
- Session Config system with 13 configurable fields
- User Guide, CONTRIBUTING guide, and example Session Configs
