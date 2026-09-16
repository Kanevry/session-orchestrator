---
description: "Use this skill when extracting session patterns into reusable learnings. Three modes: analyze (extract from session history), review (edit/manage existing learnings), list (display active learnings). Manages .orchestrator/metrics/learnings.jsonl."
argument-hint: "[analyze|review|list|dialectic [--apply]]"
---

# /evolve

Use the Session Orchestrator skill definition at `skills/evolve/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
