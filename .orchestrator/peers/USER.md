---
id: owner-card
type: peer-card
target: user
created: "2026-05-25T17:34:29.831Z"
updated: "2026-05-25T17:34:29.831Z"
source_sessions: ["evolve-2026-05-25T1638"]
---

<!-- BEGIN MANAGED: session-preferences -->
## Session preferences

- Prefers deep sessions with 5 waves and parallel subagents (5W×6A standard; 5W×18A for deep clusters).
- Session types map to execution modes: deep = parallel-subagents or coord-direct, housekeeping = single-wave Express Path with 0-6 agents.
- Expects 100% completion rate per session with zero carryover as the default target.
- Accepts filing follow-up issues for MEDIUM/LOW security findings rather than blocking the session.
<!-- END MANAGED: session-preferences -->

<!-- BEGIN MANAGED: wave-structure-preferences -->
## Wave structure preferences

- Wave 2 agents must have file-disjoint `allowedPaths` enforced — this is non-negotiable regardless of worktree isolation mode.
- When RAM is low (below ~0.6 GB free), worktree isolation is dropped automatically; prompt-level `allowedPaths` is sufficient.
- CLAUDE.md edits are deferred to Wave 5 coord-direct finalization — never dispatched to concurrent W2/W3 agents.
- When a session-reviewer reports BLOCK at end of Impl-Core, fold the fix into the next wave (Impl-Polish) as an additional agent rather than restarting the wave.
<!-- END MANAGED: wave-structure-preferences -->

<!-- BEGIN MANAGED: discovery-and-scope -->
## Discovery and scope

- Wave 1 Discovery findings that warrant scope adjustment must surface via AUQ before Wave 2 dispatch — never silently absorbed.
- When Discovery reveals a task was already shipped, scope is reduced immediately rather than re-implemented.
- For empty-backlog sessions, dispatching 6 parallel Explore probes (architecture, test-coverage, doc-drift, hooks-config, tech-debt, perf-health) reliably surfaces enough candidates for a full W2 parallel batch.
<!-- END MANAGED: discovery-and-scope -->

<!-- BEGIN MANAGED: quality-and-verification -->
## Quality and verification

- CI status at session-start is authoritative; local `npm test` green does not substitute for CI green.
- Quality-Lite after Impl-Core must include `npm test` when the production fix touches files with co-located tests.
- Full Gate (typecheck + lint + test + validate-plugin) is required before commit; the gate is the reviewer.
- Session-reviewer dispatch is safely skipped when the session ships runtime + comprehensive test suite extension (≥10 new tests) on top of a known-good base.
- Session-reviewer dispatch is safely skipped for doc-only scaffold sessions (zero new code modules).
<!-- END MANAGED: quality-and-verification -->

<!-- BEGIN MANAGED: resource-management -->
## Resource management

- Hard-blocking on idle peer processes is unacceptable for autonomous loops; resource-adaptive 4-tier cap (green/warn/degraded/critical) is preferred.
- Coordinator-direct mode at cap=0 is viable for multi-issue feature sessions under RAM pressure.
<!-- END MANAGED: resource-management -->