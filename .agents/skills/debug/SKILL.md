---
name: debug
description: "Use when encountering any bug, test failure, build break, or unexpected behavior — runs a 4-phase systematic debugging process before proposing any fix. Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST. Produces a `.orchestrator/debug/` artifact the fixer agent must reference."
metadata:
  model: inherit
  color: red
  user-invocable: "true"
  argument-hint: "[bug-description-or-issue-ref]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
---

# debug

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/debug/SKILL.md`](../../../skills/debug/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
