---
description: "Use this skill to run an honest session-process evaluation (Standard v1, aiat-llm-eval/1.0) — score the last completed orchestrator session against the pre-registered rubric-v2 dimensions, run /eval, evaluate this session, produce an eval report, or re-verify a stored eval run for reproducibility. Deterministic-first with an optional advisory LLM judge; never produces a global score."
argument-hint: "[--session <id>] [--no-write] [--verify <run-id>]"
---

# /eval

Use the Session Orchestrator skill definition at `skills/eval/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
