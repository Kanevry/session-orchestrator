# Session Orchestrator

Claude Code plugin for session-level orchestration — wave planning, VCS integration, quality gates.

## Install

```bash
claude plugin install <path-to-session-orchestrator>
```

## Why Session Orchestrator

Session Orchestrator provides a complete development session lifecycle — from project state analysis through structured wave execution to verified close-out. While other tools optimize for speed or cost, Session Orchestrator optimizes for session quality and engineering discipline.

### Soul Personality System

A `soul.md` file defines the orchestrator's identity as a seasoned engineering lead — with communication principles ("be direct"), a decision-making hierarchy (safety > productivity > quality > ecosystem health > speed), and values (pragmatism, evidence, ownership). This shapes every interaction, not just tone.

### 5-Wave Execution Pattern

Work flows through 5 typed waves: Discovery (read-only validation), Core Implementation, Polish & Integration, Quality & Testing, Finalization. Each wave has a defined purpose and agent count that scales by session type. This isn't just batching — it's structured engineering workflow.

### Inter-Wave Quality Gates

A dedicated session-reviewer agent checks implementation correctness, test coverage, TypeScript health, and OWASP security basics between waves. Verification escalates progressively: changed-file tests after Wave 2, full integration tests after Wave 3, complete quality suite after Wave 4.

### Design-Code Alignment

When configured with a Pencil design file, the wave executor screenshots design frames after Waves 2 and 3 and compares them with the actual implementation — checking layout structure, component hierarchy, and visual elements. Results are classified as ALIGNED / MINOR DRIFT / MAJOR MISMATCH with automatic plan adaptation.

### VCS Dual Support

Auto-detects GitLab or GitHub from your git remote. Full lifecycle support for both: issue management, MR/PR tracking, pipeline/workflow status, label taxonomy, and milestone queries. No lock-in.

### Ecosystem Health Monitoring

Checks configured service endpoints and scans cross-repo critical issues at session start. Know your ecosystem state before you start working.

### Verified Session Close-Out

`/close` verifies every planned item with evidence, runs a full quality gate, creates carryover issues for unfinished work, commits with individually staged files, and optionally mirrors to GitHub. Nothing falls through the cracks.

### Comparison

| Feature | Session Orchestrator | Manual CLAUDE.md | Other Orchestrators |
|---------|---------------------|------------------|-------------------|
| Session lifecycle (start → plan → execute → close) | Full, automated | Manual | Partial |
| Typed waves with quality gates | 5 waves, progressive verification | None | Batch execution |
| VCS integration (GitLab + GitHub) | Dual, auto-detected | Manual CLI | Usually GitHub only |
| Design-code alignment | Pencil integration | None | None |
| Session close with carryover | Verified, with issue creation | Manual | Partial |
| Personality/decision system | Soul system | None | None |

Session Orchestrator does not optimize for token cost or model routing. It optimizes for engineering quality — every wave verified, every issue tracked, every session closed cleanly.

## Usage

| Command | Purpose |
|---------|---------|
| `/session [type]` | Start session (housekeeping, feature, deep) |
| `/go` | Approve plan, begin wave execution |
| `/close` | End session with verification |

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
```

## VCS Auto-Detection

Session Orchestrator auto-detects your VCS from the git remote URL:
- Remote contains `github.com` → uses `gh` CLI
- All other remotes → uses `glab` CLI

Override with `vcs: github` or `vcs: gitlab` in Session Config.

## Architecture

Session Orchestrator handles the **session layer** (orchestration, VCS integration, waves, close-out).
Superpowers handles the **task layer** (TDD, debugging, brainstorming per feature).

```
User → /session → Research → Q&A → Plan → /go → 5 Waves → /close → Verify → Commit
```

## Components

- **6 Skills**: session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops
- **3 Commands**: /session, /go, /close
- **1 Agent**: session-reviewer (inter-wave quality gate)
- **Hooks**: SessionStart notification

## Documentation

- [User Guide](docs/USER-GUIDE.md) — installation, config reference, workflow walkthrough, FAQ
- [CONTRIBUTING.md](CONTRIBUTING.md) — plugin architecture, skill anatomy, development setup
- [CHANGELOG.md](CHANGELOG.md) — version history
- [Example Configs](docs/examples/) — Session Config examples for Next.js, Express, Swift

## License

[MIT](LICENSE)
