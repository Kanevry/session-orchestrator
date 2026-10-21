---
tier: coordinator-only
review-date: 2026-10-23
---

# MVP Scope & Appetite Rules (Always-on)

## Appetite System (Shape Up)
Small: ≤1 week, single feature, single deliverable; Medium: ≤2 weeks, bounded feature set; Big: ≤6 weeks, otherwise re-scope. Cooldown after each: 2 days / 3 days / 2 weeks for debt, bugs, exploration. Hard-deadline circuit breaker: ship-or-kill, no extensions; unfinished work returns to backlog for re-shaping.

## Scope Discipline
Before coding: template-based written MVP.md plus appetite/deadline. Nice-to-haves go immediately to backlog. Build only IN-scope features this cycle; changes need explicit sign-off in MVP.md Scope Change Log. Every PR/MR MUST reference an IN-list scope item (review-enforced).

## Definition of Done
All IN items checked with acceptance criteria met; LAUNCH-GATE.md five gates passed (Functionality, Security, Quality, Ops, Legal); no open P0/P1; core flow works end-to-end.

## Commit Message Traceability
Active-cycle commits SHOULD append `— MVP-XXX` (IN-list item number), e.g. `feat(auth): add login flow — MVP-001`. Recommendation, not commitlint-enforced; small fixes may omit. Cooldown: normal Conventional Commits, no MVP reference needed. MR/PR scope-item reference remains MUST.

## Anti-Patterns
No post-signoff scope creep, polishing beyond criteria before all items finish, performance tuning before core flow works, or work without appetite/deadline.

## See Also
development.md · security.md · testing.md · cli-design.md · parallel-sessions.md
