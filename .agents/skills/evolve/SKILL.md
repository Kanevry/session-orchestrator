---
name: evolve
description: "Use this skill when extracting session patterns into reusable learnings. Three modes: analyze (extract from session history), review (edit/manage existing learnings), list (display active learnings). Manages .orchestrator/metrics/learnings.jsonl."
metadata:
  user-invocable: "true"
  argument-hint: "[analyze|review|list|dialectic [--apply]]"
  tags: learning, intelligence, meta
  model: sonnet
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
  args-schema: "[{\"flag\":\"--apply\",\"description\":\"Apply dialectic-derived diff to USER.md + AGENT.md\"},{\"flag\":\"--dry-run\",\"description\":\"Show diff without writing (default)\"},{\"flag\":\"--model <name>\",\"description\":\"Override single-pass LLM (haiku|sonnet|opus)\"},{\"flag\":\"--budget-tokens <N>\",\"description\":\"Input token ceiling for derivation prompt (default 32000; aborts above it, never truncates)\"}]"
---

# evolve

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/evolve/SKILL.md`](../../../skills/evolve/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
