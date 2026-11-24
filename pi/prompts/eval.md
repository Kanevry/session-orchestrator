---
description: "Use this skill to run an honest session-process evaluation (Standard v1, aiat-llm-eval/1.0) — score the last completed orchestrator session against the pre-registered rubric-v3 dimensions, run /eval, evaluate this session, produce an eval report, or re-verify a stored eval run for reproducibility. Deterministic-first with an optional advisory LLM judge; never produces a global score."
argument-hint: "[--session <id>] [--no-write] [--verify <run-id>]"
---

# /eval

Read `skills/eval/SKILL.md` under the Session Orchestrator package root given in your system prompt and follow it exactly.

Arguments: $@

When the file references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
