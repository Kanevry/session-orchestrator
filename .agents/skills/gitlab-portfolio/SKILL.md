---
name: gitlab-portfolio
description: "Use when you need a single-pane cross-repo health view across all vault-registered GitLab and GitHub projects. Discovers repos from `_overview.md` frontmatter in `<vault>/01-projects/*/`, aggregates open issues, MRs, critical labels, and stale signals via parallel `glab`/`gh` calls, then writes an idempotent `_PORTFOLIO.md` dashboard. Runs automatically at session-start Phase 2 when `gitlab-portfolio.enabled=true`. Triggers: \"show portfolio status\", \"refresh the portfolio dashboard\", \"which repos have critical issues\", \"run /portfolio\". <example>Context: session-start, gitlab-portfolio.enabled=true, vault has 5 registered repos. user: \"/session deep\" assistant: \"Portfolio: 3 critical issues across 2 repos — run /portfolio for details. Dashboard written to vault/01-projects/_PORTFOLIO.md.\"</example>"
metadata:
  model: sonnet
---

# gitlab-portfolio

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/gitlab-portfolio/SKILL.md`](../../../skills/gitlab-portfolio/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
