---
name: autopilot
description: "Use this skill when running an autonomous session-orchestration loop. Chains session-start → session-plan → wave-executor → session-end for N iterations with all 10 kill-switches (SPIRAL, FAILED wave, carryover > 50%, max-hours, max-sessions, resource-overload, token-budget, stall-timeout, sub-threshold confidence, user-abort). Reads Mode-Selector output (Phase B) to decide auto-execute vs. fallback. Writes one autopilot.jsonl record per loop run. Phase C scaffold (issue #277); implementation lives in scripts/lib/autopilot.mjs (Phase C-1 follow-up)."
metadata:
  user-invocable: "true"
  argument-hint: "[--headless] [--verbose] [--max-sessions=N] [--max-hours=H] [--confidence-threshold=0.X] [--dry-run]"
  tags: phase-c, autopilot, autonomous, loop
  model: sonnet
---

# autopilot

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/autopilot/SKILL.md`](../../../skills/autopilot/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
