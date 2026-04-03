# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
