---
name: quality-gates
description: Use this skill when referencing canonical quality check commands for typecheck, test, and lint. Defines 4 variants (Baseline, Incremental, Full Gate, Per-File) used by session-start, wave-executor, session-end, and session-reviewer. Reference skill — not invoked directly.
metadata:
  user-invocable: "false"
  tags: reference, quality, typecheck, test, lint
  model: haiku
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
---

# quality-gates

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/quality-gates/SKILL.md`](../../../skills/quality-gates/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
