---
name: memory-cleanup
description: Use this skill when performing manual memory consolidation (Dream-equivalent). Reviews, consolidates, and prunes memory files under ~/.claude/projects/*/memory/. Run after major refactors, every 5+ sessions, or when memory quality degrades (broken links, stale references, contradictions, MEMORY.md > 200 lines). Invoke with /memory-cleanup.
metadata:
  user-invocable: "true"
  tags: memory, maintenance, meta, dream
  model: sonnet
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
  args-schema: "[{\"flag\":\"--dry-run\",\"description\":\"Produce complete-body proposal in .orchestrator/pending-dream.md, no mutations.\"},{\"flag\":\"--apply-pending\",\"description\":\"Consume .orchestrator/pending-dream.md (atomic apply).\"}]"
---

# memory-cleanup

> **Portable mirror — generated, do not edit.** The canonical skill body lives at
> [`skills/memory-cleanup/SKILL.md`](../../../skills/memory-cleanup/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.
