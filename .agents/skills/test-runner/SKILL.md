---
name: test-runner
description: "Use this skill when orchestrating agentic end-to-end tests. Resolves target + profile, dispatches the right driver(s) (playwright for web today, peekaboo for macOS (issue #381)), invokes the ux-evaluator agent (opus, read-only) against driver artifacts, reconciles findings with the open issue tracker via scripts/lib/test-runner/issue-reconcile.mjs, and writes report.md + JSONL roll-up. Wraps upstream tools (no forks). Hard-gates Playwright MCP for browser drive (4× token cost vs CLI per Microsoft's own benchmark)."
metadata:
  user-invocable: "false"
  tags: test, orchestrator, e2e, ux
  model: sonnet
  model-preference: sonnet
  model-preference-codex: gpt-5.4
  model-preference-cursor: claude-sonnet-4-6
---

# test-runner

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/test-runner/SKILL.md`](../../../skills/test-runner/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
