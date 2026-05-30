---
globs:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/*Tests*"
  - tests/**
  - vitest.config.*
  - playwright.config.*
  - "**/WalkAITalkieTests/**"
---

# Testing Rules (Path-scoped)

## Framework Standards
- **Unit/Integration:** Vitest (v4+) with `happy-dom` or `jsdom` environment.
- **E2E:** Playwright for browser testing.
- **Swift:** Swift Testing framework (NOT XCTest for new code).
- **Coverage:** V8 provider. Minimum 70% globally, higher for critical paths.
- **Default test timeout:** `testTimeout: 10_000` in every `vitest.config.ts`. Override per-test with `{ timeout }` option when needed.

## Test Patterns
- Co-locate tests with source: `my-module.ts` → `my-module.test.ts`
- Name tests descriptively: `it("should return 401 when token is expired")`
- Arrange-Act-Assert pattern. One assertion focus per test.
- Mock external services, never real APIs in unit tests.
- Use `vi.mock()` for module mocking, `vi.spyOn()` for partial mocking.

## Integration Test Patterns
- Use `supertest` for HTTP endpoint testing in Express services.
- Test the full middleware chain: auth → validation → handler → response.
- Database tests: use a dedicated test database or Supabase local dev (`supabase start`).
- Seed test data with factories (`@your-org/testing-utils` `createFactory`/`createUserFactory`).
- Clean up test data after each test (`afterEach` or transaction rollback).
- Test error responses: verify status codes, error shapes, and that internal details are not leaked.
- API contract tests: validate response bodies against Zod schemas.
- Mock external services (Stripe, Sentry, AI APIs) — never call real APIs in integration tests.
- Use `@your-org/testing-utils` `createMockSupabase` for Supabase client mocking.

## Server Action Testing

### Mocking `requireAuth()`
- Mock the auth boundary at module level: `vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }))`.
- Default mock return: `{ user: { id: 'test-user-id', email: 'test@example.com' }, businessId: 'test-biz-id', supabase: createMockSupabase() }`.
- Test unauthenticated: `vi.mocked(requireAuth).mockRejectedValue(new Error('Unauthorized'))`.
- Reset mocks in `beforeEach` to prevent state leakage.

### Testing Response Envelopes
- Server actions return `{ success: true, data }` or `{ success: false, error }`.
- Test both paths explicitly: verify `success` boolean, `data` shape on success, `error` message on failure.
- Use Zod schema validation on response: `expect(() => ResponseSchema.parse(result)).not.toThrow()`.

### Testing Zod Validation
- Test with valid inputs (happy path).
- Test with missing required fields: expect `{ success: false, error: 'Validation failed' }`.
- Test with wrong types (string where number expected, too-short strings).
- Test boundary values (min/max length, empty strings, special characters).
- **Property-based testing:** Use `@fast-check/vitest` + `fast-check` for schema invariant testing. Key patterns:
  - `fcTest.prop([fc.anything()])('schema.safeParse never throws', (input) => expect(() => schema.safeParse(input)).not.toThrow())`
  - Generate valid inputs from schema constraints and verify roundtrip parsing.
  - See `packages/zod-schemas/src/property.test.ts` for reference implementation.

### Error Boundary Integration
- Test that server action errors don't crash the page: wrap in `try/catch` at the component level.
- Verify error responses are user-friendly (no internal details leaked).
- Test concurrent action calls don't interfere with each other.

### IDOR Testing Patterns
- Test that users cannot access resources belonging to other users/businesses by manipulating IDs in requests.
- Verify every data-fetching server action scopes queries to `businessId` from `requireAuth()`, not from client params.
- Test horizontal privilege escalation: call actions with valid auth but with IDs belonging to a different tenant.
- Test vertical privilege escalation: call admin-only actions with non-admin auth tokens. Expect 403.

## What Must Be Tested
- All server actions (auth + validation + happy path + error path).
- All Zod schemas (valid + invalid inputs).
- Business logic (calculations, state transitions, permissions).
- Edge cases: empty arrays, null values, boundary conditions, Unicode.

### Testing Typed Errors (AppError)
- Test error class instantiation: `expect(new AppError('Not found', 404, 'NOT_FOUND')).toBeInstanceOf(AppError)`.
- Test status codes: `expect(error.statusCode).toBe(404)`.
- Test error codes: `expect(error.code).toBe('NOT_FOUND')`.
- Test error inheritance: `expect(error).toBeInstanceOf(Error)`.
- Test serialization: verify `toJSON()` excludes stack traces in production.
- Test that internal error details are not exposed in HTTP responses.

## What Should NOT Be Tested
- UI component rendering without logic (shadcn/ui primitives).
- Framework internals (Next.js routing, Supabase client initialization).
- Simple pass-through functions with no logic.

## CI Integration
- Tests run in CI on every push.
- Parallel sharding for large test suites (Vitest `--shard`).
- Test results reported as JUnit XML for GitLab integration (`--reporter=junit --outputFile=junit.xml`).
- Coverage reported as Cobertura XML for GitLab MR diff annotations (`vitest.config.base.ts` configures `reporter: ['text', 'cobertura']`).
- Coverage regex: `/All files[^|]*\|[^|]*\s+([\d\.]+)/` extracts percentage for MR badges.
- Failed tests block merge. No exceptions.

### Shared-Hardware Runner Contention (Mac shell executors)

Shell-executor runners that share a host with an active Claude Code session can be CPU-starved when concurrent Claude processes climb past ~10. Symptom: vitest tests that pass locally in <2min hit `testTimeout` (default `10_000`) on the runner. **This is an operator/concurrency issue, not a test or code regression.** Do not treat it as a flaky-test problem and do not widen timeouts globally to paper over it.

- **Cautionary tale:** Pipeline #3940 (2026-05-14 deep-1) failed with 7 `testTimeout` fails after 34m total (test job 18.7min, gitleaks 7m58s) on the GitLab Mac runner. Same commit, same tests passed locally in <2min (4897p/11s). Local re-run of the 7 failing tests: 90/90 green. Resource probe at session-start showed 14 Claude processes — well above the `concurrent-sessions-warn=5` threshold.
- **Diagnostic signal:** if local `npm test` is green and CI fails only with `testTimeout` (not assertion failures), check the host's Claude-process count before re-running:
  ```bash
  pgrep -fc 'claude' # count of active Claude processes on this host
  ```
  A count ≥10 against a shared shell-executor runner is the smoking gun.

**Mitigations, in order of effort:**

1. **Avoid concurrent sessions during CI runs (primary).** Do not start a new Claude Code session in this repo while a CI pipeline is in flight on the same host. The session-start resource-probe banner (threshold `concurrent-sessions-warn=5`) is the active signal — treat it as load-shedding guidance, not a passive note.
2. **Raise the per-test vitest timeout only when contention is expected:**
   ```ts
   // vitest.config.ts — ceiling for a contended Mac runner
   export default defineConfig({ test: { testTimeout: 30_000 } });
   ```
   Trade-off: real hangs take longer to surface. Do not push past `30_000` as a default.
3. **Offload heavy CI to a dedicated runner** when the pattern becomes recurring — the resource probe is the trigger, not a single failed pipeline.

What this is **NOT**: a test-quality bug. Do not retry, mark `.skip`, or widen timeout values on quiet runners to "stabilise" — that masks real perf regressions where they should be loudest.

Cross-reference: learning id `mac-gitlab-runner-cpu-starvation-under-concurrent-claude-load` in `.orchestrator/metrics/learnings.jsonl` (confidence 0.9). `/evolve` rotates the rule if the signal stops applying.

## E2E Best Practices
- Use data-testid attributes for stable selectors.
- Avoid `page.waitForTimeout()` — use `page.waitForSelector()` or `expect().toBeVisible()`.
- Test on multiple viewports: desktop (1280x720), mobile (375x667), tablet (768x1024).
- Screenshot on failure. Video on retry.

### E2E Timeout Management
- Set global timeout in `playwright.config.ts`: `timeout: 30_000` (30s per test).
- Navigation timeout: `navigationTimeout: 15_000`.
- Action timeout: `actionTimeout: 10_000` (clicks, fills).
- Expect timeout: `expect: { timeout: 5_000 }`.
- Override per-test for known slow operations: `test.slow()` doubles all timeouts.
- Never increase global timeouts to fix flaky tests — fix the root cause.

## Async & Timeout Patterns
- **WARNING:** Fake timers leak between tests if not restored. A leaked fake timer can cause unrelated tests to hang or timeout. Always restore in `afterEach`.
- Use `vi.useFakeTimers()` for time-dependent tests. Always call `vi.useRealTimers()` in `afterEach`.
- Prefer `vi.advanceTimersByTime(ms)` over `vi.runAllTimers()` for explicit control.
- For async assertions, use `expect(promise).resolves.toEqual(...)` or `expect(promise).rejects.toThrow(...)`.
- Set explicit test timeouts for slow integration tests: `it("slow test", { timeout: 10_000 }, async () => {...})`.
- Never use `setTimeout` in tests for waiting — use `vi.waitFor()` or Playwright's built-in waiting.
- Mock `Date.now()` via `vi.setSystemTime(new Date("2026-01-01"))` for deterministic date tests.
- For event-driven code, use `vi.waitFor(() => expect(spy).toHaveBeenCalled())` instead of arbitrary delays.
- Use `vi.waitFor()` for polling assertions: `await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(3))`.
- Async `beforeEach`: keep setup fast (< 100ms). Move slow setup to `beforeAll`.
- Test async error propagation: `await expect(asyncFn()).rejects.toThrow(AppError)`.
- For streams/iterators: collect chunks, assert on final result: `const chunks = []; for await (const c of stream) chunks.push(c);`.

## Coverage Enforcement
- Coverage thresholds enforced in `vitest.config.ts`:
  - `statements: 70`, `branches: 70`, `functions: 70`, `lines: 70`
- Critical paths (auth, payments, RLS): aim for 90%+.
- New code must maintain or improve coverage. Never reduce.
- Use `--coverage` flag in CI. Fail pipeline if thresholds not met.

## Accessibility Testing
- Use `@axe-core/playwright` for automated accessibility audits in E2E tests.
- Run `checkA11y()` on every page and major component state (open dialogs, error states, loaded data).
- CI: include accessibility checks in the E2E pipeline. Fail on critical/serious violations.
- Manual checklist: keyboard navigation, screen reader (VoiceOver), high contrast mode, zoom to 200%.
- Test focus management: after route changes, modals, and dynamic content updates.
- Validate color contrast programmatically with axe-core. Override only with documented WCAG exceptions.
- Integrate with Playwright: `import AxeBuilder from '@axe-core/playwright'; const results = await new AxeBuilder({ page }).analyze();`
- Report violations as JUnit artifacts alongside test results.

### Reusable A11y Fixture
- Use the Playwright fixture from `templates/nextjs-saas/tests/a11y.fixture.ts.template` for shared `makeAxeBuilder()` setup.
- Scope to WCAG 2.1 AA with `.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])`.
- Smoke test pattern: iterate key routes (`/`, `/login`, `/dashboard`), fail on critical/serious violations.
- Attach full results as JSON artifacts for debugging: `testInfo.attach('a11y-results', { body: JSON.stringify(results), contentType: 'application/json' })`.

## Performance Tests
- k6 for load testing on API endpoints.
- Benchmark critical paths (invoice generation, PDF export, AI calls).
- Set baseline metrics. Alert on regression > 20%.

## AI & Agent Testing Patterns

### LLM Response Mocking
- Mock AI SDK responses at the provider level, never at the network level.
- Use `vi.mock('ai')` or `vi.mock('@anthropic-ai/sdk')` to intercept model calls.
- Return deterministic responses with fixed content, token counts, and finish reasons.
- Pattern for Vercel AI SDK:
  ```typescript
  vi.mock('ai', () => ({
    generateText: vi.fn().mockResolvedValue({
      text: 'Mocked response',
      usage: { promptTokens: 10, completionTokens: 20 },
      finishReason: 'stop',
    }),
  }));
  ```
- For streaming: mock `streamText` to return an async iterable with predetermined chunks.
- Never call real LLM APIs in unit or integration tests — cost, latency, and non-determinism.

### Agent Test Patterns
- **Action tests**: Call `action.validate()` and `action.handler()` directly with mock context. Assert return shape and side effects.
- **Provider tests**: Call `provider.get()` with known state. Assert returned context matches expectations.
- **Evaluator tests**: Feed `evaluator.evaluate()` a canned response. Assert memory/state updates.
- **Plugin integration**: Register plugin, trigger a full agent loop with mocked model. Assert action selection and execution order.
- Isolate each component — never test actions through the full agent runtime in unit tests.

### Deterministic Testing
- Set `temperature: 0` and fixed `seed` in test model configs for reproducible outputs.
- Use snapshot testing for prompt templates: `expect(buildPrompt(context)).toMatchSnapshot()`.
- Pin model versions in test configs (e.g., `claude-sonnet-4-20250514`) — model updates should not break tests.
- For non-deterministic outputs: assert structure and constraints, not exact content.
  ```typescript
  const result = await agent.run('Summarize this document');
  expect(result.text.length).toBeGreaterThan(50);
  expect(result.text.length).toBeLessThan(500);
  expect(result.usage.totalTokens).toBeLessThan(1000);
  ```

### Token Budget Testing
- Verify context composition stays within token budget.
- Test with edge cases: empty context, maximum context, single oversized document.
- Assert that prompt + context + reserved response tokens never exceed model limit.
- Pattern: `expect(countTokens(composedPrompt)).toBeLessThan(MODEL_MAX_TOKENS * 0.7)`.

## Test Quality — False-Positive Prevention (#445 merged from test-quality.md)

These rules prevent false-positive tests — tests that pass but don't verify meaningful behavior. They apply to all languages (TypeScript, Swift) across the ecosystem.

### The Core Question

Before writing any test, ask: **"Would this test fail if I introduced a bug?"** If the answer is no, the test is worthless. Don't write it.

### Mandatory Requirements

- Every test function MUST have ≥1 meaningful assertion (`expect()`, `#expect`, `#require`).
- Tests MUST test **behavior** (what the system does), NOT **implementation** (how it does it).
- Tests MUST NOT have branching logic (no `if`, `switch`, ternary, or loops inside tests). Cyclomatic complexity = 1.
- Expected values MUST be hardcoded literals, NOT computed in the test. Computing the expected value mirrors the production logic — bugs survive in both.
- Assertions MUST be specific: `toEqual` > `toContain` > `toBeTruthy`. No `||` in assertions.

### Banned Anti-Patterns

#### 1. Assert-Nothing
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

#### 2. Test-the-Mock
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

#### 3. Tautological Computation
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

#### 4. Implementation Mirror
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

#### 5. Overly-Generous Assertion
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

#### 6. Getter/Setter Test
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

#### 7. Happy-Path-Only
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

### Quality Checklist (Apply Before Writing Every Test)

1. **Bug detection**: Would this test catch a real bug? If not, don't write it.
2. **Behavior vs implementation**: Am I testing what the system does, or how it does it?
3. **Assertion specificity**: Is the assertion tight enough to catch regressions?
4. **Duplication**: Does another test already cover this behavior?
5. **Error paths**: If this function can fail, do I test the failure case?
6. **Mock usage**: Do I assert on how the SUT uses the mock, not just that the mock exists?

### Server Action Envelope Assertions (BE-012)

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

### When NOT to Write Tests

- Trivial getters/setters with no side effects
- Framework internals (SwiftUI rendering, Next.js routing)
- Enum case counts or raw values (these are compile-time guarantees)
- Hardcoded catalog data (product IDs, display names) — changes require updating both code and test
  → *Exception: see "Dynamic Artifact Counts" below for the floor/ceiling carve-out*

### Dynamic Artifact Counts — Floor/Ceiling Carve-Out

The "don't pin counts to catalog data" guidance above applies to **static reference data** (product IDs, enum display names, fixed category lists). **Dynamic artifact counts** — generated files, indexed schemas, exported skills, registered handlers — require a different pattern.

#### The Problem
Tests that assert exact counts of growing artifacts drift predictably. S55 (commit `0a95cc6`) bumped a BATS skill count 28→29. S68 (issue #185, commit `6d9d6d2`) bumped the same test 29→30 then refactored to floor/ceiling. S73 hit the pattern again in zod-schemas (`exports.test.ts` 8→9, `index.test.ts` +3/+3). Each occurrence cost a session-cycle to diagnose and patch.

#### The Rule
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

#### When to Apply
- Artifact counts that WILL grow: exported schemas, available skills, registered handlers, plugin counts, generated files
- The floor still catches accidental deletions (count drops below floor → fail)
- The ceiling catches accidental loops (count balloons → fail)
- Teammates can grow the catalog without test edits

#### Floor/Ceiling Selection
- **Floor:** ~60-80% of current value if stable, or current value if growth is volatile
- **Ceiling:** 2-5× the current value depending on growth velocity

#### Carve-Out See Also
- S55 commit `0a95cc6` (1st occurrence — generate-tool-registry skill count drift)
- S68 #185 commit `6d9d6d2` (2nd — same test, refactored to floor/ceiling)
- S73 (3rd — zod-schemas exports.test.ts + index.test.ts)
- learning `count-drift-recurrence` in `.orchestrator/metrics/learnings.jsonl` (confidence 0.9)

## See Also
development.md · security.md · security-web.md · frontend.md · backend.md · backend-data.md · swift.md · mvp-scope.md · cli-design.md · parallel-sessions.md · verification-before-completion.md · receiving-review.md
