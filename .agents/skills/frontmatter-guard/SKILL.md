---
name: frontmatter-guard
description: "Injects the canonical vault frontmatter schema snippet into agent prompts before any vault-write task, preventing malformed YAML frontmatter in Obsidian notes. <example>Context: wave-executor is about to dispatch a vault-mirror agent that writes learning notes under ~/Projects/vault/40-learnings/. user: \"dispatch vault-write agent\" assistant: \"Injecting frontmatter-guard snippet into agent prompt (vault scope detected). Required fields: id, type, created, updated. Enum type: note|daily|project|person|reference|idea|learning|session.\" <commentary>The wave-executor pre-dispatch hook calls detectVaultTaskScope() — the fileScope contains /Projects/vault/40-learnings/ so the guard triggers and the snippet is prepended to the agent system prompt.</commentary></example>"
metadata:
  model: inherit
---

# frontmatter-guard

> **Portable mirror — generated, do not edit.** The canonical skill body lives at
> [`skills/frontmatter-guard/SKILL.md`](../../../skills/frontmatter-guard/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.
