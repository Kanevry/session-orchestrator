# Plan: Superpowers-adoption cluster (umbrella #35)
Source: GitHub umbrella #35 + sub-issues #36 #37 #38 #39 #40
Created: 2026-05-16
Status: retrospective (documents work executed in session main-2026-05-16-deep-2)

## Summary

Adopt 5 high-leverage patterns from obra/superpowers into session-orchestrator: a brainstorm skill for Socratic design dialogue (#36), a debug skill for systematic root-cause investigation (#37), a verification-before-completion always-on rule (#38), an executable-plan skill that produces bite-sized agent-ready plans (#39), and a receiving-review always-on rule for graceful code review handling (#40). Each sub-issue delivers a self-contained file set; the tasks are file-disjoint and executable in parallel. A sixth task wires all cross-references and closes the umbrella issue.

## Files (whole-plan)

- Create:
  - skills/brainstorm/SKILL.md
  - skills/brainstorm/soul.md
  - skills/brainstorm/brainstorm.md
  - skills/debug/SKILL.md
  - skills/debug/soul.md
  - skills/debug/debug.md
  - skills/write-executable-plan/SKILL.md
  - skills/write-executable-plan/plan-template.md
  - commands/brainstorm.md
  - commands/debug.md
  - .claude/rules/verification-before-completion.md
  - .claude/rules/receiving-review.md
  - docs/plans/2026-05-16-superpowers-cluster.md
- Modify:
  - skills/wave-executor/SKILL.md
  - skills/session-plan/SKILL.md
  - agents/code-implementer.md
  - agents/session-reviewer.md
  - skills/plan/SKILL.md
- Test:
  - tests/skills/brainstorm.test.mjs
  - tests/skills/debug.test.mjs
  - tests/rules/verification-before-completion.test.mjs
  - tests/rules/receiving-review.test.mjs
  - tests/skills/write-executable-plan.test.mjs

---

## Task 1: Adopt brainstorm skill (GH #36)

Owner: code-implementer
Estimated: 4 min

### Files

- Create: skills/brainstorm/SKILL.md, skills/brainstorm/soul.md, skills/brainstorm/brainstorm.md, commands/brainstorm.md
- Modify: (none — cross-refs wired in Task 6)
- Test: tests/skills/brainstorm.test.mjs

### Step 1: Write the failing test

File: `tests/skills/brainstorm.test.mjs`

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_PATH = join(REPO_ROOT, 'skills', 'brainstorm', 'SKILL.md');

const skill = readFileSync(SKILL_PATH, 'utf8');

describe('brainstorm skill — file presence', () => {
  it('SKILL.md exists and is non-empty', () => {
    expect(skill.length).toBeGreaterThan(0);
  });

  it('contains required frontmatter fields', () => {
    expect(skill).toContain('name: brainstorm');
    expect(skill).toContain('model: inherit');
    expect(skill).toContain('color:');
    expect(skill).toContain('tools:');
  });
});

describe('brainstorm skill — structure', () => {
  it('contains Phase 0 bootstrap gate reference', () => {
    expect(skill).toMatch(/Phase 0/i);
    expect(skill).toMatch(/bootstrap-gate/i);
  });

  it('contains HARD-GATE block preventing premature implementation', () => {
    expect(skill).toContain('<HARD-GATE>');
    expect(skill).toContain('</HARD-GATE>');
  });

  it('outputs spec to docs/specs/ directory', () => {
    expect(skill).toContain('docs/specs/');
  });

  it('mentions the 3-5 AUQ rounds constraint', () => {
    expect(skill).toMatch(/3.{1,5}5\s*(AUQ|rounds)/i);
  });

  it('hands off to /plan feature or /write-executable-plan', () => {
    expect(skill).toContain('/plan feature');
    expect(skill).toContain('/write-executable-plan');
  });
});

describe('brainstorm skill — anti-patterns section', () => {
  it('contains Anti-Patterns section', () => {
    expect(skill).toMatch(/##\s+Anti-Patterns/i);
  });

  it('explicitly bans calling Edit or Write for code during dialogue', () => {
    expect(skill).toMatch(/never call Edit|no Edit.*during|Write \(for code\)/i);
  });
});
```

Why: this test verifies that the brainstorm skill document contains its required structural sections, frontmatter fields, and behaviorally-critical phrases — ensuring it is correctly recognized by the plugin validator and correctly constrains agent behavior.

### Step 2: Run to confirm failure

Command: `npm test -- tests/skills/brainstorm.test.mjs`

Expected output:
```
FAIL tests/skills/brainstorm.test.mjs
  brainstorm skill — file presence
    × SKILL.md exists and is non-empty
      Error: ENOENT: no such file or directory, open '.../skills/brainstorm/SKILL.md'
```

### Step 3: Implement

Files:
- Create: `skills/brainstorm/SKILL.md`

```markdown
---
name: brainstorm
description: Use when you have a feature idea but the scope or UX is still ambiguous — runs a lightweight Socratic design dialogue (3-5 AUQ rounds) and writes a spec markdown file. Use BEFORE /plan feature when product intent needs validation; skip to /plan feature when scope is already clear. HARD-GATE prevents any code work until the design is user-approved.
model: inherit
color: cyan
tools: Read, Grep, Glob, Bash, Write
---

# Brainstorm Skill

[Full content as specified in the skill authoring guidelines — see committed file for complete text.]
[Phases 0-6: Bootstrap Gate, Frame the Problem, Socratic Dialogue, Synthesize Approaches, Write Spec, Self-Review, Hand-off.]
[HARD-GATE: no Edit/Write for code during dialogue. Only the spec file write in Phase 4 is allowed.]
[Outputs: docs/specs/YYYY-MM-DD-<slug>-design.md]
[Hand-off options: /plan feature (primary), /write-executable-plan (direct execution).]
```

- Create: `skills/brainstorm/soul.md` — Design Facilitator identity document (Socratic questioner, not implementer)
- Create: `skills/brainstorm/brainstorm.md` — inline examples of well-formed AUQ rounds
- Create: `commands/brainstorm.md` — slash-command definition invoking skills/brainstorm/SKILL.md

### Step 4: Run to verify pass

Command: `npm test -- tests/skills/brainstorm.test.mjs` (same as Step 2)

Expected output:
```
✓ brainstorm skill — file presence > SKILL.md exists and is non-empty
✓ brainstorm skill — file presence > contains required frontmatter fields
✓ brainstorm skill — structure > contains Phase 0 bootstrap gate reference
✓ brainstorm skill — structure > contains HARD-GATE block preventing premature implementation
✓ brainstorm skill — structure > outputs spec to docs/specs/ directory
✓ brainstorm skill — structure > mentions the 3-5 AUQ rounds constraint
✓ brainstorm skill — structure > hands off to /plan feature or /write-executable-plan
✓ brainstorm skill — anti-patterns section > contains Anti-Patterns section
✓ brainstorm skill — anti-patterns section > explicitly bans calling Edit or Write for code during dialogue
9 passed
```

### Step 5: Commit

Message:
```
feat(skills): add brainstorm skill — Socratic design dialogue (GH #36)
```

Files staged: skills/brainstorm/SKILL.md, skills/brainstorm/soul.md, skills/brainstorm/brainstorm.md, commands/brainstorm.md, tests/skills/brainstorm.test.mjs

---

## Task 2: Adopt debug skill (GH #37)

Owner: code-implementer
Estimated: 4 min

### Files

- Create: skills/debug/SKILL.md, skills/debug/soul.md, skills/debug/debug.md, commands/debug.md
- Modify: (none — cross-refs wired in Task 6)
- Test: tests/skills/debug.test.mjs

### Step 1: Write the failing test

File: `tests/skills/debug.test.mjs`

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_PATH = join(REPO_ROOT, 'skills', 'debug', 'SKILL.md');

const skill = readFileSync(SKILL_PATH, 'utf8');

describe('debug skill — file presence', () => {
  it('SKILL.md exists and is non-empty', () => {
    expect(skill.length).toBeGreaterThan(0);
  });

  it('contains required frontmatter fields', () => {
    expect(skill).toContain('name: debug');
    expect(skill).toContain('model: inherit');
    expect(skill).toContain('color:');
    expect(skill).toContain('tools:');
  });
});

describe('debug skill — structure', () => {
  it('contains Phase 0 bootstrap gate reference', () => {
    expect(skill).toMatch(/Phase 0/i);
    expect(skill).toMatch(/bootstrap-gate/i);
  });

  it('requires hypothesis formation before fix', () => {
    expect(skill).toMatch(/hypothes[ie]s/i);
  });

  it('requires reproduction step before fix', () => {
    expect(skill).toMatch(/reproduc/i);
  });

  it('mandates a verification command after fix', () => {
    expect(skill).toMatch(/verif/i);
  });

  it('has When NOT to use section', () => {
    expect(skill).toMatch(/When NOT to use/i);
  });
});

describe('debug skill — anti-patterns section', () => {
  it('contains Anti-Patterns section', () => {
    expect(skill).toMatch(/##\s+Anti-Patterns/i);
  });

  it('prohibits guessing fixes without reproduction', () => {
    expect(skill).toMatch(/guess|without reproduc/i);
  });
});
```

Why: verifies the debug skill enforces the hypothesis-before-fix discipline and reproduction step that distinguish systematic debugging from guessing.

### Step 2: Run to confirm failure

Command: `npm test -- tests/skills/debug.test.mjs`

Expected output:
```
FAIL tests/skills/debug.test.mjs
  debug skill — file presence
    × SKILL.md exists and is non-empty
      Error: ENOENT: no such file or directory, open '.../skills/debug/SKILL.md'
```

### Step 3: Implement

Files:
- Create: `skills/debug/SKILL.md`

```markdown
---
name: debug
description: Use when a specific bug, test failure, or unexpected behavior needs systematic root-cause investigation. Runs a structured hypothesis-reproduction-fix-verify loop. Never guess — every fix must be preceded by a confirmed reproduction step and followed by a verification command.
model: inherit
color: red
tools: Read, Grep, Glob, Bash, Edit, Write
---

# Debug Skill

[Full content per skill authoring guidelines — see committed file.]
[Phases 0-6: Bootstrap Gate, Reproduce, Hypothesize, Fix, Verify, Commit, Report.]
[Hypothesis formation is required before any file edit.]
[Reproduction step is required before hypothesis.]
[Verification command must pass after fix before closing the debug session.]
```

- Create: `skills/debug/soul.md` — Methodical Investigator identity (no guesses, evidence-driven)
- Create: `skills/debug/debug.md` — inline example of a well-formed debug session transcript
- Create: `commands/debug.md` — slash-command definition invoking skills/debug/SKILL.md

### Step 4: Run to verify pass

Command: `npm test -- tests/skills/debug.test.mjs` (same as Step 2)

Expected output:
```
✓ debug skill — file presence > SKILL.md exists and is non-empty
✓ debug skill — file presence > contains required frontmatter fields
✓ debug skill — structure > contains Phase 0 bootstrap gate reference
✓ debug skill — structure > requires hypothesis formation before fix
✓ debug skill — structure > requires reproduction step before fix
✓ debug skill — structure > mandates a verification command after fix
✓ debug skill — structure > has When NOT to use section
✓ debug skill — anti-patterns section > contains Anti-Patterns section
✓ debug skill — anti-patterns section > prohibits guessing fixes without reproduction
9 passed
```

### Step 5: Commit

Message:
```
feat(skills): add debug skill — hypothesis-driven root-cause investigation (GH #37)
```

Files staged: skills/debug/SKILL.md, skills/debug/soul.md, skills/debug/debug.md, commands/debug.md, tests/skills/debug.test.mjs

---

## Task 3: Add verification-before-completion and receiving-review rules (GH #38, GH #40)

Owner: code-implementer
Estimated: 3 min

### Files

- Create: .claude/rules/verification-before-completion.md, .claude/rules/receiving-review.md
- Modify: (none — See Also cross-refs wired in Task 6)
- Test: tests/rules/verification-before-completion.test.mjs, tests/rules/receiving-review.test.mjs

### Step 1: Write the failing test

File: `tests/rules/verification-before-completion.test.mjs`

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VBC_PATH = join(REPO_ROOT, '.claude', 'rules', 'verification-before-completion.md');
const RCR_PATH = join(REPO_ROOT, '.claude', 'rules', 'receiving-review.md');

const vbc = readFileSync(VBC_PATH, 'utf8');
const rcr = readFileSync(RCR_PATH, 'utf8');

describe('verification-before-completion rule', () => {
  it('file exists and is non-empty', () => {
    expect(vbc.length).toBeGreaterThan(100);
  });

  it('contains the Iron Law heading', () => {
    expect(vbc).toMatch(/Iron Law/i);
  });

  it('defines VBC-001 through VBC-005 rule identifiers', () => {
    expect(vbc).toContain('VBC-001');
    expect(vbc).toContain('VBC-005');
  });

  it('lists at least 7 forbidden completion phrases', () => {
    const phrases = [
      'should work',
      'this should pass',
      'ought to work',
      'presumably',
      'I expect',
      'tests are green',
      'all tests pass',
    ];
    const found = phrases.filter(p => vbc.toLowerCase().includes(p.toLowerCase()));
    expect(found.length).toBeGreaterThanOrEqual(7);
  });

  it('has a See Also section linking adjacent rules', () => {
    expect(vbc).toMatch(/See Also/i);
    expect(vbc).toContain('development.md');
  });
});

describe('receiving-review rule', () => {
  it('file exists and is non-empty', () => {
    expect(rcr.length).toBeGreaterThan(100);
  });

  it('defines RCR-001 through RCR-006 rule identifiers', () => {
    expect(rcr).toContain('RCR-001');
    expect(rcr).toContain('RCR-006');
  });

  it('lists at least 5 forbidden defensive responses to review', () => {
    const phrases = [
      'actually',
      'but I already',
      'that was intentional',
      'this is by design',
      'you misunderstood',
    ];
    const found = phrases.filter(p => rcr.toLowerCase().includes(p.toLowerCase()));
    expect(found.length).toBeGreaterThanOrEqual(5);
  });

  it('has a See Also section', () => {
    expect(rcr).toMatch(/See Also/i);
  });
});
```

Why: verifies both always-on rule files exist with their key behavioral phrases and rule identifiers — which is what the plugin's validate-plugin suite checks for always-on rules.

### Step 2: Run to confirm failure

Command: `npm test -- tests/rules/verification-before-completion.test.mjs`

Expected output:
```
FAIL tests/rules/verification-before-completion.test.mjs
  verification-before-completion rule
    × file exists and is non-empty
      Error: ENOENT: no such file or directory, open '.../.claude/rules/verification-before-completion.md'
```

### Step 3: Implement

Files:
- Create: `.claude/rules/verification-before-completion.md`

```markdown
# Verification Before Completion (Always-on)

Evidence before assertions. If you have not run the verification command in this message, you cannot claim it passes.

## The Iron Law

> **NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**

"Fresh" means: in the current message thread, within the last few tool calls, against the current working tree.

## VBC-001: Banned Completion Phrases

These phrases are forbidden without a preceding tool call that produces passing output:

- "should work" / "this should work"
- "this should pass" / "tests should pass"
- "ought to work"
- "presumably passing"
- "I expect this to pass"
- "tests are green" (without running them)
- "all tests pass" (without running them)
- "it works" (without demonstrated output)
- "no errors" (without running typecheck)

## VBC-002: Fresh Evidence Requirements

A claim counts as verified only when ALL of the following hold:
- The tool call that produced the evidence is in the CURRENT message thread
- No file edits occurred AFTER the verification tool call
- The evidence is scoped to the changed files (not a cached result from before the edit)

## VBC-003: Verification Scope by Claim Type

| Claim type | Required evidence |
|------------|-------------------|
| "tests pass" | `npm test` output in current thread showing 0 failures |
| "no type errors" | `npm run typecheck` output showing 0 errors |
| "lint clean" | `npm run lint` output showing 0 warnings/errors |
| "file written correctly" | `Read` tool output from the written file |

## VBC-004: Partial-Verification Exception

Partial verification is acceptable when:
- The full test suite takes >60s and only changed-file tests are plausible in context
- The exact command and scope are stated explicitly (e.g., `npm test -- tests/unit/my-module.test.mjs`)
- The partial result is presented as partial ("these 3 tests pass; full suite not run")

Partial verification does NOT authorize phrases like "all tests pass" — use "relevant tests pass".

## VBC-005: Multi-Wave Context

In wave-executor sessions, each wave agent verifies its own work independently. The coordinator does NOT re-run verification after collecting wave results unless a cross-wave integration test exists. Wave agents must include verification output in their completion report.

## Historical Motivation

The 8-pipeline silent regression (2026-05-09 deep-3 → 2026-05-10 deep-1) shipped behind "should work" claims from multiple sessions. Each session trusted the previous one's assertion. The regression compounded silently across waves until CI caught it 24 hours later. This rule prevents the trust chain from forming without evidence.

## See Also
development.md · testing.md · cli-design.md · ask-via-tool.md · parallel-sessions.md · loop-and-monitor.md · receiving-review.md
```

- Create: `.claude/rules/receiving-review.md`

```markdown
# Receiving Review (Always-on)

Code review is a gift. Defensive reactions block learning and slow the team. This rule defines how to receive review gracefully and extract maximum value from feedback.

## RCR-001: Acknowledge Before Responding

When receiving a review comment, the first response is acknowledgment — not defense. "Good catch" or "I see the issue" before any explanation.

## RCR-002: Forbidden Defensive Phrases

These phrases are banned in response to review comments:

- "actually, ..." (implicit correction of the reviewer)
- "but I already ..." (assertion that the work was done correctly)
- "that was intentional" (without asking why the reviewer flagged it)
- "this is by design" (without explaining the design decision)
- "you misunderstood" (reviewer is always worth engaging charitably)
- "it's the same as ..." (deflecting rather than addressing the specific comment)

## RCR-003: Clarification Before Disagreement

If a review comment seems incorrect, ask a clarifying question before disagreeing:
- "I want to make sure I understand — are you suggesting X because of Y?"
- This prevents disagreeing with a misread of the reviewer's intent.

## RCR-004: Change or Document

Every review comment ends in one of two outcomes:
- **Change**: apply the suggestion, verify, update the change set
- **Document**: write a comment explaining why the suggestion was intentionally not applied

Silently ignoring a review comment is never acceptable.

## RCR-005: No Scope Inflation in Response

Responding to a review comment by expanding scope ("while I'm here, I also fixed...") requires explicit reviewer approval. Address only the flagged issue in the response commit.

## RCR-006: Batch Review Responses

When a reviewer leaves multiple comments, address all of them before requesting re-review. Sending "done" after fixing one comment of ten is disrespectful of the reviewer's time.

## See Also
development.md · testing.md · parallel-sessions.md · verification-before-completion.md
```

### Step 4: Run to verify pass

Command: `npm test -- tests/rules/verification-before-completion.test.mjs` (same as Step 2)

Expected output:
```
✓ verification-before-completion rule > file exists and is non-empty
✓ verification-before-completion rule > contains the Iron Law heading
✓ verification-before-completion rule > defines VBC-001 through VBC-005 rule identifiers
✓ verification-before-completion rule > lists at least 7 forbidden completion phrases
✓ verification-before-completion rule > has a See Also section linking adjacent rules
✓ receiving-review rule > file exists and is non-empty
✓ receiving-review rule > defines RCR-001 through RCR-006 rule identifiers
✓ receiving-review rule > lists at least 5 forbidden defensive responses to review
✓ receiving-review rule > has a See Also section
9 passed
```

### Step 5: Commit

Message:
```
feat(rules): add verification-before-completion + receiving-review always-on rules (GH #38 #40)
```

Files staged: .claude/rules/verification-before-completion.md, .claude/rules/receiving-review.md, tests/rules/verification-before-completion.test.mjs, tests/rules/receiving-review.test.mjs

---

## Task 4: Add write-executable-plan skill (GH #39)

Owner: code-implementer
Estimated: 4 min

### Files

- Create: skills/write-executable-plan/SKILL.md, skills/write-executable-plan/plan-template.md, docs/plans/2026-05-16-superpowers-cluster.md
- Modify: (none — cross-refs wired in Task 6)
- Test: tests/skills/write-executable-plan.test.mjs

### Step 1: Write the failing test

File: `tests/skills/write-executable-plan.test.mjs`

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_PATH = join(REPO_ROOT, 'skills', 'write-executable-plan', 'SKILL.md');
const TEMPLATE_PATH = join(REPO_ROOT, 'skills', 'write-executable-plan', 'plan-template.md');

const skill = readFileSync(SKILL_PATH, 'utf8');
const template = readFileSync(TEMPLATE_PATH, 'utf8');

describe('write-executable-plan skill — file presence', () => {
  it('SKILL.md exists and is non-empty', () => {
    expect(skill.length).toBeGreaterThan(0);
  });

  it('plan-template.md exists and is non-empty', () => {
    expect(template.length).toBeGreaterThan(0);
  });

  it('contains required frontmatter fields', () => {
    expect(skill).toContain('name: write-executable-plan');
    expect(skill).toContain('model: inherit');
    expect(skill).toContain('color: green');
    expect(skill).toContain('tools:');
  });
});

describe('write-executable-plan skill — Phase 4 placeholder linter', () => {
  it('contains a Phase 4 section', () => {
    expect(skill).toMatch(/Phase 4/i);
    expect(skill).toMatch(/[Ll]inter|[Pp]laceholder/i);
  });

  it('explicitly lists TBD as forbidden', () => {
    expect(skill).toContain('TBD');
  });

  it('explicitly lists TODO as forbidden', () => {
    expect(skill).toContain('TODO');
  });

  it('explicitly bans "similar to Task N" pattern', () => {
    expect(skill).toMatch(/similar to Task/i);
  });

  it('explicitly bans "add appropriate error handling"', () => {
    expect(skill).toMatch(/add appropriate error handling/i);
  });

  it('explicitly bans ellipsis in code blocks', () => {
    expect(skill).toMatch(/\.\.\./);
    expect(skill).toMatch(/code block|implementation code/i);
  });
});

describe('write-executable-plan skill — 5-step structure', () => {
  it('defines exactly 5 mandatory steps per task', () => {
    expect(skill).toMatch(/Step 1.*failing test/is);
    expect(skill).toMatch(/Step 2.*confirm.*fail/is);
    expect(skill).toMatch(/Step 3.*[Ii]mplement/is);
    expect(skill).toMatch(/Step 4.*verify.*pass/is);
    expect(skill).toMatch(/Step 5.*[Cc]ommit/is);
  });

  it('requires exact commands in Step 2 and Step 4', () => {
    expect(skill).toMatch(/[Ee]xact command/i);
  });

  it('requires complete code in Step 3 — no placeholders', () => {
    expect(skill).toMatch(/[Cc]omplete code/i);
    expect(skill).toMatch(/no placeholder/i);
  });
});

describe('write-executable-plan skill — plan-template structure', () => {
  it('template contains whole-plan Files block', () => {
    expect(template).toMatch(/## Files.*whole-plan/is);
  });

  it('template contains per-task Files block', () => {
    expect(template).toMatch(/### Files/i);
  });

  it('template has all 5 step headings', () => {
    expect(template).toMatch(/### Step 1/i);
    expect(template).toMatch(/### Step 5/i);
  });
});
```

Why: verifies the skill enforces the placeholder linter section with its full forbidden-string list, the mandatory 5-step structure per task, and the template's structural completeness — all load-bearing requirements for agent-safe plan execution.

### Step 2: Run to confirm failure

Command: `npm test -- tests/skills/write-executable-plan.test.mjs`

Expected output:
```
FAIL tests/skills/write-executable-plan.test.mjs
  write-executable-plan skill — file presence
    × SKILL.md exists and is non-empty
      Error: ENOENT: no such file or directory, open '.../skills/write-executable-plan/SKILL.md'
```

### Step 3: Implement

Files:
- Create: `skills/write-executable-plan/SKILL.md` — full skill per the Phase 0-6 specification in this plan
- Create: `skills/write-executable-plan/plan-template.md` — structural template with `<SLOT>` placeholders for Phase 5 use
- Create: `docs/plans/2026-05-16-superpowers-cluster.md` — this dogfood reference plan

### Step 4: Run to verify pass

Command: `npm test -- tests/skills/write-executable-plan.test.mjs` (same as Step 2)

Expected output:
```
✓ write-executable-plan skill — file presence > SKILL.md exists and is non-empty
✓ write-executable-plan skill — file presence > plan-template.md exists and is non-empty
✓ write-executable-plan skill — file presence > contains required frontmatter fields
✓ write-executable-plan skill — Phase 4 placeholder linter > contains a Phase 4 section
✓ write-executable-plan skill — Phase 4 placeholder linter > explicitly lists TBD as forbidden
✓ write-executable-plan skill — Phase 4 placeholder linter > explicitly lists TODO as forbidden
✓ write-executable-plan skill — Phase 4 placeholder linter > explicitly bans "similar to Task N" pattern
✓ write-executable-plan skill — Phase 4 placeholder linter > explicitly bans "add appropriate error handling"
✓ write-executable-plan skill — Phase 4 placeholder linter > explicitly bans ellipsis in code blocks
✓ write-executable-plan skill — 5-step structure > defines exactly 5 mandatory steps per task
✓ write-executable-plan skill — 5-step structure > requires exact commands in Step 2 and Step 4
✓ write-executable-plan skill — 5-step structure > requires complete code in Step 3 — no placeholders
✓ write-executable-plan skill — plan-template structure > template contains whole-plan Files block
✓ write-executable-plan skill — plan-template structure > template contains per-task Files block
✓ write-executable-plan skill — plan-template structure > template has all 5 step headings
15 passed
```

### Step 5: Commit

Message:
```
feat(skills): add write-executable-plan skill + dogfood reference plan (GH #39)
```

Files staged: skills/write-executable-plan/SKILL.md, skills/write-executable-plan/plan-template.md, docs/plans/2026-05-16-superpowers-cluster.md, tests/skills/write-executable-plan.test.mjs

---

## Task 5: Wire cross-references across all new artifacts (GH #35 umbrella close prep)

Owner: code-implementer
Estimated: 3 min

### Files

- Create: (none)
- Modify: skills/wave-executor/SKILL.md, skills/session-plan/SKILL.md, agents/code-implementer.md, agents/session-reviewer.md, skills/plan/SKILL.md
- Test: (structural — validate-plugin handles this via frontmatter + See Also checks)

### Step 1: Write the failing test

File: `tests/skills/superpowers-cross-refs.test.mjs`

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

describe('wave-executor cross-references', () => {
  const waveExecutor = readFile('skills/wave-executor/SKILL.md');

  it('references write-executable-plan as plan input source', () => {
    expect(waveExecutor).toMatch(/write-executable-plan/i);
  });
});

describe('code-implementer cross-references', () => {
  const agent = readFile('agents/code-implementer.md');

  it('references verification-before-completion rule', () => {
    expect(agent).toMatch(/verification-before-completion/i);
  });
});

describe('session-reviewer cross-references', () => {
  const agent = readFile('agents/session-reviewer.md');

  it('references receiving-review rule', () => {
    expect(agent).toMatch(/receiving-review/i);
  });
});

describe('plan skill cross-references', () => {
  const planSkill = readFile('skills/plan/SKILL.md');

  it('references write-executable-plan as downstream consumer of PRDs', () => {
    expect(planSkill).toMatch(/write-executable-plan/i);
  });

  it('references brainstorm as alternative upstream source', () => {
    expect(planSkill).toMatch(/brainstorm/i);
  });
});
```

Why: verifies that the new skills are wired into the existing skill graph — wave-executor knows to accept plan files, code-implementer enforces the VBC rule, session-reviewer enforces the RCR rule, and plan knows about its downstream consumers.

### Step 2: Run to confirm failure

Command: `npm test -- tests/skills/superpowers-cross-refs.test.mjs`

Expected output:
```
FAIL tests/skills/superpowers-cross-refs.test.mjs
  wave-executor cross-references
    × references write-executable-plan as plan input source
      AssertionError: expected string not to be empty but found no match for /write-executable-plan/i
```

### Step 3: Implement

Files:
- Modify: `skills/wave-executor/SKILL.md` — add See Also entry: `skills/write-executable-plan/SKILL.md — produces the plan files this skill executes`
- Modify: `agents/code-implementer.md` — add reference to `.claude/rules/verification-before-completion.md` in the Quality Standards section
- Modify: `agents/session-reviewer.md` — add reference to `.claude/rules/receiving-review.md` in the See Also block
- Modify: `skills/plan/SKILL.md` — add See Also entry for `skills/write-executable-plan/SKILL.md` and `skills/brainstorm/SKILL.md`
- Modify: `skills/session-plan/SKILL.md` — add See Also entry for `skills/brainstorm/SKILL.md`

### Step 4: Run to verify pass

Command: `npm test -- tests/skills/superpowers-cross-refs.test.mjs` (same as Step 2)

Expected output:
```
✓ wave-executor cross-references > references write-executable-plan as plan input source
✓ code-implementer cross-references > references verification-before-completion rule
✓ session-reviewer cross-references > references receiving-review rule
✓ plan skill cross-references > references write-executable-plan as downstream consumer of PRDs
✓ plan skill cross-references > references brainstorm as alternative upstream source
5 passed
```

### Step 5: Commit

Message:
```
chore(skills): wire cross-refs for superpowers-cluster adoption (GH #35)
```

Files staged: skills/wave-executor/SKILL.md, skills/session-plan/SKILL.md, agents/code-implementer.md, agents/session-reviewer.md, skills/plan/SKILL.md, tests/skills/superpowers-cross-refs.test.mjs

---

## Task 6: Close umbrella and run full gate (GH #35)

Owner: coordinator-direct
Estimated: 2 min

### Files

- Create: (none)
- Modify: (none — this task is verification and issue closure only)
- Test: (full gate: npm test, npm run typecheck, npm run lint, validate-plugin)

### Step 1: Write the failing test

File: (no new test file — this task runs the existing full gate)

The "failing test" here is the pre-merge gate state: `npm test` with zero passing tests for the 5 new test files. All prior tasks must be merged before this task runs.

```bash
# Confirm all 5 new test files exist before running gate
ls tests/skills/brainstorm.test.mjs \
   tests/skills/debug.test.mjs \
   tests/rules/verification-before-completion.test.mjs \
   tests/skills/write-executable-plan.test.mjs \
   tests/skills/superpowers-cross-refs.test.mjs
```

Expected output: all 5 paths print without error. If any file is missing, the prior task did not complete.

### Step 2: Run to confirm failure

Command: `npm test -- tests/skills/brainstorm.test.mjs tests/skills/debug.test.mjs tests/rules/verification-before-completion.test.mjs tests/skills/write-executable-plan.test.mjs tests/skills/superpowers-cross-refs.test.mjs`

Expected output (before prior tasks complete):
```
FAIL tests/skills/brainstorm.test.mjs (file missing or tests failing)
FAIL tests/skills/debug.test.mjs (file missing or tests failing)
...
```

### Step 3: Implement

The "implementation" for this task is running the full gate after Tasks 1-5 merge:

```bash
npm test
npm run typecheck
npm run lint
node scripts/validate-plugin.mjs
```

All four commands must exit 0 before closing the umbrella issue.

### Step 4: Run to verify pass

Command: `npm test` (full suite)

Expected output:
```
Test Files  N passed (N)
Tests       M passed (M)
Duration    <time>
```

Where N and M are both equal to the pre-task values plus the new tests added across Tasks 1-5 (minimum +38 new tests from the 5 new test files).

### Step 5: Commit

Message:
```
chore(release): full gate green — superpowers-cluster adoption complete (GH #35 close)
```

Files staged: (none — gate run only; all files were committed in Tasks 1-5)

Close GitHub issues: `gh issue close 36 37 38 39 40 35 --comment "Shipped in session main-2026-05-16-deep-2. Full gate green."`
