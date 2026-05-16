# Receiving Code Review (Always-on)

How the coordinator (and any agent receiving review output) handles feedback. The default failure mode in our history is performative agreement — the agent says "great point, I'll implement it" before verifying the feedback is even correct, and ends up half-implementing a wrong suggestion. This rule prevents that.

Applies to feedback from: session-reviewer, security-reviewer, persona reviewers (architect-reviewer, qa-strategist, analyst), inter-wave Quality-Lite output, user-provided review comments, external code-review-agent output.

## RCR-001: The 6-Step Pattern

When you receive review output containing feedback items, process them in this order. Do NOT skip steps.

1. **READ** — read every item completely. Read the full output, not just the summary. Reviewers often nest the actionable detail below the headline.
2. **UNDERSTAND** — restate each item in your own words. If you cannot restate it precisely, you do not understand it yet — re-read the source code the reviewer cited.
3. **VERIFY** — check the claim against the codebase. Is the file the reviewer cited actually structured the way they describe? Is the function still on that line? Reviewers can be wrong, especially after recent edits.
4. **EVALUATE** — judge technical correctness. Is the suggestion an improvement, a stylistic preference, or a misunderstanding? Use the project's conventions (`.claude/rules/`, CLAUDE.md, AGENTS.md) as the tiebreaker.
5. **RESPOND** — produce a technical response per item: accept (with rationale), modify (with rationale), or push back (with rationale). Never accept silently — the rationale is the audit trail.
6. **IMPLEMENT** — apply one item at a time. After each, run the verification command (see `.claude/rules/verification-before-completion.md`) before moving to the next item.

## RCR-002: Forbidden Phrases

The following are signals that you skipped steps 2-4 (verify, evaluate). They are forbidden in any response to review feedback.

- "You're absolutely right!"
- "Great point!"
- "Excellent feedback!"
- "Let me implement that now" (before VERIFY + EVALUATE)
- "Thanks for catching that!" (before verifying it's actually a catch)
- "Thanks for [anything]" (generalized gratitude that substitutes for analysis)

Replace these with: a restatement (UNDERSTAND), a verification reference (VERIFY), and a decision (EVALUATE).

## RCR-003: Source-Specific Handling

| Source | Default posture | Why |
|---|---|---|
| **Human user (the operator)** | Trust-after-understanding — restate, verify, then implement | Operator usually has context you do not |
| **session-reviewer / persona reviewers** | Skeptical — verify against codebase before accepting | Plugin-agent output can lag behind the most recent edits |
| **security-reviewer** | Take seriously, verify scope | Security findings have asymmetric cost — false positives are cheaper than false negatives |
| **Inter-wave Quality-Lite** | Mechanical — typecheck/lint failures are facts, fix them | Automated tool output is rarely wrong, often surprising |
| **External code review (PR comments)** | Skeptical, push back if wrong | External reviewers lack project context |

The default posture is **skeptical** unless explicitly overridden. The cost of falsely accepting a wrong suggestion is the same as the cost of implementing a bad feature: rework + confusion.

## RCR-004: YAGNI Check (Especially for "Implement Properly")

When a reviewer suggests "implement proper error handling here" / "add validation for this case" / "this should be configurable":

1. **Grep for usage**: is the code path the reviewer cites actually called in production? `git grep <function-name>` + `git log -p -- <file>`
2. **Check the call site**: does the caller actually pass the inputs the reviewer's hypothetical case would trigger?
3. **If unused**: suggest REMOVAL (the dead code is the real problem) instead of "implementing properly"
4. **If used but the case is impossible at the call site**: push back with the call-site analysis

The most common form of this anti-pattern: a reviewer suggests defensive code for a case that the call site already guarantees impossible. Adding the defensive code increases surface area without adding safety.

## RCR-005: Implementation Order

Multi-item review responses follow this order:

1. **Clarify first** — if any items reference each other or might be related ("fix X AND consider Y"), ASK before partial-implementing. Partial implementations of related items create incoherent intermediate states.
2. **Blocking items** — anything that prevents the wave/session from completing (e.g., a TypeScript error introduced by your edit) goes first.
3. **Simple items** — straightforward fixes with no dependencies. Batch these where possible.
4. **Complex items** — items that require their own design discussion. Surface to user via AUQ before implementing.

After each implementation step, run the verification command for that item before moving on.

## RCR-006: Push-Back Posture

You are allowed — and expected — to push back on review feedback that is wrong.

- Cite the codebase: "The function at file:line already handles this case — adding the suggested check would duplicate."
- Cite the convention: "Per `.claude/rules/<X>.md`, the project pattern is Y, not Z."
- Cite the trade-off: "Adding this validation adds surface area without preventing a real failure mode."

Push-back is a feature, not a bug. A reviewer who is never pushed back on never learns the project. An implementer who never pushes back implements every wrong suggestion.

## Anti-Patterns

- Saying "great point, implementing now" before VERIFY
- Implementing multiple related items partial-first (creates incoherent intermediate states)
- Accepting external reviewer suggestions without project-context check
- Adding defensive code for cases the call site makes impossible (YAGNI violation)
- Treating reviewer claims as facts without grep-verification
- Performative gratitude as substitute for technical engagement

## See Also

development.md · testing.md · cli-design.md · ask-via-tool.md · parallel-sessions.md · verification-before-completion.md
