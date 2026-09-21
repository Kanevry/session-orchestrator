---
name: sunset-review
description: "Use this skill when the user wants to identify unused, near-zero-use, or stale skills/agents/commands in the plugin surface so they can be demoted or retired. Combines agent-dispatch telemetry (start-events only) with static reference scanning, classifies every surface item into Active / Investigate / Demote / Retire, and emits a Markdown report plus JSON sidecar. NEVER auto-deletes — surfaces candidates for human decision. Quarterly cadence. <example>Context: The plugin surface has grown and the maintainer wants to prune dead weight. user: \"/sunset-review\" assistant: \"Running the sunset walk — classifying skills, agents, and commands by usage telemetry + static refs, grouped by Retire / Demote / Investigate / Active. No item is deleted automatically; I'll surface Retire/Demote candidates for your decision.\" <commentary>The user wants a usage-driven prune candidate list; this skill runs the read-only walker, presents grouped verdicts, and writes a sidecar — it never deletes.</commentary></example>"
metadata:
  user-invocable: "true"
  argument-hint: "[--kind skill|agent|command] [--window-days N]"
  model: inherit
  color: amber
---

# sunset-review

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/sunset-review/SKILL.md`](../../../skills/sunset-review/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
