# MVP Scope & Appetite Rules (Always-on)

## Appetite System (Shape Up)
- Small Batch: 1 week max. Single feature, single deliverable.
- Medium Batch: 2 weeks max. Feature set, clear boundary.
- Big Batch: 6 weeks max. Never longer. If it takes more, re-scope.
- Cooldown after each batch: Small 2 days, Medium 3 days, Big 2 weeks. For tech debt, bugs, exploration.
- Circuit Breaker: Ship-or-kill after Hard Deadline. No extensions. Unfinished work goes to backlog for re-shaping.

## Scope Discipline
- Every MVP must have a written MVP.md (from template) before coding starts.
- "Nice to have" features go to backlog immediately. Never in current MVP scope.
- Scope changes require explicit sign-off documented in MVP.md Scope Change Log.
- Each PR/MR must reference an MVP Scope Item (from the IN list in MVP.md).
- If a feature is not in MVP.md scope, it does not get built in this cycle.

## Definition of Done
- All items in MVP Scope (IN) checked off with acceptance criteria met.
- LAUNCH-GATE.md 5-gate checklist passed (Functionality, Security, Quality, Ops, Legal).
- No P0/P1 bugs open.
- Core user flow works end-to-end.

## Commit Message Traceability
- During an active MVP cycle, commits SHOULD include an `MVP-XXX` reference for traceability.
- Format: `feat(auth): add login flow — MVP-001` (appended after an em dash).
- The `MVP-XXX` identifier maps to the scope item number in the MVP.md IN list.
- This is a recommendation, not enforced by commitlint. Omitting it is acceptable for small fixes.
- During cooldown periods, commits do not need MVP references. Use normal Conventional Commits.
- MR/PR descriptions MUST still reference the MVP scope item (enforced by review).

## Anti-Patterns
- Scope creep: adding "just one more thing" after MVP.md is signed off.
- Gold plating: polishing beyond acceptance criteria before all scope items are done.
- Premature optimization: performance tuning before core flow works.
- Missing time-box: starting work without appetite/deadline defined.

## See Also
development.md · security.md · security-web.md · security-compliance.md · testing.md · test-quality.md · frontend.md · backend.md · backend-data.md · infrastructure.md · swift.md · cli-design.md · parallel-sessions.md · ai-agent.md
