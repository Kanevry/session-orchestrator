---
description: "Use this skill when running systematic quality discovery and issue detection. Runs modular probes adapted to the project's tech stack, presents findings interactively for user triage, and creates VCS issues for confirmed problems. Invoked standalone via /discovery or embedded in session-end."
argument-hint: "[all|code|infra|ui|arch|session|audit|vault|feature] [--since <git-ref>] [--full]"
---

# /discovery

Read `skills/discovery/SKILL.md` under the Session Orchestrator package root given in your system prompt and follow it exactly.

Arguments: $@

When the file references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
