# Steering: Product Context

> Stable repo-level facts for session context injection. Not session narrative.
> Maintained by: coordinator or `/plan new` scaffolding.
> Do NOT commit secrets. Do NOT include session-specific state here.

## Mission

Session Orchestrator is a project-instruction file plugin for Claude Code, Codex CLI, and Cursor IDE.
It provides structured session lifecycle management: planning, wave execution, VCS integration,
quality gates, vault mirroring, and autopilot walk-away mode.

The plugin ships as a Claude Code plugin (`.claude-plugin/`) and a Codex plugin (`.codex-plugin/`),
activated via `CLAUDE.md` (Claude Code / Cursor) or `AGENTS.md` (Codex CLI).

## Target Users

- **Primary:** Austrian indie dev (solo operator) running multi-repo Claude Code sessions.
- **Secondary:** Other developers adopting the plugin from GitHub (Kanevry/session-orchestrator).
- **Ecosystem:** 16+ repos in the operator's GitLab instance; plugin propagates context cross-repo.

## In-Scope Features

- Session lifecycle commands: `/session`, `/close`, `/go`, `/plan`, `/evolve`, `/discovery`
- Wave executor: parallel agent orchestration with inter-wave quality gates
- Mode selector: `housekeeping` / `feature` / `deep` mode recommendation from learnings
- Autopilot: headless walk-away driver (`/autopilot --headless`) with kill-switches
- Vault integration: mirroring sessions/learnings to Obsidian vault with auto-commit
- Bootstrap: first-run setup, owner persona interview, lock management
- Discovery probes: git, VCS, SSOT, architecture, vault-staleness checks
- Evolve skill: learning lifecycle (append, boost, prune, promote to CLAUDE.md)
- Destructive-command guard: pre-bash hook with policy-driven block list
- Owner Persona Layer: per-host `~/.config/session-orchestrator/owner.yaml`

## Out of Scope

- Multi-user / team shared sessions (single-operator design)
- Hosting or SaaS delivery — plugin is installed locally, not deployed
- IDE extensions beyond Cursor IDE YAML config
- Non-Claude AI runtimes (no OpenAI / Gemini support planned)
- Paid tiers, licensing enforcement, or usage metering
