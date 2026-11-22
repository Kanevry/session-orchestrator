---
description: "Use this skill when the user requests a public website discoverability audit from an explicit manifest, including HTTP redirects, page metadata, typed JSON-LD requirements, sitemaps, robots policy, crawler responses, head resources, HTML bytes and optional public files. Runs bounded deterministic observations without login, browser automation, account integrations or ranking claims; search visibility and account data remain stage L."
argument-hint: "[--manifest <file>] [--json] [--out <file>] [--max-requests-per-host <1..5>]"
---

# /public-audit

Use the Session Orchestrator skill definition at `skills/public-audit/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
