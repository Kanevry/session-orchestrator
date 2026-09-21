---
name: playwright-driver
description: Use this skill when executing web tests via the canonical `playwright` npm package (Microsoft, Apache-2.0). Dispatched by `skills/test-runner/` to execute web tests against a target, captures token-frugal AX-tree snapshots + screenshots + console output under `.orchestrator/metrics/test-runs/<run-id>/`, and exits with deterministic JSON output the orchestrator can parse.
metadata:
  user-invocable: "false"
  tags: test, driver, web, playwright
  model: haiku
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
---

# playwright-driver

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/playwright-driver/SKILL.md`](../../../skills/playwright-driver/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.
