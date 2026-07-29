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

Target a tests:src LOC ratio of ≤ 1.60. Above that ceiling, the next Quality wave is a CONSOLIDATION wave: no new test lands without removing a redundant one. The corridor bounds test VOLUME only — the 70% coverage floor (`testing.md` § Coverage Enforcement) is unchanged and still binds.

The ceiling is derived from measurement, not aspiration (2026-07-29: 190,949 test LOC / 109,494 src LOC = 1.74). Its predecessor 1.20 was unreachable: it demanded cutting 31% of the suite, where the last full test diet (`f69578f`) removed 6,716 lines — a ninth of that, and the cheap ninth. Nor is the volume where a diet would look: `tests/lib/` carries 55% of the test mass at ratio 1.30, already inside the corridor, so a blanket cut lands on the best-covered surface first. An unreachable ceiling only manufactures standing deletion pressure with no nameable target per file — the precise thing TV-001 and TV-002 forbid. The consolidation rule above is the operative instrument; the ratio is merely the trigger that switches it on.

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
