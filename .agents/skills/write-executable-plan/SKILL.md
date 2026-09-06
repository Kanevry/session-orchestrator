---
name: write-executable-plan
description: Use when you have a PRD or design spec and need a bite-sized, executable implementation plan that any agent can follow without re-deriving structure. Produces `docs/plans/YYYY-MM-DD-<feature>.md` with per-task Files block, complete code per step (no placeholders), and exact verification commands. Rejects "TBD", "TODO", "add error handling", "similar to Task N".
metadata:
  model: inherit
  color: green
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
---

# write-executable-plan

> **Portable mirror — generated, do not edit.** The canonical skill body lives at
> [`skills/write-executable-plan/SKILL.md`](../../../skills/write-executable-plan/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.
