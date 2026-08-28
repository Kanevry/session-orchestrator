<!-- source: session-orchestrator plugin (canonical: rules/always-on/receiving-review.md) -->
# Receiving Code Review (Always-on)

How the coordinator — and any agent receiving review output — handles feedback, and what a reviewer owes in return. The default failure mode is performative agreement: accepting before verifying, then half-implementing a wrong suggestion.

## RCR-001: The 6-Step Pattern

When you receive review output containing feedback items, process them in this order. Do NOT skip steps.

1. **READ** — every item, in full, never just the summary. Reviewers nest the actionable detail below the headline.
2. **UNDERSTAND** — restate each item in your own words. Cannot restate it precisely? Re-read the code the reviewer cited.
3. **VERIFY** — check the claim against the codebase: is the cited file still shaped that way, the function still on that line? Reviewers can be wrong, especially after recent edits.
4. **EVALUATE** — improvement, stylistic preference, or misunderstanding? Project conventions (the rules directory, the project instruction file) are the tiebreaker.
5. **RESPOND** — per item: accept, modify, or push back, each with its rationale. Never accept silently — the rationale is the audit trail.
6. **IMPLEMENT** — one item at a time, running the verification command after each (`verification-before-completion.md`).

## RCR-002: Forbidden Phrases

Signals that you skipped steps 2-4. Forbidden in any response to review feedback:

- "You're absolutely right!"
- "Great point!"
- "Excellent feedback!"
- "Let me implement that now" (before VERIFY + EVALUATE)
- "Thanks for catching that!" / "Thanks for [anything]" — gratitude standing in for analysis, before verifying it is a catch

Replace these with: a restatement (UNDERSTAND), a verification reference (VERIFY), and a decision (EVALUATE).

## RCR-003: Source-Specific Handling

| Source | Default posture | Why |
|---|---|---|
| **Human user (the operator)** | Trust-after-understanding — restate, verify, then implement | Operator usually has context you do not |
| **Automated reviewer agents** (architect, QA, analyst personas) | Skeptical — verify against codebase before accepting | Agent output can lag behind the most recent edits |
| **Security reviewer** | Take seriously, verify scope | Security findings have asymmetric cost — false positives are cheaper than false negatives |
| **Automated quality gates** | Mechanical — typecheck/lint failures are facts, fix them | Automated tool output is rarely wrong, often surprising |
| **External code review (PR comments)** | Skeptical, push back if wrong | External reviewers lack project context |

The default posture is **skeptical** unless explicitly overridden — falsely accepting a wrong suggestion costs as much as implementing a bad feature.

## RCR-004: YAGNI Check (Especially for "Implement Properly")

When a reviewer suggests "implement X properly" / "add validation for this case" / "make this configurable":

1. **Grep for usage**: is the code path the reviewer cites actually called in production? `git grep <function-name>` + `git log -p -- <file>`
2. **Check the call site**: does the caller actually pass the inputs the reviewer's hypothetical case would trigger?
3. **If unused**: suggest REMOVAL (the dead code is the real problem) instead of "implementing properly"
4. **If used but the case is impossible at the call site**: push back with the call-site analysis

## RCR-005: Implementation Order

Multi-item review responses follow this order:

1. **Clarify first** — items that reference each other ("fix X AND consider Y"): ASK before partial-implementing. Partial implementations of related items create incoherent intermediate states.
2. **Blocking items** — anything stopping the work (a type error your edit introduced) goes first.
3. **Simple items** — no dependencies; batch them.
4. **Complex items** — needs its own design discussion; surface as a question first.

Verify after each step before moving on (RCR-001.6).

## RCR-006: Push-Back Posture

You are allowed — and expected — to push back on review feedback that is wrong.

Cite one of three: the codebase ("the function at file:line already handles this — the check would duplicate"), the convention ("per the project rule the pattern is Y, not Z"), or the trade-off ("surface area without a prevented failure mode").

Push-back is a feature, not a bug: an implementer who never pushes back implements every wrong suggestion.

## RCR-007: Four-Class Finding Triage

Classify every finding into **exactly one** class before patching:

| Class | Meaning | Action |
|---|---|---|
| **`in-scope-blocker`** | Introduced by this diff, same owner boundary, fixable without changing the task's contract | Fix this cycle |
| **`same-pattern-sweep`** | The identical defect recurs at further sites, all inside your own file scope, none needing a contract change | Fix every site this cycle |
| **`follow-up`** | Real, but an adjacent bug class or sibling surface | Route to a follow-up issue |
| **`stop-and-escalate`** | The correct fix would break the frozen scope | Never patch, however small — escalate |

`same-pattern-sweep` needs all four, else the finding is `follow-up`: identical pattern (one edit shape fixes every site, not merely a related bug class); every site inside your file scope; none whose fix changes a contract (that site is `stop-and-escalate` and ends the sweep); population ENUMERATED by a quoted census of CALL SITES — not files, and not a payload-keyed grep, which misses consumers pinning only the channel (`parallel-sessions.md` § PSA-006). Cannot enumerate it → a suspicion, not a sweep; out-of-scope sites go to `follow-up` with the census.

`stop-and-escalate` triggers — exactly these five, nothing else: (1) a new protocol, (2) a new config surface, (3) a storage change, (4) a public-API contract, (5) a different owner boundary or a release-process change.

Frozen-scope exceptions — exactly these five, nothing else: (1) active data loss, (2) crash, (3) broken install/upgrade, (4) release blocker, (5) concrete security exposure.

Before invoking `stop-and-escalate`: name which of the five applies, show that no in-scope-blocker subset resolves the finding without crossing it, and hand the operator both — escalating IS the action, never a workaround commit.

## RCR-008: Two-Cycle Reclassify

After two fix cycles without a **strict decrease** in blocking findings: pause, reclassify every remaining finding. A third cycle starts only if every finding is still `in-scope-blocker`; otherwise move the smallest safely-landable subset forward and the rest to `follow-up`.

**Landing-lane hygiene**: no stacked, no pushed fix commits while a classification or a focused proof is open. Edits stay local until the cycle is proven in-scope.

A retry cap **stops** on budget; RCR-008 forces **reclassification**. They are different instruments — do not substitute one for the other.

## RCR-009: Depth, and the Reviewer's Authority

A review that only confirms has not reviewed: report the surfaces examined and found SOUND and the suspicions MEASURED AWAY, not findings alone — otherwise the next pass re-opens the same file to learn what you already know. And a reviewer MAY REFUSE an instruction it can REFUTE, provided the refusal carries the measurement and never a preference (the reverse of RCR-006; complying against a measurement you already hold is the costlier error). Self-review is a precondition of handoff, never a substitute — nor is a green gate.

## Anti-Patterns

- Accepting before VERIFY — gratitude, "great point", or a reviewer claim taken as fact without grep-verification (RCR-001/002)
- A review that returns findings only, or an agent that complies with an instruction it can measurably refute (RCR-009)
- One site fixed with its enumerated siblings left standing (RCR-007)

## See Also

verification-before-completion.md · ask-via-tool.md · parallel-sessions.md · test-value.md · build-value.md
