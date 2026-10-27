---
name: deepen
description: Make a task deeper, not bigger. Use when the user asks for a deeper or more ambitious version of a task (tiefer, geh tiefer, go deeper, ambitionierter, wie würde ein Profi das angehen) or hands over an outcome-shaped deliverable (Bericht, Auswertung, Analyse, Plan, Audit, Deck, Performance-Ziel) with no ceiling word, or types /deepen [task]. Not for single-step edits, short commands (run the tests, commit), bug fixes, prompt-wording rewrites, or any request carrying nur, bloß, schnell, just, only, quick.
metadata:
  user-invocable: "true"
  argument-hint: "[task]"
  model: inherit
---

# deepen

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/deepen/SKILL.md`](../../../skills/deepen/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
