---
name: brainstorm
description: Use when you have a feature idea but the scope or UX is still ambiguous — runs a lightweight Socratic design dialogue (3-5 AUQ rounds) and writes a spec markdown file. Use BEFORE /plan feature when product intent needs validation; skip to /plan feature when scope is already clear. HARD-GATE prevents any code work until the design is user-approved.
metadata:
  model: inherit
  color: cyan
  user-invocable: "true"
  disable-model-invocation: "true"
  argument-hint: "[topic-or-feature-slug]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
---

# brainstorm

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/brainstorm/SKILL.md`](../../../skills/brainstorm/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
