---
name: session-start
description: Use this skill when initializing a session for any project repo. Autonomously analyzes git state, VCS issues, SSOT files, branches, environment, and cross-repo status. Then presents structured findings with recommendations before development wave planning, or an operations contract for explicitly requested time-bounded operational work. Triggered by /session [housekeeping|feature|deep] or a direct session-start request.
metadata:
  user-invocable: "false"
  tags: orchestration, initialization, analysis, alignment
  model: inherit
  model-preference: opus
  model-preference-codex: gpt-5.4
  model-preference-cursor: claude-opus-4-6
---

# session-start

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/session-start/SKILL.md`](../../../skills/session-start/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
