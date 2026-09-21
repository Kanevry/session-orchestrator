---
name: peekaboo-driver
description: Use this skill when driving native-UI AX-tree snapshots and screenshots via steipete/peekaboo (MIT, macOS-only). Dispatched by `skills/test-runner/` to capture native-UI AX-tree snapshots + screenshots on macOS 15+ targets, and exits with deterministic JSON output the orchestrator can parse.
metadata:
  user-invocable: "false"
  tags: test, driver, macos, peekaboo
  model: haiku
  model-preference: sonnet
---

# peekaboo-driver

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/peekaboo-driver/SKILL.md`](../../../skills/peekaboo-driver/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
