---
description: "Use when a repository's issue backlog needs refinement so agents can start work without asking back. Measures the tracker with scripts/backlog-refine.mjs (labels, readiness of status:ready issues, size, dependencies, epics, closed-issue hygiene), then proposes splits, epics, merges, fills and closings for approval and applies them through gitlab-ops. Triggered by /backlog [repo], \"refine the backlog\", \"is the backlog ready for agents\", \"Backlog aufräumen\". Not for finding code defects (use discovery), not for cross-repo dashboards (use portfolio), and not for creating issues from scratch."
argument-hint: "[path | group/name] [--host <host>]"
---

# /backlog

Use the Session Orchestrator skill definition at `skills/backlog/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
