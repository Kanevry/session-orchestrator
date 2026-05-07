---
globs:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/*Tests*"
  - tests/**
  - "**/WalkAITalkieTests/**"
---

# Test Quality Rules (Path-scoped)

These rules prevent false-positive tests — tests that pass but don't verify meaningful behavior. They apply to all languages (TypeScript, Swift) across the ecosystem.

## The Core Question

Before writing any test, ask: **"Would this test fail if I introduced a bug?"** If the answer is no, the test is worthless. Don't write it.

## Mandatory Requirements

- Every test function MUST have ≥1 meaningful assertion (`expect()`, `#expect`, `#require`).
- Tests MUST test **behavior** (what the system does), NOT **implementation** (how it does it).
- Tests MUST NOT have branching logic (no `if`, `switch`, ternary, or loops inside tests). Cyclomatic complexity = 1.
- Expected values MUST be hardcoded literals, NOT computed in the test. Computing the expected value mirrors the production logic — bugs survive in both.
- Assertions MUST be specific: `toEqual` > `toContain` > `toBeTruthy`. No `||` in assertions.

## Banned Anti-Patterns

### 1. Assert-Nothing
Test body has no assertion. Just calling a function and not crashing is NOT a test.
```
// BAD: no assertion
@Test func engineStartsWithoutCrash() {
    let engine = Engine()
    engine.start()  // ← proves nothing
}

// GOOD: asserts observable state change
@Test func engineStartSetsRunningState() {
    let engine = Engine()
    engine.start()
    #expect(engine.state == .running)
}
```

### 2. Test-the-Mock
Mock is configured and queried, but the system-under-test is never exercised. The test only proves the mock works.
```
// BAD: tests mock setup, not system
test("fetches data", () => {
  const mock = vi.fn().mockReturnValue({ id: 1 });
  expect(mock()).toEqual({ id: 1 });  // ← only tests vi.fn()
});

// GOOD: system-under-test calls the mock
test("service fetches user by id", async () => {
  const mockDB = vi.fn().mockResolvedValue({ id: 1, name: "Test" });
  const service = new UserService(mockDB);
  const user = await service.getUser(1);
  expect(user.name).toBe("Test");
  expect(mockDB).toHaveBeenCalledWith(1);
});
```

### 3. Tautological Computation
Expected value is computed using the same logic as production code. If the production logic has a bug, the test has the same bug.
```
// BAD: replicates production formula
test("calculates tax", () => {
  const price = 100;
  const taxRate = 0.20;
  const expected = price * taxRate;  // ← same formula as production
  expect(calculateTax(price, taxRate)).toBe(expected);
});

// GOOD: hardcoded expected value
test("calculates 20% tax on 100", () => {
  expect(calculateTax(100, 0.20)).toBe(20);
});
```

### 4. Implementation Mirror
Test replicates the production code structure. If you change the implementation, the test breaks — even if behavior is correct.
```
// BAD: mirrors internal branching
@Test func discountApplied() {
    let amount = 150.0
    let expected = amount > 100 ? amount * 0.9 : amount  // ← mirrors code
    #expect(calculateDiscount(amount) == expected)
}

// GOOD: tests input → output contract
@Test func discountAppliedOver100() {
    #expect(calculateDiscount(150) == 135)
}
```

### 5. Overly-Generous Assertion
Assertion is too loose to catch regressions. Accepts almost any value.
```
// BAD: almost anything passes
expect(result).toBeTruthy();
expect(result.length).toBeGreaterThan(0);
expect(status == .success || status == .pending);  // ← which one?

// GOOD: specific expected values
expect(result).toEqual({ id: 1, name: "Test" });
expect(result).toHaveLength(3);
#expect(status == .success)
```

### 6. Getter/Setter Test
Tests only that property assignment works. This is testing the language, not your code.
```
// BAD: tests Swift/TS property storage
@Test func toggleModeProperty() {
    let manager = Manager()
    #expect(manager.isEnabled == false)
    manager.isEnabled = true
    #expect(manager.isEnabled == true)  // ← tests var assignment
}

// DON'T WRITE THIS. Only test properties if they trigger side effects.
```

### 7. Happy-Path-Only
Functions that can fail must have at least one error/edge case test alongside the happy path.
```
// INCOMPLETE: only tests success
test("parses JSON", () => {
  expect(parse('{"a":1}')).toEqual({ a: 1 });
});

// COMPLETE: includes error case
test("parses valid JSON", () => {
  expect(parse('{"a":1}')).toEqual({ a: 1 });
});
test("throws on invalid JSON", () => {
  expect(() => parse("not json")).toThrow();
});
```

## Quality Checklist (Apply Before Writing Every Test)

1. **Bug detection**: Would this test catch a real bug? If not, don't write it.
2. **Behavior vs implementation**: Am I testing what the system does, or how it does it?
3. **Assertion specificity**: Is the assertion tight enough to catch regressions?
4. **Duplication**: Does another test already cover this behavior?
5. **Error paths**: If this function can fail, do I test the failure case?
6. **Mock usage**: Do I assert on how the SUT uses the mock, not just that the mock exists?

## Server Action Envelope Assertions (BE-012)

Tests that exercise wrapped server actions MUST assert on the shape of the envelope's `data` or `error` fields — **not just the `success` boolean**. Checking only `result.success === true` lets the silent-pass bug through: if the inner action returned `{ success: false, ... }` and the wrapper bundled it as `{ success: true, data: { success: false, ... } }`, a boolean-only assertion passes green while production fails.

```ts
// BAD: boolean-only — passes even when `data` is itself a nested error envelope
test("createInvoice succeeds", async () => {
  const result = await createInvoice(valid);
  expect(result.success).toBe(true);
});

// GOOD: asserts on data shape + negative path
test("createInvoice returns invoice on success", async () => {
  const result = await createInvoice(valid);
  expect(result).toEqual({ success: true, data: expect.objectContaining({ id: expect.any(String) }) });
});
test("createInvoice returns VALIDATION_ERROR on bad input", async () => {
  const result = await createInvoice(invalid);
  expect(result).toEqual({ success: false, error: expect.objectContaining({ code: "VALIDATION_ERROR" }) });
});
```

See `backend.md` BE-012 for the wrapper contract the test must verify against.

## When NOT to Write Tests

- Trivial getters/setters with no side effects
- Framework internals (SwiftUI rendering, Next.js routing)
- Enum case counts or raw values (these are compile-time guarantees)
- Hardcoded catalog data (product IDs, display names) — changes require updating both code and test
  → *Exception: see "Dynamic Artifact Counts" below for the floor/ceiling carve-out*

## Dynamic Artifact Counts — Floor/Ceiling Carve-Out

The "don't pin counts to catalog data" guidance above applies to **static reference data** (product IDs, enum display names, fixed category lists). **Dynamic artifact counts** — generated files, indexed schemas, exported skills, registered handlers — require a different pattern.

### The Problem
Tests that assert exact counts of growing artifacts drift predictably. S55 (commit `0a95cc6`) bumped a BATS skill count 28→29. S68 (issue #185, commit `6d9d6d2`) bumped the same test 29→30 then refactored to floor/ceiling. S73 hit the pattern again in zod-schemas (`exports.test.ts` 8→9, `index.test.ts` +3/+3). Each occurrence cost a session-cycle to diagnose and patch.

### The Rule
For tests asserting the count of a dynamically-grown artifact set, use floor/ceiling range assertions instead of exact equality.

```bash
# BAD — pinned count, drifts on every catalog growth
assert_equal "$count" 29

# GOOD — floor/ceiling, allows growth, still catches accidental loops
assert_greater_or_equal "$count" 20
assert_less_or_equal    "$count" 100
```

```typescript
// BAD
expect(Object.keys(zodSchemaExports)).toHaveLength(42);

// GOOD
const exportCount = Object.keys(zodSchemaExports).length;
expect(exportCount).toBeGreaterThanOrEqual(20);
expect(exportCount).toBeLessThanOrEqual(500);
```

### When to Apply
- Artifact counts that WILL grow: exported schemas, available skills, registered handlers, plugin counts, generated files
- The floor still catches accidental deletions (count drops below floor → fail)
- The ceiling catches accidental loops (count balloons → fail)
- Teammates can grow the catalog without test edits

### Floor/Ceiling Selection
- **Floor:** ~60-80% of current value if stable, or current value if growth is volatile
- **Ceiling:** 2-5× the current value depending on growth velocity

### See Also
- S55 commit `0a95cc6` (1st occurrence — generate-tool-registry skill count drift)
- S68 #185 commit `6d9d6d2` (2nd — same test, refactored to floor/ceiling)
- S73 (3rd — zod-schemas exports.test.ts + index.test.ts)
- learning `count-drift-recurrence` in `.orchestrator/metrics/learnings.jsonl` (confidence 0.9)

## See Also
development.md · security.md · security-web.md · security-compliance.md · testing.md · frontend.md · backend.md · backend-data.md · infrastructure.md · swift.md · mvp-scope.md · cli-design.md · parallel-sessions.md · ai-agent.md
