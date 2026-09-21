---
name: ux-grill
description: Use when a running web app's UX has to be audited reproducibly rather than by feel — a deterministic mechanical pass over routes and viewports (axe, target size, horizontal overflow, page title, scripted journeys) followed by a screenshot-grounded interrogation of the operator, journey by journey, with two persona lenses from the target repo's manifest. Triggered by "grill the UX", "roast the dashboard", "UX-Audit", "/ux-grill". Bootstraps its own manifest from a loopback URL on the first run, so it never requires a hand-written file to start.
metadata:
  user-invocable: "true"
  argument-hint: "[url | manifest-path]"
  model: inherit
  color: magenta
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
---

# ux-grill

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/ux-grill/SKILL.md`](../../../skills/ux-grill/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
