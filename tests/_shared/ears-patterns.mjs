/**
 * tests/_shared/ears-patterns.mjs
 *
 * Single source of truth for the canonical EARS (Easy Approach to Requirements
 * Syntax) pattern names, as verified verbatim against alistairmavin.com/ears/
 * (2026-05-19, recorded in docs/adr/0005-ears-notation-plan.md § Implementation
 * Status). These literals were previously hard-coded independently across four
 * EARS test files; #492 M7 (deep-3 qa coverage-gap bundle) extracts them here so
 * a future EARS rename touches exactly one place.
 *
 * Test-only constant — deliberately NOT placed under production `skills/`.
 *
 * Spelling is load-bearing:
 *   - "Unwanted behaviour" uses UK spelling (not "behavior").
 *   - "State-driven" / "Event-driven" are hyphenated.
 *   - "Optional feature" is the full two-word phrase (not just "Optional").
 *
 * Order is load-bearing: tests/skills/write-executable-plan/ears-vitest-gen.test.mjs
 * asserts the in-table set equals this sequence via toEqual([...]).
 *
 * The 6th EARS template, "Complex", is intentionally NOT in this set: the four
 * consuming test files assert only the five primary pattern names (Complex is
 * documented in the ADR/templates as a combinator, not grepped as a row name).
 */

export const EARS_PATTERNS = Object.freeze([
  'Ubiquitous',
  'State-driven',
  'Event-driven',
  'Optional feature',
  'Unwanted behaviour',
]);
