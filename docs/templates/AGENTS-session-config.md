# Session Orchestrator — AGENTS.md Template

Add this section to your project's `AGENTS.md` file for Codex CLI session orchestration.
The format is identical to the `## Session Config` section in `CLAUDE.md` for Claude Code.

---

## Session Config

session-types: feature, deep, housekeeping
agents-per-wave: 6
waves: 5
recent-commits: 20
persistence: true
enforcement: warn
isolation: auto
max-turns: auto
learning-expiry-days: 30

### VCS
vcs: github
mirror: none

### Quality
test-command: pnpm test --run
typecheck-command: tsgo --noEmit
lint-command: pnpm lint

### Discovery
discovery-on-close: false
discovery-probes: [all]
discovery-severity-threshold: low
discovery-confidence-threshold: 60

---

## Available Commands

These commands are available when the Session Orchestrator plugin is installed:

- `/session [housekeeping|feature|deep]` — Start a development session with project analysis
- `/go` — Execute the agreed session plan in waves with parallel agents
- `/close` — End session with verification, quality gates, and commits
- `/plan [new|feature|retro]` — Plan a project, feature, or retrospective
- `/discovery [scope]` — Run quality probes to detect issues
- `/evolve [analyze|review|list]` — Extract and manage cross-session learnings

## Platform Notes

- Session state is stored in `.codex/` (transient) and `.orchestrator/metrics/` (shared knowledge)
- Agent roles: explorer (read-only), wave-worker (implementation), session-reviewer (quality gate)
- Hooks require `features.hooks = true` in `.codex/config.toml`
