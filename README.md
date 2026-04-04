# Session Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.8-orange.svg)](CHANGELOG.md)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-blueviolet.svg)](https://docs.anthropic.com/en/docs/claude-code)

Claude Code plugin for session-level orchestration — project planning, wave execution, VCS integration, quality gates.

> [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is Anthropic's agentic coding CLI. This plugin adds structured session management on top — turning ad-hoc agent interactions into repeatable, quality-gated engineering workflows. No runtime code. Pure Markdown.

## Install

```bash
# Add as a Claude Code plugin
claude plugin add github:Kanevry/session-orchestrator
```

## Prerequisites

- **Claude Code** — [Anthropic's agentic coding CLI](https://docs.anthropic.com/en/docs/claude-code)
- **jq** (recommended) — required for scope and command enforcement hooks. Install via `brew install jq` (macOS) or `apt install jq` (Linux). Without jq, enforcement hooks allow all operations.

## Why Session Orchestrator

Session Orchestrator provides a complete development session lifecycle — from project state analysis through structured wave execution to verified close-out. While other tools optimize for speed or cost, Session Orchestrator optimizes for session quality and engineering discipline.

### Soul Personality System

A `soul.md` file defines the orchestrator's identity as a seasoned engineering lead — with communication principles ("be direct"), a decision-making hierarchy (safety > productivity > quality > ecosystem health > speed), and values (pragmatism, evidence, ownership). This shapes every interaction, not just tone.

### 5-Wave Execution Pattern

Work flows through 5 typed waves: Discovery (read-only validation), Core Implementation, Polish & Integration, Quality & Testing, Finalization. The Quality wave includes a simplification pass that cleans AI-generated code patterns (unnecessary try-catch, over-documentation, redundant logic) before tests are written. Each wave has a defined purpose and agent count that scales by session type. This isn't just batching — it's structured engineering workflow.

### Inter-Wave Quality Gates

A dedicated session-reviewer agent runs 8 review sections between waves: implementation correctness, test coverage, TypeScript health, OWASP security basics, issue tracking, silent failure analysis (catch blocks that swallow errors), test depth (assertion quality, mock boundaries), and type design (overly broad types, missing unions). Every finding is confidence-scored (0-100) — only high-confidence issues (>=80) make it into the report. Verification escalates progressively: changed-file tests after Impl-Core, full integration tests after Impl-Polish, complete quality suite after Quality.

### Design-Code Alignment

When configured with a Pencil design file, the wave executor screenshots design frames after Impl-Core and Impl-Polish waves and compares them with the actual implementation — checking layout structure, component hierarchy, and visual elements. Results are classified as ALIGNED / MINOR DRIFT / MAJOR MISMATCH with automatic plan adaptation.

### VCS Dual Support

Auto-detects GitLab or GitHub from your git remote. Full lifecycle support for both: issue management, MR/PR tracking, pipeline/workflow status, label taxonomy, and milestone queries. No lock-in.

### Ecosystem Health Monitoring

Checks configured service endpoints and scans cross-repo critical issues at session start. Know your ecosystem state before you start working.

### Session Persistence & Safety

Sessions persist across interruptions via `STATE.md` — crash recovery, resume from pause point, and clean handover between sessions. PreToolUse hooks enforce agent scope (file paths) and block dangerous commands. A circuit breaker detects execution spirals (thrashing, repeated errors, self-reverts) and recovers automatically.

### Metrics & Cross-Session Learning

Every session writes quantitative metrics (duration, agents, files changed per wave) plus effectiveness stats (completion rate, discovery probe value, carryover patterns) and extracts qualitative learnings (fragile files, effective sizing, recurring issues). After 5+ sessions, the system surfaces trends: low-value probes to disable, scope adjustments for high carryover, and completion rate analysis. The system gets smarter over time.

### Adaptive Wave Sizing

Agent counts scale with session complexity. A scoring formula (files × modules × issues) determines simple/moderate/complex tier, which maps to concrete agent counts per role and session type. Dynamic scaling adjusts between waves based on actual agent performance.

### Verified Session Close-Out

`/close` verifies every planned item with evidence, runs a full quality gate, creates carryover issues for unfinished work, commits with individually staged files, and optionally mirrors to GitHub. `/discovery` runs 23 modular probes across code, infra, UI, architecture, and session categories — each finding confidence-scored to reduce triage noise. Nothing falls through the cracks.

### Comparison

| Feature | Session Orchestrator | Manual CLAUDE.md | Other Orchestrators |
|---------|---------------------|------------------|-------------------|
| Session lifecycle (start → plan → execute → close) | Full, automated | Manual | Partial |
| Typed waves with quality gates | 5 roles, progressive verification | None | Batch execution |
| Session persistence & crash recovery | STATE.md + memory files | None | Partial |
| Scope & command enforcement hooks | PreToolUse with strict/warn/off | None | None |
| Circuit breaker & spiral detection | Per-agent, with recovery | None | Partial |
| Cross-session learning | Confidence-scored learnings | None | None |
| Adaptive wave sizing | Complexity-scored, dynamic | Fixed | Fixed |
| VCS integration (GitLab + GitHub) | Dual, auto-detected | Manual CLI | Usually GitHub only |
| Design-code alignment | Pencil integration | None | None |
| Session close with carryover | Verified, with issue creation | Manual | Partial |

Session Orchestrator does not optimize for token cost or model routing. It optimizes for engineering quality — every wave verified, every issue tracked, every session closed cleanly.

## Usage

| Command | Purpose |
|---------|---------|
| `/session [type]` | Start session (housekeeping, feature, deep) |
| `/go` | Approve plan, begin wave execution |
| `/close` | End session with verification |
| `/discovery [scope]` | Systematic quality discovery and issue detection |
| `/plan [mode]` | Plan a project, feature, or retrospective |

## Workflow

Session Orchestrator has two complementary workflows: **planning** (what to build) and **execution** (how to build it).

```
/plan [mode]  →  /session [type]  →  /go  →  /close  →  /plan retro
    WHAT              HOW            DO      VERIFY       REFLECT
```

### Planning (`/plan`)

Run `/plan` **before** starting a session to define requirements and create issues:

- **`/plan new`** — Full project kickoff: 3-wave requirement gathering, 8-section PRD, repo scaffolding, Epic + prioritized issues. Use when starting from scratch.
- **`/plan feature`** — Compact feature PRD: 1-2 wave discovery, acceptance criteria, feature issues. Use when adding a feature to an existing project.
- **`/plan retro`** — Data-driven retrospective: analyzes session metrics, surfaces trends, creates improvement issues. Use after completing significant work.

`/plan` is optional — you can create issues manually and jump straight to `/session`.

### Execution (`/session` → `/go` → `/close`)

Run `/session` to **implement** existing issues across structured waves:

```
/session feature     # Analyze project, pick issues, agree on scope
/go                  # Execute across 5 parallel waves
/close               # Verify, commit, push, create carryover issues
```

### Example: Feature from idea to delivery

```bash
/plan feature        # 10 min: define requirements → PRD + 3 issues
/session feature     # Pick those 3 issues → wave plan
/go                  # Execute: Discovery → Impl-Core → Polish → Quality → Finalize
/close               # Verify + commit + push
```

## Session Types

- **housekeeping** — Git cleanup, SSOT refresh, CI checks, branch merges (1-2 agents, serial)
- **feature** — Frontend/backend feature work (4-6 agents per wave x 5 waves)
- **deep** — Complex backend, security, DB, refactoring (up to 10-18 agents per wave x 5 waves)

## Repo Session Config

Add to each repo's `CLAUDE.md`:

```markdown
## Session Config

- **session-types:** [housekeeping, feature, deep]
- **agents-per-wave:** 6
- **waves:** 5
- **pencil:** path/to/design.pen
- **cross-repos:** [related-repo-1, related-repo-2]
- **ssot-files:** [.claude/STATUS.md]
- **cli-tools:** [glab, vercel, supabase]
- **mirror:** github
- **ecosystem-health:** true
- **vcs:** github|gitlab (default: auto-detect)
- **gitlab-host:** custom-gitlab.example.com
- **health-endpoints:** [{name: "API", url: "https://api.example.com/health"}]
- **special:** "any repo-specific instructions"
- **persistence:** true
- **enforcement:** warn (strict|warn|off)
- **isolation:** worktree (worktree|none|auto)
- **max-turns:** auto (housekeeping=8, feature=15, deep=25)
- **discovery-on-close:** true
```

For the complete field reference with types, defaults, and descriptions, see the [User Guide — Session Config Reference](docs/USER-GUIDE.md#4-session-config-reference).

## VCS Auto-Detection

Session Orchestrator auto-detects your VCS from the git remote URL:
- Remote contains `github.com` → uses `gh` CLI
- All other remotes → uses `glab` CLI

Override with `vcs: github` or `vcs: gitlab` in Session Config.

## Architecture

Session Orchestrator handles the **session layer** (orchestration, VCS integration, waves, close-out).
Superpowers handles the **task layer** (TDD, debugging, brainstorming per feature).

```
/plan → PRD + Issues    (optional: define WHAT to build)
  ↓
/session → Research → Q&A → Plan    (define HOW to build it)
  ↓
/go → 5 Waves → Inter-Wave Reviews    (execute)
  ↓
/close → Verify → Commit → Mirror    (verify + ship)
```

## Components

- **9 Skills**: session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops, quality-gates, discovery, plan
- **5 Commands**: /session, /go, /close, /discovery, /plan
- **1 Agent**: session-reviewer (inter-wave quality gate)
- **Hooks**: SessionStart notification + PreToolUse enforcement (scope + commands)

## Documentation

- [User Guide](docs/USER-GUIDE.md) — installation, config reference, workflow walkthrough, FAQ
- [CONTRIBUTING.md](CONTRIBUTING.md) — plugin architecture, skill anatomy, development setup
- [CHANGELOG.md](CHANGELOG.md) — version history
- [Example Configs](docs/examples/) — Session Config examples for Next.js, Express, Swift

## Links

- [Homepage](https://gotzendorfer.at/en/session-orchestrator)
- [Privacy Policy](https://gotzendorfer.at/en/session-orchestrator/privacy)

## License

[MIT](LICENSE)
