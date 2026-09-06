# Phase 6: Session Summary Template

> Sub-file of the session-end skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-end/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

Present to the user:

```
## Session Summary

### Completed
- [x] Issue #N: [description] — [evidence: tests passing, files changed]
- [x] Issue #M: [description]

### Carried Over
- [ ] Issue #P: [what's left] — new issue #Q created
- [ ] [description] — blocked by [reason]

### Dropped at Handover Gate (deselected in triage — origin issue left open) [#769]
- [ ] [middle-band item] — origin #<IID> — reason: [operator deselected in Phase 1.65 triage; no [Carryover] duplicate filed]

### New Issues Created
- #R: [title] (priority: [X], status: ready)
- #S: [title] (priority: [X], status: ready)

### Unresolved Review Findings (MED/LOW — recorded, not ticketed) [#617]
- [MED] <finding> — <file:line> — <why deferred / fold decision>
- [LOW] <finding> — <file:line>

### Metrics
- Duration: [total wall-clock time]
- Waves: [N completed]
- Agents: [total dispatched] ([X complete, Y partial, Z failed])
- Files changed: [N]
- Per-wave breakdown:
  - Wave 1 (Discovery): [duration] — [N agents] — [K files]
  - Wave 2 (Impl-Core): [duration] — [N agents] — [K files]
  - ...
- Tests: [passing/total] · Δ this session: +[added] / −[removed] / ~[consolidated] · tests:src LOC ratio [x.xx] (advisory ceiling 1.60)
- TypeScript: 0 errors
- Commits: [N] pushed to [branch]
- Mirror: [synced/skipped]
- Docs Health: Vault staleness — [render one of the three cases below based on Phase 2.3 result]
  - Findings present (warn mode): `[N stale projects, M stale narratives] (mode=warn). See .orchestrator/metrics/vault-staleness.jsonl.`
  - Skipped (disabled or mode=off): `skipped (disabled | mode=off).`
  - Clean run: `clean (mode=<mode>).`
- Custom Phases: [render based on Phase 2.5 result — omit the line entirely if `custom-phases` was absent/empty]
  - Per phase: `<name>: <pass|FAIL> (exit <code>, mode=<mode>)[ — review: <path>]`
  - None ran (all filtered out by `when`): `none applicable for session-type=<type>.`
- Enforcement: [N violations blocked / M warnings] (or "N/A" if enforcement off)
- Circuit breaker: [N agents hit limits, M spirals detected] (or "none")
- Metrics written to: `.orchestrator/metrics/sessions.jsonl`
- Learnings: [N] new, [M] confirmed, [K] contradicted/expired — written to `.orchestrator/metrics/learnings.jsonl`

### Next Session Recommendations
- Priority: [what should be tackled next]
- Type: [housekeeping/feature/deep recommended]
- Notes: [any context for next session]
```

> **Test-delta anchor:** the `Δ this session` figures are aggregated from the `test_delta` field of this session's agent reports (added / removed / consolidated test cases); the `tests:src LOC ratio` is `wc -l` over `tests/` divided by `wc -l` over `scripts/` + `hooks/`. A bare `passing/total` count is not a progress signal — a growing suite reads as progress even when the growth is redundant, which is exactly why the delta and the ratio are reported alongside it. When the ratio exceeds the advisory ceiling, recommend that the NEXT session's Quality wave run as a **consolidation wave**: no new test lands without a redundant one being removed in the same change. This is advisory only — it never blocks the close.

> **Documentation Coverage anchor:** If Phase 3.2 ran and produced task verification results (i.e. `docs-orchestrator.enabled: true` and `docs-tasks` were found), the results appear here as a `### Documentation Coverage (docs-orchestrator)` subsection emitted by Phase 3.2 Step 7. The content is written dynamically — it is not pre-populated in this template. When `docs-orchestrator.enabled` is `false` or `docs-tasks` were absent, this subsection is omitted entirely.
