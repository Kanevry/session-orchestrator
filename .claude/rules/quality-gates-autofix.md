---
tier: always
review-date: 2026-10-23
---

# Quality-Gates Auto-Fix Loop (#521)

When `verification-auto-fix.enabled: true` in Session Config (default: `false`), each inter-wave Quality-Gate failure dispatches up to `verification-auto-fix.max-retries` (default: 2) code-implementer fixer-agent retries before a hard abort that writes a diagnostics bundle to `.orchestrator/metrics/verification-failures/<ISO-timestamp>.json`. The flag is off by default, so for most sessions this whole loop is dead weight — enable it only for mechanical fix loops, never during architectural decisions, first-pass implementations, or security-sensitive paths (a wrong fix has high blast radius there). Retry mechanics + the full diagnostics-bundle schema live in code: `scripts/lib/quality-gate.mjs` (`runQualityGateWithRetry`), consumed by `scripts/lib/quality-gate/diagnostics.mjs`.

## Anti-pattern guardrails (BE-012)

The fixer-agent prompt MUST include a reminder of `.claude/rules/testing.md` § "Test Quality — False-Positive Prevention" "test-the-mock" anti-pattern — a fix that makes tests green by mocking the real failure is a silent-pass regression vector, exactly the bug class the BE-012 wrapper contract was designed to prevent. Concretely the prompt:

- MUST say: "Do NOT change test mocks to make tests pass. Fix the actual code defect."
- MUST include the failed gate output + corrective_context + changed-files since the last green SHA, and MUST NOT broaden scope beyond the failing gate (no refactors, no unrelated cleanup, no "while we're here" changes).

When the loop exhausts retries, operators triage the bundle: (a) genuine bug in the new wave's work → fix + commit; (b) pre-existing flake → fix the test, file a regression issue; (c) auto-fixer regression (test-the-mock) → revert the auto-fix attempts.

## Session Config Command Injection — SEC-020 Cross-Reference

See `.claude/rules/security.md` § "Session Config Command Trust (Quality-Gate Command Injection)" for the trust model, the four command-bearing surfaces, and the operator audit checklist.

## Cross-references

- API: `scripts/lib/quality-gate.mjs` (`runQualityGateWithRetry`); diagnostics: `scripts/lib/quality-gate/diagnostics.mjs`; session-start drift banner: `scripts/lib/qg-command-drift-banner.mjs`.
- Wave-executor integration: `skills/wave-executor/SKILL.md` § "Inter-Wave Quality-Gate (with Auto-Fix Loop — #521)".
- Test anti-patterns: `.claude/rules/testing.md` § "Test Quality — False-Positive Prevention" (BE-012, test-the-mock). PRD "gsd Pattern Adoption Quick-Wins" (#521; archived in the private Meta-Vault) § Pattern 4; Issue #521.

## See Also
development.md · testing.md · verification-before-completion.md · parallel-sessions.md
