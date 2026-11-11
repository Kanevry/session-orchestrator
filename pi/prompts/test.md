---
description: "Agentic end-to-end test orchestrator — drive web/macOS flows, evaluate UX rubric, reconcile issues"
argument-hint: "[scope|profile-name] [--target-kind live|production-build|dev-server] [--target-url <url>] [--since <git-ref>] [--full]"
---

# /test

Use the Session Orchestrator skill definition at `skills/test/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
