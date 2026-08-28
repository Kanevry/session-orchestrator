<!-- source: session-orchestrator plugin (canonical: rules/always-on/test-value.md) -->
# Test Value Over Test Volume (Always-on)

A test earns its place by catching a bug the existing suite would miss. Volume is a cost, not an achievement. This rule is always-on because the "write this test / don't" decision is made in implementation work, where path-scoped testing rules are not loaded.

## TV-001: The Core Question (before writing any test)

Name the concrete bug this test would catch that the existing suite does not. If you cannot name it, do NOT write the test — report `no-tests-needed: <reason>` instead. That report is a SUCCESS outcome, not a gap.

## TV-002: Deletion Is a Feature

A test MAY be deleted or consolidated without approval ceremony when it (a) fails TV-001's falsification check, (b) duplicates behaviour another test already covers, or (c) pins the prose or structure of documentation (`.md` content assertions). Count removals in your reported test delta — a negative test delta is a valid, reportable result.

## TV-003: Budget Corridor (advisory)

Target a tests:src LOC ratio of ≤ 1.60. Above that ceiling, the next quality pass is a CONSOLIDATION pass: no new test lands without removing a redundant one. The corridor bounds test VOLUME only — the project's coverage floor is unchanged and still binds.

**Measure the ratio with a script, never by hand.** While the recipe lived only in prose, six numbers for the one metric were in simultaneous circulation, differing only in which files each measurer chose to count. A threshold steered by six numbers is steered blind. Pin the recipe in code and cite its output: **numerator = tracked code under the test directory; denominator = every other tracked code file** (src by negation, so a new top-level directory is counted the moment it is committed), counting physical lines including blanks and comments. The number is reproducible at a SHA only when the working tree is clean.

The ceiling is derived from measurement, not aspiration. An unreachable ceiling only manufactures standing deletion pressure with no nameable target per file — the precise thing TV-001 and TV-002 forbid. The consolidation rule above is the operative instrument; the ratio is merely the trigger that switches it on.

**Corridor, not ratchet — deliberately.** A bidirectional ratchet (baseline the current value; fail the build on any worsening AND on any un-banked improvement) fails three ways: (a) the un-banked-improvement half turns deleting worthless tests — which TV-002 calls a *feature* — into a build break; (b) the worsening half forces a compensating deletion with no nameable target per file the moment a legitimate new test lands; and (c) a ratchet on a *ratio* is satisfiable by adding production LOC, an incentive that catches no bug. What this rule needs is a trustworthy number, not a tripwire — so the ratio check reports the consolidation trigger and is not wired into a blocking gate.

## TV-004: Duplication Check Before Writing

Grep for an existing test of the same behaviour first. Extend or parametrize that test instead of adding a sibling case or a near-duplicate file.

## TV-005: Where Bugs Are Actually Caught

Measured across a multi-repo fleet: of 27 escaped bugs, 0 were caught by the unit-test corpus and 9 by a review panel. Prefer, in this order: wiring/contract tests exercising the real production call shape; golden fixtures derived from real production records; lint/AST gates for structural invariants, which hold repo-wide where a test holds for one case. Unit-test volume is the last resort, not the first.

## Anti-Patterns

- Writing a test because the task said "add tests", with no nameable bug (TV-001).
- Asserting that a sentence is present in a `.md` file — that pins prose, not behaviour (TV-002c).
- Treating a coverage drop caused by DELETING worthless tests as a regression (TV-003).

## See Also

build-value.md · verification-before-completion.md · receiving-review.md · npm-quality-gates.md
