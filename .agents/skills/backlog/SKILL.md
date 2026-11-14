---
name: backlog
description: Use when a repository's issue backlog needs refinement so agents can start work without asking back. Measures the tracker with scripts/backlog-refine.mjs (labels, readiness of status:ready issues, size, dependencies, epics, closed-issue hygiene), then proposes splits, epics, merges, fills and closings for approval and applies them through gitlab-ops. Triggered by /backlog [repo], "refine the backlog", "is the backlog ready for agents", "Backlog aufräumen". Not for finding code defects (use discovery), not for cross-repo dashboards (use portfolio), and not for creating issues from scratch.
metadata:
  user-invocable: "true"
  argument-hint: "[path | group/name] [--host <host>]"
  model: inherit
---

# backlog

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/backlog/SKILL.md`](../../../skills/backlog/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
