---
name: security
description: Use when the operator wants to know which security mechanisms run in a repository, what the dependency advisories of its lockfiles mean, whether its install and publish settings are safe, or what steers the agent in this repo and on this host. Runs the read-only scripts/security.mjs in four modes (status, deps, posture, agent-setup) and routes "review" to the existing security-reviewer agent. Triggered by /security, "security status", "dependency advisories", "npm audit is red", "check the agent setup", "Sicherheitsstatus", "Abhängigkeiten prüfen". Not a vulnerability scanner or diff reviewer of its own, not for answering external advisory reports, and not for configuring the guards or hooks.
metadata:
  user-invocable: "true"
  argument-hint: "[status|deps|posture|agent-setup|review] [--ref <commit>]"
  model: inherit
---

# security

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/security/SKILL.md`](../../../skills/security/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
