---
tier: always
review-date: 2026-10-25
---

# Test Value Over Test Volume (Always-on)

Apply with `build-value.md` inside implementation waves: tests must catch a bug the existing suite misses.

## TV-001: The Core Question (before writing any test)
Name that concrete bug; otherwise do NOT write the test. Report `no-tests-needed: <reason>` as SUCCESS, not a gap, even if the task says "add tests".

## TV-002: Deletion Is a Feature
Without approval ceremony, MAY delete/consolidate tests that fail TV-001, duplicate covered behaviour, or pin Markdown prose/structure. Record `test_delta.removed`; negative delta is valid.

## TV-003: Budget Corridor (advisory)
Target tests:src LOC ≤1.60. Above it, the next Quality wave is CONSOLIDATION: no new test without removing a redundant one. This bounds volume only; the 70% coverage floor (`testing.md` § Coverage Enforcement) still binds. Removing worthless tests may legitimately lower coverage; report removals/reasons, do not treat that drop alone as regression.

Use `scripts/lib/tests-src-ratio.mjs`, never hand-derive the ratio:
- `node scripts/lib/tests-src-ratio.mjs --json`: cite numerator, denominator, ratio, globs and dirty flag.
- `node scripts/lib/tests-src-ratio.mjs --check`: exit 1 means consolidation required, not a blocking build gate.

Measurement: tracked JS/TS excluding `*.d.ts`, physical lines including blanks/comments; numerator under `tests/` or `__tests__/`, or named `*.test.*`/`*.spec.*`; denominator all other tracked code. Reproducible at a SHA only on a clean tree (`dirty` flag). Corridor, never a bidirectional ratchet: do not block deletion, force unnamed compensating cuts, or game the ratio by adding production LOC.

## TV-004: Duplication Check Before Writing
First `rg "<function-or-behaviour>" tests/`; extend/parametrize existing coverage instead of sibling cases or near-duplicate files.

## TV-005: Where Bugs Are Actually Caught
Prefer in order: wiring/contract tests with real production call shape; golden fixtures from real production records (`testing.md` § Fixtures Mirror Production Data); repo-wide lint/AST gates for structural invariants. Unit-test volume is last resort.

## See Also
testing.md · verification-before-completion.md · receiving-review.md · development.md
