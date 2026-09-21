---
name: reconcile
description: Use this skill when the user wants to reconcile learnings into rules, run /reconcile, propose rules from learnings, turn learnings into .claude/rules/ entries, or review what rules would be generated from current session learnings. On-demand version of session-end Phase 3.6.8.
metadata:
  user-invocable: "true"
  argument-hint: "[--dry-run]"
  tags: learning, rules, intelligence, meta
  model: sonnet
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
  args-schema: "[{\"flag\":\"--dry-run\",\"description\":\"Print proposals without writing anything or rendering the approval AUQ\"}]"
---

# reconcile

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/reconcile/SKILL.md`](../../../skills/reconcile/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
