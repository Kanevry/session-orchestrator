---
description: "Use this skill when scaffolding the minimum repository structure required by session-orchestrator. Invoked automatically by the Bootstrap Gate when CLAUDE.md, Session Config, or bootstrap.lock is missing. Also available as /bootstrap for manual invocation. Three intensity tiers: fast (demos/spikes), standard (MVPs), deep (production/team)."
argument-hint: "[--upgrade <tier>]"
---

# /bootstrap

Use the Session Orchestrator skill definition at `skills/bootstrap/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
