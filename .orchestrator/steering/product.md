# Steering: Product Context

> Stable repo-level facts for session context injection. Not session narrative.
> Maintained by: coordinator or `/plan new` scaffolding.
> Do NOT commit secrets. Do NOT include session-specific state here.

## Mission

Session Orchestrator is a project-instruction file plugin for Claude Code, Codex CLI, Cursor IDE, and Pi.
It is **loop engineering** for software work: the operator designs the loop — research → plan → execute in
waves → close — and the plugin runs it with the durable surface that keeps a long agent run honest:
structured session lifecycle, parallel wave execution, inter-wave quality gates, VCS integration,
cross-session memory + vault mirroring, and autopilot walk-away mode.

As native agent harnesses absorb raw parallelism (Dynamic Workflows, nested subagents) and research
fan-out (`/deep-research`), the plugin's durable moat is the surface they do not yet cover: mechanical
guards (destructive-command, scope, config-protection, owner-privacy), session/learning telemetry,
skill self-evolution, host-local public-repo-safe shared memory, parallel-*operator*-session safety, and
multi-harness portability across Claude Code / Codex CLI / Cursor IDE / Pi.

The plugin ships as a Claude Code plugin (`.claude-plugin/`), a Codex plugin (`.codex-plugin/`), and a
Pi package (`package.json` `pi` manifest), activated via `CLAUDE.md` (Claude Code / Cursor) or
`AGENTS.md` (Codex CLI / Pi).

Since the v4.0.0 preparation it also ships a **portable cross-harness surface**, all three artefacts
GENERATED and drift-checked by `scripts/generate-agents-skills.mjs` (`--check` inside
`scripts/validate-plugin.mjs`), never hand-edited: a root `AGENTS.md` that is a byte-identical copy of
`CLAUDE.md`; a root `plugin.json` following the agent-plugins.org 1.0.0 schema; and `.agents/skills/`,
a mirror of every skill carrying only spec-legal frontmatter plus a pointer body. Oversized skill
bodies are split into `skills/<name>/references/` for progressive disclosure.

## Target Users

- **Primary:** Austrian indie dev (solo operator) running multi-repo Claude Code sessions.
- **Secondary:** Other developers adopting the plugin from GitHub (Kanevry/session-orchestrator).
- **Ecosystem:** the operator's GitLab instance; plugin propagates context cross-repo.

## In-Scope Features

- Session lifecycle commands: `/session`, `/close`, `/go`, `/plan`, `/evolve`, `/discovery`
- Wave executor: parallel agent orchestration with inter-wave quality gates
- `ultradeep` session profile: a profile OVER `session-type: deep` (not a fourth enum value) running
  seven waves — Research + Code-Discovery, a blocking coordinator Synthesis-Gate, Impl-Core,
  Impl-Polish, a read-only Review-Panel, Quality, Release. Downstream tooling still sees `deep`.
- Plugin-update banner: compares the version of the code that is RUNNING against the published npm
  version at session-start; fails silent, never optimistic
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

## Surface Size (re-measure, never quote)

The canonical counts live in `structure.md` § Inventory next to the command that produced each one.
Measured 2026-09-06 at `e4674109`: 43 skills · 25 commands · 14 agents · 27 hook files (26
plugin-wired, 10 event types) · 26 always-on rule files · 18 ADRs. The v4.0.0 release REMOVES public
surfaces, so any count quoted from the 3.24.0 line (49 / 28 / 16 / 61) is stale by construction.
