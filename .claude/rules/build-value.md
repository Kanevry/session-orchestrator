---
tier: always
review-date: 2026-11-07
description: Write-time code minimalism — the ladder to climb before writing code, and the four things it never simplifies away.
---

# Build Value Over Build Volume (Always-on)

Code earns its place the way a test does: by being the smallest thing that makes the requirement hold. `test-value.md` governs the test side of that discipline — this rule governs the code side, which was the gap. It is always-on because the "build it / reuse it / don't build it" decision is made inside implementation waves, where the path-scoped stack rules are not injected.

## BV-001: The Ladder (before writing any code)

Climb this **after** you understand the problem, never instead of understanding it. Stop at the first rung that holds, and build only that:

1. **Does this need to exist at all?** A speculative need is not a need. Skip it and say so in one line — that line is the deliverable, not a gap.
2. **Is it already in this codebase?** Grep before you write (`rg "<behaviour>" scripts/ hooks/ skills/`), then reuse the helper, util, or pattern you find. Re-implementing what already sits a few files over is the single most common form of slop here. The grep-evidence discipline is `parallel-sessions.md` § PSA-006.
3. **Does the stdlib do it?** `node:*` covers more than habit suggests — `parseArgs`, `styleText`, `structuredClone`, `glob`.
4. **Does a native platform or harness feature cover it?** A hook event, a Claude Code primitive, a `git` porcelain command. `loop-and-monitor.md` § LM-005 is this rung applied to one domain.
5. **Does an already-installed dependency solve it?** Check `package.json` first. Never add a NEW dependency for what a few lines can do — new runtime dependencies need explicit instruction (`agents/code-implementer.md` § Rules) and must clear `development.md` § Dependencies.
6. **Can it be one line?**
7. **Only then:** write the minimum code that works.

## BV-002: Never Simplify These Away

Lazy about the solution, never about reading. Four classes of protection are outside the ladder's reach and stay in the diff at full strength — input validation at trust boundaries, error handling that prevents data loss, security controls, accessibility — plus anything the operator explicitly asked for. The ponytail benchmark below found that the arm which dropped a security guard was the one told only to be brief — brevity as a bare instruction attacks exactly these. Trace the real call flow before choosing a rung: a small diff in the wrong place is not a small change, it is a second bug.

## BV-003: A Bug Fix Targets the Root Cause, Not the Named Symptom

Before patching, grep every caller of the function you are about to touch. One guard inside the shared function beats one guard per call site — fewer lines AND fewer places to forget. Patching only the path the ticket named leaves every sibling caller broken and the next report looks like a new bug. This is the `/debug` Iron Law expressed as a code-shape rule: root cause first, then the minimum fix at the root.

## BV-004: Name the Ceiling on Every Deliberate Simplification

A global lock instead of per-key locking, an O(n²) scan over a list that is small today, a naive heuristic where a parser belongs — all legitimate choices. What makes them legitimate is a **named ceiling and a revisit trigger**, not the intent to revisit. Write both in an inline comment (a constraint the code itself cannot show — the one job an inline comment has): *"linear scan — fine under ~500 entries; revisit if the ledger passes that."* If the simplification survives the session, route it to a carryover issue carrying a `Revisit-Trigger` field (`skills/gitlab-ops/SKILL.md` § Carryover Template). A deferral with no named trigger is not a deferral; it rots into an unlabelled defect.

## Why Write-Time, Not Review-Time

This repo has repeatedly paid to delete over-build after the fact: the test diet at `f69578f` removed 6,716 lines, and the #985 consolidation waves removed thousands more — none of it caught anything, all of it cost a session to write and a session to remove. Review-time deletion works but is the expensive half of the cycle. External evidence that the *shape* of the instruction matters: in an agentic benchmark run (ponytail, 2026-06-18), a structured minimalism rule produced consistent output and was 100% safe across arms, while a bare seven-word "YAGNI + prefer one-liners" prompt was erratic and was the **only** arm that dropped a security guard. A ladder is safe where a slogan is not — which is why BV-001 has seven rungs and BV-002 exists at all.

## Anti-Patterns

- An interface, protocol, or abstract base with exactly one implementation (BV-001.1).
- A factory, registry, or builder that constructs exactly one product (BV-001.1).
- A config key, flag, or option for a value that has never changed and has no requester (BV-001.1).
- Scaffolding — empty modules, stub handlers, `TODO` branches — added "for later" (BV-001.1).
- A new runtime dependency for a job a few stdlib lines already do (BV-001.5).
- The smallest possible diff, chosen without tracing the flow it lands in (BV-002, BV-003).

Adapted from DietrichGebert/ponytail (MIT).

## See Also
test-value.md · mvp-scope.md · development.md · verification-before-completion.md · parallel-sessions.md
