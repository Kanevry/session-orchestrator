---
name: bootstrap
description: "Use this skill when scaffolding the minimum repository structure required by session-orchestrator. Invoked automatically by the Bootstrap Gate when CLAUDE.md, Session Config, or bootstrap.lock is missing. Also available as /bootstrap for manual invocation. Three intensity tiers: fast (demos/spikes), standard (MVPs), deep (production/team)."
metadata:
  user-invocable: "true"
  disable-model-invocation: "true"
  argument-hint: "[--upgrade <tier>]"
  tags: bootstrap, setup, scaffold, init
  model: sonnet
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
---

# bootstrap

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/bootstrap/SKILL.md`](../../../skills/bootstrap/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
