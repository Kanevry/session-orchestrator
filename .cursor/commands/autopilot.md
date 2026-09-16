---
description: "Use this skill when running an autonomous session-orchestration loop. Chains session-start → session-plan → wave-executor → session-end for N iterations with all 10 kill-switches (SPIRAL, FAILED wave, carryover > 50%, max-hours, max-sessions, resource-overload, token-budget, stall-timeout, sub-threshold confidence, user-abort). Reads Mode-Selector output (Phase B) to decide auto-execute vs. fallback. Writes one autopilot.jsonl record per loop run. Phase C scaffold (issue #277); implementation lives in scripts/lib/autopilot.mjs (Phase C-1 follow-up)."
argument-hint: "[--headless] [--verbose] [--max-sessions=N] [--max-hours=H] [--confidence-threshold=0.X] [--dry-run]"
---

# /autopilot

Use the Session Orchestrator skill definition at `skills/autopilot/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
