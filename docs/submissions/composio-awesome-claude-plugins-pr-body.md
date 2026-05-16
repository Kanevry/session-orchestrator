# Add session-orchestrator under new "Session & Workflow Orchestration" category

This PR adds **session-orchestrator** ([github.com/Kanevry/session-orchestrator](https://github.com/Kanevry/session-orchestrator), v3.6.0, MIT) to `awesome-claude-plugins`. We propose a **new category** "Session & Workflow Orchestration" co-located with `maestro-orchestrate` and `backlog`. Fallback: **Developer Productivity** if maintainers prefer to keep the category set compact.

## What session-orchestrator does

5-wave session lifecycle (Discovery → Impl-Core → Impl-Polish → Quality → Finalization) with role-based parallel subagent execution, GitLab+GitHub VCS integration, inter-wave quality gates, persistence via STATE.md, and cross-session learning via `.orchestrator/metrics/learnings.jsonl`. Includes 37 skills, 16 commands, 11 agents, a `/test` agentic end-to-end test orchestrator, and autopilot `--multi-story` for parallel worktree pipelines. Cross-platform: Claude Code + Codex CLI + Cursor IDE.

## Why a new category

Currently the closest categories are **Backend & Architecture** (where maestro-orchestrate lives) and **Developer Productivity** (where backlog lives). Neither precisely captures the **session-lifecycle workflow** focus that we, maestro-orchestrate, and backlog share. A dedicated "Session & Workflow Orchestration" category groups these three plugins clearly. We're happy to take Developer Productivity if you prefer.

## Differentiation vs maestro-orchestrate

| Axis | session-orchestrator | maestro-orchestrate |
|---|---|---|
| Execution model | 5 typed waves with inter-wave quality gates | 4-phase sequential with parallel subagents |
| VCS | GitLab-first dual support (GitHub mirror) | Runtime-agnostic |
| Cross-session learning | Confidence-scored entries in `.orchestrator/metrics/learnings.jsonl`, opt-in `/evolve` review | Session archival to `docs/maestro/` |
| Runtime coverage | Claude Code + Codex CLI + Cursor IDE (3) | Gemini CLI + Claude Code + Codex + Qwen Code (4) |

Both plugins occupy a complementary niche — we focus on a single wave-based lifecycle with VCS+learning integration; maestro focuses on multi-runtime parallel specialist delivery.

## README entry (proposed)

```markdown
- **session-orchestrator** — Structured 5-wave session orchestration (Discovery / Impl-Core / Polish / Quality / Finalization) with role-based parallel agents, GitLab+GitHub integration, inter-wave quality gates, and cross-session learning via `.orchestrator/metrics/learnings.jsonl`. Cross-platform (Claude Code + Codex CLI + Cursor IDE). [Repo](https://github.com/Kanevry/session-orchestrator) · [v3.6.0](https://github.com/Kanevry/session-orchestrator/releases/tag/v3.6.0)
```

## Marketplace metadata

- License: MIT
- Repo: external link (https://github.com/Kanevry/session-orchestrator)
- Maintainer: Bernhard Goetzendorfer (office@gotzendorfer.at)
- Tested on: Claude Code 1.x and Codex CLI 0.x (current public releases as of 2026-05-16). Cursor IDE support is sequential-only (no parallel agent dispatch); see plugin docs.

## Quick install (for readers of this PR)

```bash
# Claude Code
/plugin marketplace add Kanevry/session-orchestrator
/plugin install session-orchestrator@kanevry
```

## Out of scope of this PR

- Demo GIF / asciinema cast (tracked separately in the source repo's issue #213).
- Restructuring our repo to live inside this awesome list (we remain GitLab-primary, GitHub-mirror).

## References

- Source-side tracking issue: GL #213
- Sibling submission (awesome-claude-code): GL #123 / upstream #1611
- Source repo: https://github.com/Kanevry/session-orchestrator
- Submission draft: [docs/marketplace/composio-submission.md](../marketplace/composio-submission.md)

Happy to iterate on category placement and entry wording.
