---
description: "Use this skill when the user wants to identify unused, near-zero-use, or stale skills/agents/commands in the plugin surface so they can be demoted or retired. Combines agent-dispatch telemetry (start-events only) with static reference scanning, classifies every surface item into Active / Investigate / Demote / Retire, and emits a Markdown report plus JSON sidecar. NEVER auto-deletes — surfaces candidates for human decision. Quarterly cadence. <example>Context: The plugin surface has grown and the maintainer wants to prune dead weight. user: \"/sunset-review\" assistant: \"Running the sunset walk — classifying skills, agents, and commands by usage telemetry + static refs, grouped by Retire / Demote / Investigate / Active. No item is deleted automatically; I'll surface Retire/Demote candidates for your decision.\" <commentary>The user wants a usage-driven prune candidate list; this skill runs the read-only walker, presents grouped verdicts, and writes a sidecar — it never deletes.</commentary></example>"
argument-hint: "[--kind skill|agent|command] [--window-days N]"
---

# /sunset-review

Use the Session Orchestrator skill definition at `skills/sunset-review/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
