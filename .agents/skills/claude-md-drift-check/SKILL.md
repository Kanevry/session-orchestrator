---
name: claude-md-drift-check
description: "Use when detecting drift between CLAUDE.md (or AGENTS.md, the Codex CLI alias) / _meta narrative and live repository state. Ten checks: absolute-path resolution, 01-projects/ count claims, issue-reference freshness, session-file existence, command-count sync, session-config-parity (mandatory template keys = error, opt-in gaps = warning), vault-dir-parity (CLAUDE.md vs AGENTS.md), generated-rule-staleness (WARN-only), rule-scoping (paths:/globs: frontmatter defects, dangling rule citations, zero-match globs), and docs-parity (docs/components.md count-claims vs on-disk counts, template-vs-reference config-key parity, stale .claude/metrics/ paths). Full per-check spec in the body table. Invoked as an opt-in session-end phase; mirrors vault-sync's lean JSON+exit-code contract."
metadata:
  model: haiku
---

# claude-md-drift-check

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/claude-md-drift-check/SKILL.md`](../../../skills/claude-md-drift-check/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
