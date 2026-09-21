---
name: templates-ack
description: Acknowledge templates-first policy for the current session — bypasses the pre-bash-templates-first hook for the remainder of the session
metadata:
  argument-hint: "[optional-reason]"
---

# templates-ack

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`commands/templates-ack.md`](../../../commands/templates-ack.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.

Read the full command before invoking an internal skill. An instruction to invoke a skill (including `session-orchestrator:<name>` or the `Skill` tool) means read and follow the canonical `skills/<name>/SKILL.md` beneath the plugin root. Do not redispatch the public command adapter: a same-named command and internal skill are distinct documents, and redispatch would recurse.
