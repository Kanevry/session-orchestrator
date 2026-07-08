# Plan: Fixture reference plan (write-executable-plan test fixture)
Source: test fixture — structural stand-in for the dogfood reference plan
Created: 2026-07-08
Status: fixture (the original 927-line dogfood plan, "Superpowers-adoption cluster"
(#35; archived in the private Meta-Vault), exercised the same Task/Files/
placeholder-linter shape at full length — this fixture reproduces that shape
at a fraction of the size so the test suite does not depend on an archived doc)

## Summary

Minimal structural fixture exercising the same Task-section / Files-heading /
placeholder-linter assertions the full dogfood reference plan exercised,
without importing 900+ lines of retrospective plan text into the test suite.

## Files (whole-plan)

- Create:
  - tests/fixtures/write-executable-plan/reference-plan.md
- Test:
  - tests/skills/write-executable-plan.test.mjs

---

## Task 1: Fixture step one

Owner: code-implementer
Estimated: 1 min

### Files

- Create: fixture-a.md
- Modify: (none)
- Test: fixture-a.test.mjs

### Step 1: Write the failing test

File: `fixture-a.test.mjs`

```js
// This fenced code block intentionally contains the forbidden placeholder
// tokens the Phase 4 linter rejects, as quoted string literals — proving
// the plan's fenced-code-block stripping still works correctly (a
// regression that stopped stripping code blocks would make these tokens
// visible outside a code block and flip the "placeholder linter" tests red).
const forbiddenTokens = ['TBD', 'TODO', 'FIXME', 'XXX', '<placeholder>'];
const bannedPhrases = [
  'add appropriate error handling',
  'similar to Task N',
  'same as above',
];
```

Why: exercises the placeholder linter without leaving forbidden tokens live
outside a fenced code block.

### Step 2: Run to confirm failure

Command: `npm test -- fixture-a.test.mjs`

### Step 3: Implement

Files:
- Create: `fixture-a.md` — minimal fixture body

### Step 4: Run to verify pass

Command: `npm test -- fixture-a.test.mjs` (same as Step 2)

### Step 5: Commit

Message:
```
feat(fixture): add fixture task one
```

Files staged: fixture-a.md, fixture-a.test.mjs

---

## Task 2: Fixture step two

Owner: code-implementer
Estimated: 1 min

### Files

- Create: fixture-b.md
- Modify: (none)
- Test: fixture-b.test.mjs

### Step 1: Write the failing test

File: `fixture-b.test.mjs` — asserts fixture-b.md exists and is non-empty.

### Step 2: Run to confirm failure

Command: `npm test -- fixture-b.test.mjs`

### Step 3: Implement

Files:
- Create: `fixture-b.md` — minimal fixture body

### Step 4: Run to verify pass

Command: `npm test -- fixture-b.test.mjs` (same as Step 2)

### Step 5: Commit

Message:
```
feat(fixture): add fixture task two
```

Files staged: fixture-b.md, fixture-b.test.mjs

---

## Task 3: Fixture step three

Owner: code-implementer
Estimated: 1 min

### Files

- Create: fixture-c.md
- Modify: (none)
- Test: fixture-c.test.mjs

### Step 1: Write the failing test

File: `fixture-c.test.mjs` — asserts fixture-c.md exists and is non-empty.

### Step 2: Run to confirm failure

Command: `npm test -- fixture-c.test.mjs`

### Step 3: Implement

Files:
- Create: `fixture-c.md` — minimal fixture body

### Step 4: Run to verify pass

Command: `npm test -- fixture-c.test.mjs` (same as Step 2)

### Step 5: Commit

Message:
```
feat(fixture): add fixture task three
```

Files staged: fixture-c.md, fixture-c.test.mjs

---

## Task 4: Fixture step four

Owner: code-implementer
Estimated: 1 min

### Files

- Create: fixture-d.md
- Modify: (none)
- Test: fixture-d.test.mjs

### Step 1: Write the failing test

File: `fixture-d.test.mjs` — asserts fixture-d.md exists and is non-empty.

### Step 2: Run to confirm failure

Command: `npm test -- fixture-d.test.mjs`

### Step 3: Implement

Files:
- Create: `fixture-d.md` — minimal fixture body

### Step 4: Run to verify pass

Command: `npm test -- fixture-d.test.mjs` (same as Step 2)

### Step 5: Commit

Message:
```
feat(fixture): add fixture task four
```

Files staged: fixture-d.md, fixture-d.test.mjs

---

## Task 5: Fixture step five

Owner: code-implementer
Estimated: 1 min

### Files

- Create: fixture-e.md
- Modify: (none)
- Test: fixture-e.test.mjs

### Step 1: Write the failing test

File: `fixture-e.test.mjs` — asserts fixture-e.md exists and is non-empty.

### Step 2: Run to confirm failure

Command: `npm test -- fixture-e.test.mjs`

### Step 3: Implement

Files:
- Create: `fixture-e.md` — minimal fixture body

### Step 4: Run to verify pass

Command: `npm test -- fixture-e.test.mjs` (same as Step 2)

### Step 5: Commit

Message:
```
feat(fixture): add fixture task five
```

Files staged: fixture-e.md, fixture-e.test.mjs

---

## Task 6: Fixture step six

Owner: code-implementer
Estimated: 1 min

### Files

- Create: fixture-f.md
- Modify: (none)
- Test: fixture-f.test.mjs

### Step 1: Write the failing test

File: `fixture-f.test.mjs` — asserts fixture-f.md exists and is non-empty.

### Step 2: Run to confirm failure

Command: `npm test -- fixture-f.test.mjs`

### Step 3: Implement

Files:
- Create: `fixture-f.md` — minimal fixture body

### Step 4: Run to verify pass

Command: `npm test -- fixture-f.test.mjs` (same as Step 2)

### Step 5: Commit

Message:
```
feat(fixture): add fixture task six
```

Files staged: fixture-f.md, fixture-f.test.mjs
