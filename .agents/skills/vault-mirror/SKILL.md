---
name: vault-mirror
description: "Use when you need to populate the Meta-Vault with machine-generated notes derived from session-orchestrator JSONL records. Converts entries from `.orchestrator/metrics/sessions.jsonl` and `.orchestrator/metrics/learnings.jsonl` into vault-conformant Markdown under `50-sessions/` and `40-learnings/`. Called automatically at session-end Phase 3.7 and after evolve Phase 3.5 — only when `vault-integration.enabled=true` and `vault-integration.mode != \"off\"`. Idempotent: re-runs safely; skips hand-authored notes. Triggers: \"mirror to vault\", \"sync session notes to vault\", \"write learning notes to vault\", \"vault-mirror failed at session close\". <example>Context: session-end is finalizing, vault-integration.mode is \"warn\". user: \"/close\" assistant: \"Running vault-mirror to write 50-sessions/session-2026-05-17.md from the closing session record — 1 created, 0 skipped.\"</example>"
metadata:
  model: haiku
---

# vault-mirror

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/vault-mirror/SKILL.md`](../../../skills/vault-mirror/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
