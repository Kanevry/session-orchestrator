---
id: owner-card
type: peer-card
target: user
created: "2026-05-25T17:34:29.831Z"
updated: "2026-07-02T07:40:26.819Z"
source_sessions: ["evolve-2026-05-25T1638", "evolve-2026-05-30-0913"]
---

<!-- BEGIN MANAGED: session-preferences -->
## Session preferences

- Prefers deep sessions with 5 waves and parallel subagents (5W×6A standard; 5W×18A for deep clusters).
- Session types map to execution modes: deep = parallel-subagents or coord-direct, housekeeping = single-wave Express Path with 0-6 agents.
- Expects 100% completion rate per session with zero carryover as the default target.
- Accepts filing follow-up issues for MEDIUM/LOW security findings rather than blocking the session.
- When a session-reviewer reports BLOCK at inter-wave checkpoint, the fix folds into the next wave (Impl-Polish) as an additional agent rather than restarting.
<!-- END MANAGED: session-preferences -->

<!-- BEGIN MANAGED: wave-structure-preferences -->
## Wave structure preferences

- Wave 2 agents must have file-disjoint `allowedPaths` enforced — this is non-negotiable regardless of worktree isolation mode.
- When RAM is low (below ~0.6 GB free), worktree isolation is dropped automatically; prompt-level `allowedPaths` is sufficient.
- CLAUDE.md edits are deferred to Wave 5 coord-direct finalization — never dispatched to concurrent W2/W3 agents.
- MEDIUM findings discovered in-session (W3/W4) are folded and filed as follow-ups, not deferred as carryover. Exceptions: MEDIUM findings that require redesign (non-local scope change) stay as HIGH-equivalent blockers.
<!-- END MANAGED: wave-structure-preferences -->

<!-- BEGIN MANAGED: discovery-and-scope -->
## Discovery and scope

- Wave 1 Discovery findings that warrant scope adjustment must surface via AUQ before Wave 2 dispatch — never silently absorbed.
- When Discovery reveals a task was already shipped, scope is reduced immediately rather than re-implemented.
- For empty-backlog sessions, dispatching 6 parallel Explore probes (architecture, test-coverage, doc-drift, hooks-config, tech-debt, perf-health) reliably surfaces enough candidates for a full W2 parallel batch.
- W1 agents must grep-verify all file-location claims and API-shape assumptions from the issue body before W2 scope is finalized. Quote the exact grep pattern, file scope, and result count in the report. This catches mismatches (CLI-only vs importable, file renames, missing exports, SUT mis-attribution) before W2 dispatch.
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
<!-- END MANAGED: resource-management --><!-- BEGIN MANAGED: crashed-session-recovery -->
## Crashed session recovery

- When resuming a crashed session, grep-verify the STATE.md mission premise against the issue tracker + PRDs + actual code in the repo. A crashed STATE.md can encode hallucinated work (e.g., referencing closed/unrelated issues). Verify before continuing.
- The crashed session's `.claude/wave-scope.json` (if present) is the reliable artifact showing planned file scope. Diff `.allowedPaths` against `git status` (modified+untracked) to separate completed work from the crash gap.
- When resuming, run the existing test suite against the crashed work to verify it is sound before planning next steps.
<!-- END MANAGED: crashed-session-recovery --><!-- BEGIN MANAGED: commit-discipline -->
## Commit discipline and VCS

- When referencing an issue in a commit that must stay open, use `refs #N` or `part of #N` in the subject line. NEVER use close-keywords (`close`, `closes`, `fixes`, `resolves`) anywhere in the commit message — GitLab's issue-closing matcher treats these keywords in the body as permission to auto-close, regardless of surrounding negation (e.g., "does NOT fully close #N" still triggers auto-close). For issues requiring documented rationale to stay open, omit close-keywords entirely.
<!-- END MANAGED: commit-discipline -->