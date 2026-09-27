---
description: "Fleet coordinator persona for sessions running side by side on one host: it measures resources, pipelines and merge readiness itself, writes conditions (\"Auflagen\") as files, starts headless runs behind slot and busy gates, and grants no approvals. Operator-only, invoke as /session-orchestrator:navigator ticker|status|start|fenster|handover."
argument-hint: "[ticker|status|start|fenster|handover]"
---

# /navigator

Use the Session Orchestrator skill definition at `skills/navigator/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
