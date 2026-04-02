# Session Orchestrator

Claude Code plugin for session-level orchestration — wave planning, VCS integration, quality gates.

## Install

```bash
claude plugin install <path-to-session-orchestrator>
```

## Usage

| Command | Purpose |
|---------|---------|
| `/session [type]` | Start session (housekeeping, feature, deep) |
| `/go` | Approve plan, begin wave execution |
| `/close` | End session with verification |

## Session Types

- **housekeeping** — Git cleanup, SSOT refresh, CI checks, branch merges (1-2 agents, serial)
- **feature** — Frontend/backend feature work (6 agents x 5 waves)
- **deep** — Complex backend, security, DB, refactoring (up to 18 agents x 5 waves)

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

Session Orchestrator handles the **session layer** (orchestration, GitLab, waves, close-out).
Superpowers handles the **task layer** (TDD, debugging, brainstorming per feature).

```
User → /session → Research → Q&A → Plan → /go → 5 Waves → /close → Verify → Commit
```

## Components

- **6 Skills**: session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops
- **3 Commands**: /session, /go, /close
- **1 Agent**: session-reviewer (inter-wave quality gate)
- **Hooks**: SessionStart notification
