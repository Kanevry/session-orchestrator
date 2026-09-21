---
name: session-end
description: "Use this skill when performing a full session close-out: verifies all planned work against the agreed plan, creates issues for gaps, runs quality gates, commits cleanly, mirrors to GitHub, and produces a session summary. Triggered by /close command."
metadata:
  user-invocable: "false"
  tags: orchestration, verification, commits, issues
  model: inherit
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
---

# session-end

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/session-end/SKILL.md`](../../../skills/session-end/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
