---
name: remote-offload
description: Use when local resource pressure would shrink or coordinator-direct a wave, a wave plan carries heavy build/test/audit roles (test, ui, perf), or the operator says offload, remote host, or auslagern — reference for routing that wave role to a declared SSH-reachable host instead of reducing agent count
metadata:
  user-invocable: "false"
  tags: reference, remote, offload, wave-executor, resource-gate
  model: haiku
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
---

# remote-offload

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/remote-offload/SKILL.md`](../../../skills/remote-offload/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
