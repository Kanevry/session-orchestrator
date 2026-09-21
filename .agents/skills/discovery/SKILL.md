---
name: discovery
description: Use this skill when running systematic quality discovery and issue detection. Runs modular probes adapted to the project's tech stack, presents findings interactively for user triage, and creates VCS issues for confirmed problems. Invoked standalone via /discovery or embedded in session-end.
metadata:
  user-invocable: "true"
  argument-hint: "[all|code|infra|ui|arch|session|audit|vault|feature] [--since <git-ref>] [--full]"
  tags: quality, discovery, probes, issues
  model: sonnet
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
---

# discovery

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/discovery/SKILL.md`](../../../skills/discovery/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
