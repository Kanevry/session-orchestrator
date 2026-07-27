---
tier: always
review-date: 2026-10-25
---

# Test Value Over Test Volume (Always-on)

A test earns its place by catching a bug the existing suite would miss. Volume is a cost, not an achievement. This rule is always-on because the "write this test / don't" decision is made in implementation waves, where the path-scoped `testing.md` is not injected.

## TV-001: The Core Question (before writing any test)

Name the concrete bug this test would catch that the existing suite does not. If you cannot name it, do NOT write the test — report `no-tests-needed: <reason>` instead. That report is a SUCCESS outcome, not a gap.

## TV-002: Deletion Is a Feature

A test MAY be deleted or consolidated without approval ceremony when it (a) fails TV-001's falsification check, (b) duplicates behaviour another test already covers, or (c) pins the prose or structure of documentation (`.md` content assertions). Count removals in `test_delta.removed` — a negative test delta is a valid, reportable result.

## TV-003: Budget Corridor (advisory)

Target a tests:src LOC ratio of ≤ 1.2. Above that ceiling, the next Quality wave is a CONSOLIDATION wave: no new test lands without removing a redundant one. The corridor bounds test VOLUME only — the 70% coverage floor (`testing.md` § Coverage Enforcement) is unchanged and still binds.

## TV-004: Duplication Check Before Writing

Grep for an existing test of the same behaviour first (`rg "<function-or-behaviour>" tests/`). Extend or parametrize that test instead of adding a sibling case or a near-duplicate file.

## TV-005: Where Bugs Are Actually Caught

Fleet evidence (2026-07: 27 escaped bugs — 0 caught by the unit-test corpus, 9 by the review panel). Prefer, in this order: wiring/contract tests exercising the real production call shape; golden fixtures derived from real production records (`testing.md` § Fixtures Mirror Production Data); lint/AST gates for structural invariants, which hold repo-wide where a test holds for one case. Unit-test volume is the last resort, not the first.

## Anti-Patterns

- Writing a test because the task said "add tests", with no nameable bug (TV-001).
- Asserting that a sentence is present in a `.md` file — that pins prose, not behaviour (TV-002c).
- Treating a coverage drop caused by DELETING worthless tests as a regression (TV-003).

## See Also
testing.md · verification-before-completion.md · receiving-review.md · development.md
