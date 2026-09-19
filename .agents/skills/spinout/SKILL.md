---
name: spinout
description: "Use when extracting a project into its own repo — a venture spinout (e.g. a product leaving its incubator repo) or a sanitized content-snapshot fork. Guided 5-step runbook: target sphere + path, confidentiality/sanitize check, copy + fresh git init, SNAPSHOT-FREEZE marker in the source repo, remotes + registration. Trigger on 'spin out X', 'extract this into its own repo', 'fork X sanitized'."
metadata:
  user-invocable: "true"
  argument-hint: "[--type venture|snapshot] [--dry-run]"
  model: sonnet
---

# spinout

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/spinout/SKILL.md`](../../../skills/spinout/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
