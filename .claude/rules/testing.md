---
globs:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/*Tests*"
  - tests/**
  - vitest.config.*
  - playwright.config.*
tier: wave-only
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

### Vitest Mocking Gotchas

- **`clearMocks` / `mockReset` / `restoreMocks: true` reset `vi.mock()` factory impls before EVERY test** — impls baked into the factory survive only test 1, after which `new Service()` returns `undefined` ("X is not a function"). Declare bare auto-mocks and re-apply implementations in `beforeEach` AFTER the reset. This is the superset rule for the two lines below.
- **`vi.clearAllMocks()` in `beforeEach` wipes module-level `vi.mock()` implementations** (e.g. `requireAuth`) → "Cannot read properties of undefined" on the next test. Re-establish defaults INSIDE `beforeEach` AFTER the clear, via a `setupDefaultMocks()` helper. (Qualifies "Reset mocks in `beforeEach`" below — the bare reset, taken literally, CAUSES this bug.)
- **`vi.fn().mockImplementation(() => obj)` fails when the SUT does `new ClassName()`.** Use an inline `class { method = mockFn }` so each instance gets its own bound function.
- **A `vi.mock` factory cannot close over a top-level `const`** (ReferenceError: cannot access before initialization). Wrap shared mock state in `vi.hoisted({...})` to share it with the hoisted factory body.
- **`vi.spyOn` on ESM named exports fails** with "Cannot redefine property" (e.g. `import * as fs from 'node:fs'`). Inject the failure through the real dependency instead (e.g. `chmodSync(dir, 0o555)`). Qualifies "`vi.spyOn()` for partial mocking" above.
- **Centralizing `process.env` reads behind a `@/lib/env` Zod export breaks `vi.stubEnv()`-only tests** — the module caches at load and Zod runs on `.parse()`, so `stubEnv` alone won't re-evaluate. Add `vi.resetModules()` in `beforeEach` + a dynamic `import` AFTER `stubEnv`. (Zod also rejects empty-string URLs that nullish-coalescing previously accepted.)

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
- Reset mocks in `beforeEach` to prevent state leakage — but re-establish module-level `vi.mock()` defaults AFTER the reset (see "Vitest Mocking Gotchas"), or the next test hits "Cannot read properties of undefined".

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
- **With `projects: [...]` in `vitest.config`, a bare `vitest run` (no `--project`) runs ALL projects**, ignoring per-project include/exclude tuning. Always pin `test:*` scripts to `--project <name>` and verify via the actual script, not just `vitest list`.
- **A config with `bail: N` reports only the first ~N failures** — CI may show "Failed 4" when the true count is 10+. Cross-verify a suspiciously-low CI failure count against a full local `vitest run`.
- Failed tests block merge. No exceptions.

### Shard-Time Contention & Root-as-uid-0 Hazards (Hetzner Linux Docker autoscaler)

Since the 2026-05-20 cutover, CI runs on the Hetzner Linux Docker autoscaler — an ephemeral, autoscaled `node:24` container that runs as **root (uid 0)**, tagged `[linux, hetzner-auto]`. There is no co-resident Claude Code session to count: each pipeline gets a fresh container. Symptom of contention: a shard's wall-time approaches or exceeds its inner `timeout` cap, vitest is killed before it writes the `onFinished` result JSON, and the fail-closed verifier (`scripts/ci/assert-vitest-green.mjs`) reports `ENOENT` on the missing result file. **This is an operator/concurrency/capacity issue, not a test or code regression.** Do not treat it as a flaky-test problem and do not widen the GLOBAL `testTimeout` default to paper over it.

- **Diagnostic signal:** if local `npm test` is green and a CI shard fails closed with a missing-result-file (`ENOENT`) or a killed-mid-flight error (not assertion failures), the shard ran out of wall-time under its inner `timeout` cap. Diagnose from the job log, not from a process count:
  - The `test:` job dumps a `tail -40` of the captured reporter log on failure — read it to see which files were still running at the kill.
  - The `--log=<path>` in-flight hint (`scripts/ci/assert-vitest-green.mjs` `inFlightFilesFromLog`) is BEST-EFFORT: in non-TTY CI the `❯` glyph marks failed-in-summary files, not in-progress, so the hint can be empty exactly on a true mid-flight hang. Treat a populated hint as a lead, an empty hint as "inconclusive — read the `tail -40` dump".
  - Compare the failing shard's runtime against the other shards: a single shard far over the others points at a slow/hung file, not whole-runner starvation.

**Mitigations, in order of effort:**

1. **Re-shard or raise the per-shard INNER cap with headroom (primary).** Rebalance `--shard` so no shard's worst-case runtime crowds its inner `timeout` cap, or raise that per-shard cap to sit comfortably above the observed worst-shard runtime. This is a targeted, per-shard adjustment — **NOT** a blind global timeout widen.
2. **Raise the per-test vitest timeout only when contention is genuinely expected:**
   ```ts
   // vitest.config.ts — runner-neutral ceiling for a contended runner
   export default defineConfig({ test: { testTimeout: 30_000 } });
   ```
   Trade-off: real hangs take longer to surface. Do not push past `30_000` as a default — this caveat is durable and runner-neutral (it held on the Mac executor and holds on the Hetzner autoscaler).
3. **Escalate autoscaler capacity** (more/larger instances, higher concurrency) when the pattern recurs across pipelines — a single over-cap shard is a re-shard problem; a recurring fleet-wide pattern is a capacity problem.

**Root-as-uid-0 test hazards (incident #685).** The autoscaler runs as root, which changes how filesystem-failure tests behave versus a developer's non-root box:

- **chmod-based EACCES is bypassed under root.** A test that asserts a write FAILS into a `chmod 0o500` directory passes locally (non-root) but fails on CI (root ignores the permission bits). Guard such tests with `it.skipIf(isRoot)` (or the empirical `permsEnforced()` probe) from `tests/_helpers/perms.mjs`.
- **procfs / phantom-directory paths can HANG a sync syscall as root.** `mkdirSync('/proc/nonexistent', { recursive: true })` fails fast with EACCES for non-root but HANGS the event loop synchronously as root — no `testTimeout` can interrupt a blocked sync syscall, so the whole shard stalls until the outer CI cap kills it (the #685 root cause: one such test stalled a shard >18 min → fail-closed → red pipeline). For any "writes will fail here" path, use `unwritablePath()` from `tests/_helpers/unwritable-path.mjs` — it returns `/dev/null/<sub>`, which yields a fast, uniform ENOTDIR for every uid (root and non-root alike).

What this is **NOT**: a test-quality bug. Do not retry, mark `.skip`, or widen the global timeout to "stabilise" — that masks real perf regressions where they should be loudest. (The `.skipIf(isRoot)` guard above is the opposite case — a documented, root-specific carve-out, not a stabilise-the-flake hack.)

Cross-reference: learning id `mac-gitlab-runner-cpu-starvation-under-concurrent-claude-load` in `.orchestrator/metrics/learnings.jsonl` (confidence 0.9) — **SUPERSEDED by the Hetzner Linux autoscaler reality** (Mac-historical; the shared-host `pgrep claude` signal no longer applies on the ephemeral root container). Flagged for `/evolve` rotation; kept as a historical pointer until rotated. (Footnote: the original Mac cautionary tale was pipeline #3940, 2026-05-14 — 7 `testTimeout` fails under 14 co-resident Claude processes on the old shared GitLab Mac runner.)

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

### Playwright Selector & Config Gotchas
- **`isVisible()` is synchronous and SILENTLY IGNORES its `{ timeout }` option** — it checks immediately, never waits. When you need to wait, use `locator.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)`.
- **`page.locator('text=A, text=B')` is ONE literal text search, not an OR.** Use `page.getByText(/A|B/i)` or `.or()` chaining for alternation.
- **A new spec without `testIgnore` on the default browser projects runs once PER browser (N×).** For self-authenticating journey specs, use a dedicated project + a `testMatch` regex (e.g. `/user-journeys\/journey-\d+-.*\.spec\.ts$/`) paired with a matching `testIgnore` on every default browser project.
- **A transient dual-render of a shared `data-testid` during hydration trips Playwright strict-mode.** `.first()` is the correct fix when the component ultimately renders once. DISCRIMINATOR: transient hydration dual-render → `.first()` OK; a PERSISTENT duplicate element → fix the source, don't mask it.

### Next.js Dev-Server Hydration Races (E2E)
- **Next dev/RSC can RESET controlled form values shortly after Playwright fills them during cold-start.** Use form-scoped `data-testid` selectors and verify/re-fill controlled values before submit — never a single `fill()` on a generic `input[name=…]`.
- **When a Server Action persists but its RSC client redirect aborts under next-dev (ECONNRESET), make a DB poll the HARD success signal:** `expect.poll` on row-count > a pre-submit marker, then assert a persisted invariant. Keep `page.waitForURL` SOFT in `try/catch` with a `testInfo.annotations` note on timeout.

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
- When using `Promise.race` to time out an async op, call `timer.unref()` on the `setTimeout` handle so the process exits naturally if the real promise resolves first — avoids open-handle warnings and a spurious timeout-length delay when the slow path is never taken.
- **A spawned test child that spins on a synchronous busy-wait barrier pins a CPU core** and, under runner starvation, outlives `testTimeout` and hangs the vitest forks-pool worker. Poll with an async yield (`await new Promise(r => setTimeout(r, pollMs))`) on the same deadline, give each spawn a per-spawn timeout BELOW `testTimeout`, and track + SIGKILL survivors in `afterEach`.

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

#### 8. Unfaithful Double
A fake/mock returns data or state that could never occur in production (e.g. a
fake `ownerConfig` populated with entries when the real default is empty). The
test passes against invented data and misses the bug the real state triggers.
Doubles MUST mirror a real, reachable state — verify against the actual
default/schema, not a convenient fixture.

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

See `rules/opt-in-stack/backend.md` BE-012 for the wrapper contract the test must verify against.

### Negative-Assertion Fake-Regression Check

For any "X is NOT present" assertion (drift guard, absence check), run a fake-regression in the quality gate: temporarily reintroduce X, confirm the test goes RED, then revert to green. A green test alone NEVER proves the guard bites — only a red-on-drift observation does. Critical for drift guards added in the SAME session that fixes the drift.

### Security Tests Must Not Encode the Vulnerability

A security test that asserts a permissive/success outcome for clearly-malicious input ENCODES the vulnerability as expected behaviour — fixing the bug then requires flipping the assertion. Grep security tests for `toBe(true)` near malicious / invalid / no-cookie setups (e.g. a CSRF test asserting `success: true` for a malicious-origin request that carries no CSRF cookie).

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
development.md · security.md · mvp-scope.md · cli-design.md · parallel-sessions.md · verification-before-completion.md · receiving-review.md
