---
description: "Use when a repository's issue backlog needs refinement so agents can start work without asking back. Measures the tracker with scripts/backlog-refine.mjs (labels, readiness of status:ready issues, size, dependencies, epics, closed-issue hygiene), then proposes splits, epics, merges, fills and closings for approval and applies them through gitlab-ops. Triggered by /backlog [repo], \"refine the backlog\", \"is the backlog ready for agents\", \"Backlog aufräumen\". Not for finding code defects (use discovery), not for cross-repo dashboards (use portfolio), and not for creating issues from scratch."
argument-hint: "[path | group/name] [--host <host>]"
---

# /backlog

Read `skills/backlog/SKILL.md` under the Session Orchestrator package root given in your system prompt and follow it exactly.

Arguments: $@

When the file references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
