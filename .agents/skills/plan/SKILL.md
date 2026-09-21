---
name: plan
description: "Use this skill when performing structured project planning and PRD generation with three modes: new (project kickoff with repo scaffolding), feature (compact feature PRD), retro (data-driven retrospective). All modes share a researched Q&A engine that dispatches parallel Explore agents before each question wave, presents options via AskUserQuestion with recommendations, and produces documents with prioritized issue creation."
metadata:
  user-invocable: "true"
  disable-model-invocation: "true"
  argument-hint: "[new|feature|retro]"
  tags: planning, prd, requirements, research
  model: inherit
  model-preference: opus
  model-preference-codex: gpt-5.4
  model-preference-cursor: claude-opus-4-6
---

# plan

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/plan/SKILL.md`](../../../skills/plan/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
