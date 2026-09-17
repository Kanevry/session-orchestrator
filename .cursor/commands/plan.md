---
description: "Use this skill when performing structured project planning and PRD generation with three modes: new (project kickoff with repo scaffolding), feature (compact feature PRD), retro (data-driven retrospective). All modes share a researched Q&A engine that dispatches parallel Explore agents before each question wave, presents options via AskUserQuestion with recommendations, and produces documents with prioritized issue creation."
argument-hint: "[new|feature|retro]"
disable-model-invocation: true
---

# /plan

Use the Session Orchestrator skill definition at `skills/plan/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
