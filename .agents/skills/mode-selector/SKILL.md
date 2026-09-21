---
name: mode-selector
description: "Use this skill when performing deterministic mode selection for session-start. Reads Phase A STATE.md recommendations + (future) learnings, sessions, backlog, bootstrap signals and returns {mode, rationale, confidence, alternatives}. Pure-function contract — no side effects, no STATE.md writes. Phase B scaffold (issue #276); full heuristic is follow-up sub-issues."
metadata:
  model: haiku
  user-invocable: "false"
  tags: phase-b, autopilot, mode-selection, scaffold
---

# mode-selector

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/mode-selector/SKILL.md`](../../../skills/mode-selector/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
