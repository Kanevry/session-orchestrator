---
name: eval
description: Use this skill to run an honest session-process evaluation (Standard v1, aiat-llm-eval/1.0) — score the last completed orchestrator session against the pre-registered rubric-v2 dimensions, run /eval, evaluate this session, produce an eval report, or re-verify a stored eval run for reproducibility. Deterministic-first with an optional advisory LLM judge; never produces a global score.
metadata:
  user-invocable: "true"
  argument-hint: "[--session <id>] [--no-write] [--verify <run-id>]"
  tags: eval, measurement, quality, meta, standard
  model: sonnet
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
  args-schema: "[{\"flag\":\"--session\",\"description\":\"session_id to evaluate (default: last completed session via the resolution cascade)\"},{\"flag\":\"--no-write\",\"description\":\"Evaluate + report without appending to the eval journal (.orchestrator/metrics/eval.jsonl)\"},{\"flag\":\"--verify\",\"description\":\"Re-evaluate a stored run-id and diff per-dimension for scoring drift (exit 1 on drift)\"}]"
---

# eval

> **Portable mirror — generated, do not edit.** The canonical workflow lives at
> [`skills/eval/SKILL.md`](../../../skills/eval/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.

Read the linked document in full and follow its complete workflow, including prechecks and stop conditions. Resolve its link relative to this SKILL.md, not the project working directory. The plugin root is three directories above this file. Resolve package paths such as `skills/` and `scripts/` from that root and relative links in the canonical document from its own directory. Keep the user’s project as the target of project operations.

`$ARGUMENTS` means the trailing user input after the selected command skill, or an empty string when absent. Preserve flags, quoted text, and Unicode as data. Do not perform global substitution in the command document, shell expansion on the argument string, or execution of that string as shell code. Pass command arguments through structured tool parameters or safely quoted individual arguments.
