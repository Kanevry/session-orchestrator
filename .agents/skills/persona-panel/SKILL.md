---
name: persona-panel
description: Use this skill when you need multi-persona parallel content review — domain experts, buyer personas, compliance reviewers, or custom catalog entries reviewing a target file or output. Dispatches N persona agents in parallel, consolidates verdicts via a configurable mode (voting-quorum, hard-gate-threshold, or coordinator-summary), and writes a timestamped sidecar to .orchestrator/persona-panel/. Invoked via /persona-panel <target-path>.
metadata:
  user-invocable: "true"
  argument-hint: <target> [--personas <names,...>] [--mode <voting|hard-gate|summary>] [--threshold <M-of-N|all|any>] [--grounding <off|re-derive>] [--dry-run]
  tags: review, personas, content, quality, multi-agent
  model: inherit
---

# persona-panel

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/persona-panel/SKILL.md`](../../../skills/persona-panel/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
