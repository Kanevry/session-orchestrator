---
paths: ["scripts/lib/session-lock*.mjs", "scripts/lib/locks/**", "scripts/lib/state-md/**", "hooks/_lib/lock-bootstrap.mjs", "hooks/on-session-start.mjs", "hooks/post-subagent-discovery-validator.mjs", "scripts/lib/wave-transcript-tail.mjs", "skills/session-start/**", "skills/session-plan/**", "skills/wave-executor/**", "skills/discovery/**", "skills/session-end/**", "agents/**"]
tier: always
review-date: 2026-10-23
---

# Parallel Session Mechanics
PSA-001–007 remain universal in parallel-sessions.md. Session occupancy: hooks/on-session-start.mjs → hooks/_lib/lock-bootstrap.mjs bootstrapLock(); heartbeat schema in skills/_shared/state-ownership.md. STATE writes: scripts/lib/locks/state-md-lock.mjs via withStateMdLock; writers lock, readers do not.
Discovery validator default false: hooks/post-subagent-discovery-validator.mjs logs discovery_validator_violation + stderr WARN, never blocks. Distributional records and gate-verdict records are separate; undated verified measurements only warn. Distributional gate-summary exemptions must not suppress DONE/gate verdict scanning. wave-transcript-tail.mjs is a violation signal, not preventive permission.
## See Also
parallel-sessions.md · skills/_shared/state-ownership.md · receiving-review.md
