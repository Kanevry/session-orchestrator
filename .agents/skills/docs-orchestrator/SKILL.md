---
name: docs-orchestrator
description: "Use this skill when orchestrating documentation generation and updates within a session. Maps session scope to audience-specific docs tasks (User / Dev / Vault), dispatches the docs-writer agent with source-grounded prompts, and reports coverage gaps to session-end. Gated on `docs-orchestrator.enabled: true` in Session Config. Zero overhead when disabled."
metadata:
  user-invocable: "false"
  tags: docs, orchestration, audiences
  model: sonnet
  model-preference: sonnet
---

# docs-orchestrator

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/docs-orchestrator/SKILL.md`](../../../skills/docs-orchestrator/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
