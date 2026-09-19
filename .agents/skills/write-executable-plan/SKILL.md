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

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/write-executable-plan/SKILL.md`](../../../skills/write-executable-plan/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
