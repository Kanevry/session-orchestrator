---
description: "Use when you want the orchestrator to pick the next repo to work on across your whole portfolio — it enumerates candidate repos below the confinement root, resolves free/busy from each repo's session.lock lease, ranks the FREE ones by backlog priority × staleness × readiness, recommends the single most worthwhile one via AskUserQuestion, atomically claims it, and routes you to the chosen entry command. Triggers: \"what should I work on next\", \"dispatch me to a repo\", \"pick the next project\", \"run /dispatcher\". <example>Context: operator finished a session and wants the next-best repo across the portfolio. user: \"/dispatcher\" assistant: \"Ranked 18 free repos — top recommendation: Pencil-Designs (score 4.50, 90d stale). Confirm via the picker, I'll claim its lease atomically, then route you to /session deep.\"</example>"
argument-hint: "[--dry-run] [--repo <name>]"
---

# /dispatcher

Use the Session Orchestrator skill definition at `skills/dispatcher/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
