---
description: "Use this skill when running systematic quality discovery and issue detection. Runs modular probes adapted to the project's tech stack, presents findings interactively for user triage, and creates VCS issues for confirmed problems. Invoked standalone via /discovery or embedded in session-end."
argument-hint: "[all|code|infra|ui|arch|session|audit|vault|feature] [--since <git-ref>] [--full]"
---

# /discovery

Use the Session Orchestrator skill definition at `skills/discovery/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
