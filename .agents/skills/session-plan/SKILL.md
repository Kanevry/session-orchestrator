---
name: session-plan
description: Creates a structured wave execution plan with role-based assignment after user alignment. Decomposes agreed tasks into waves resolved from the session mode by `scripts/session-shape.mjs`, with optimal agent assignment, dependency ordering, and inter-wave checkpoints. Activated by session-start after Q&A phase completes.
metadata:
  user-invocable: "false"
  tags: orchestration, planning, waves, agents
  model: inherit
  model-preference: opus
  model-preference-codex: gpt-5.4
  model-preference-cursor: claude-opus-4-6
---

# session-plan

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/session-plan/SKILL.md`](../../../skills/session-plan/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
