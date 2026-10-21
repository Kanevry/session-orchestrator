---
paths: ["scripts/lib/resource-probe*.mjs", "scripts/lib/resource-probe/**", "scripts/lib/wave-resource-gate.mjs", "scripts/lib/orphan-reaper*.mjs", "scripts/lib/orphan-reaper/**", "scripts/lib/config/reaper.mjs", "hooks/on-session-start.mjs", "skills/session-start/phase-4-5-resource-health.md", "skills/wave-executor/**", "tests/lib/resource-probe*", "tests/lib/resource-probe/**", "tests/lib/wave-resource-gate.test.mjs", "tests/lib/orphan-reaper*", "tests/lib/orphan-reaper/**", "docs/adr/0015-process-group-kill-and-orphan-reaper.md"]
tier: always
review-date: 2026-10-23
---

# Host Resource Details
HR-101–107 remain universal in host-resources.md. Probe/evaluation: scripts/lib/resource-probe/evaluate.mjs; orphan decision: scripts/lib/orphan-reaper/reaper-decide.mjs. Before tuning, audit orchestrator.session.started events with unique session_id denominator and pressure<30, peers>=5, CPU>90 numerators. This is audit instrumentation, not a new threshold. Persist measured inputs and emit one systemMessage. No unregistered PID is killable.
## See Also
host-resources.md · docs/adr/0015-process-group-kill-and-orphan-reaper.md · docs/session-config-reference.md
