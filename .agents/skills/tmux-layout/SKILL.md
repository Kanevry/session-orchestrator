---
name: tmux-layout
description: "Use this skill when the operator wants a prepared tmux visualization layout for the session's side-channels (STATE.md tail, CI-watch, events.jsonl tail). Renders a 4-pane default layout or debug layout. Read-only side-channel observability — the coordinator chat stays in the operator's original terminal. Trigger phrases: \"tmux layout\", \"split panes for ci watch\", \"visualize session side-channels\", \"show me state-md tail and ci\"."
metadata:
  model: inherit
  color: cyan
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
---

# tmux-layout

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/tmux-layout/SKILL.md`](../../../skills/tmux-layout/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
