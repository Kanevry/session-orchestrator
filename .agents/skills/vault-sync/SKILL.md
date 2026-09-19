---
name: vault-sync
description: "Use when you need to validate the Meta-Vault's Markdown frontmatter and wiki-link integrity before closing a session or after vault edits. Runs as a hard gate at session-end Phase 1 — blocks close if any `.md` file fails the Zod frontmatter schema or has dangling `[[wiki-links]]`. Supports three modes: `hard` (blocks on errors), `warn` (reports without blocking), `off` (skip). Reads `vault-sync.*` from Session Config; respects per-vault exclude globs from `CLAUDE.md`. Triggers: \"vault validation failed at session close\", \"fix vault frontmatter errors\", \"check vault wiki-links\", \"why is session-end blocked by vault-sync\". <example>Context: session-end Phase 1 quality gate, vault-sync.enabled=true, vault-sync.mode=\"hard\". user: \"/close\" assistant: \"vault-sync found 2 frontmatter errors in vault/40-learnings/ml-notes.md — missing required `id` field. Fixing before close.\"</example>"
metadata:
  model: haiku
---

# vault-sync

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/vault-sync/SKILL.md`](../../../skills/vault-sync/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
