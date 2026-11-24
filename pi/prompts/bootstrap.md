---
description: "Use this skill when scaffolding the minimum repository structure required by session-orchestrator. Invoked automatically by the Bootstrap Gate when CLAUDE.md, Session Config, or bootstrap.lock is missing. Also available as /bootstrap for manual invocation. Three intensity tiers: fast (demos/spikes), standard (MVPs), deep (production/team)."
argument-hint: "[--fast|--standard|--deep] [--no-interview] [--upgrade <tier>]"
---

# /bootstrap

Read `skills/bootstrap/SKILL.md` under the Session Orchestrator package root given in your system prompt and follow it exactly.

Arguments: $@

When the file references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
