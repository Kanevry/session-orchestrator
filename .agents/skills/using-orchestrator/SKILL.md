---
name: using-orchestrator
description: "Use this skill when dispatching implicit slash-command intent from the user's first message. Inspects the user's first message for implicit slash-command intent and dispatches to the highest-confidence matching entry-point skill via the Skill tool. Only active when `auto-skill-dispatch: true` in Session Config. Silent no-op otherwise."
metadata:
  user-invocable: "false"
  tags: dispatch, meta, routing, auto-skill
  model: haiku
---

# using-orchestrator

> **Portable mirror — generated, do not edit.** The canonical skill body lives at
> [`skills/using-orchestrator/SKILL.md`](../../../skills/using-orchestrator/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.
