---
tier: always
review-date: 2026-11-07
description: Write-time code minimalism — the ladder to climb before writing code, and the four things it never simplifies away.
---

# Build Value Over Build Volume (Always-on)

Build the smallest thing that makes the requirement hold; apply `test-value.md` to tests. Both rules apply inside implementation waves.

## BV-001: The Ladder (before writing any code)

Understand the problem first; stop at the first sufficient rung:
1. Needed? Skip speculative needs; one line explaining the skip is the deliverable.
2. Already present? `rg "<behaviour>" scripts/ hooks/ skills/` before writing; reuse helpers/patterns. Evidence: `parallel-sessions.md` § PSA-006.
3. Stdlib? Check `node:*` first.
4. Native platform/harness? Prefer its primitive; `loop-and-monitor.md` § LM-005.
5. Installed dependency? Check `package.json`. Never add one for a few-line job; new runtime dependencies require explicit instruction (`agents/code-implementer.md` § Rules) and `development.md` § Dependencies.
6. One line sufficient?
7. Only then write minimum working code.

## BV-002: Never Simplify These Away

Keep at full strength: trust-boundary input validation, data-loss-preventing error handling, security controls, accessibility, and explicit operator requirements. Trace the real call flow before choosing a rung.

## BV-003: A Bug Fix Targets the Root Cause, Not the Named Symptom

Before patching, grep every caller; fix the shared root cause with the minimum fix, rather than only the ticket's symptom or a guard per callsite (`/debug` Iron Law).

## BV-004: Name the Ceiling on Every Deliberate Simplification

Every deliberate simplification needs an inline comment naming its ceiling and revisit trigger. If it survives the session, create a carryover issue with `Revisit-Trigger` (`skills/gitlab-ops/SKILL.md` § Carryover Template).

## Anti-Patterns

Avoid single-implementation abstractions, single-product factories/registries/builders, unrequested constant config, future scaffolding/stubs/TODOs (BV-001.1), trivial new dependencies (BV-001.5), and small diffs without flow tracing (BV-002/003).

Adapted from DietrichGebert/ponytail (MIT).

## See Also
test-value.md · mvp-scope.md · development.md · verification-before-completion.md · parallel-sessions.md
