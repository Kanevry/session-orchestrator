---
tier: always
review-date: 2026-10-23
---

# Quality-Gates Auto-Fix Loop (#521)

Only when Session Config `verification-auto-fix.enabled: true` (default false): each inter-wave gate failure dispatches code-implementer fixer retries up to `verification-auto-fix.max-retries` (default 2), then hard-aborts with diagnostics at `.orchestrator/metrics/verification-failures/<ISO-timestamp>.json`. Enable only for mechanical fixes, never architectural decisions, first-pass implementations or security-sensitive paths.

## Anti-pattern guardrails (BE-012)
Fixer prompt MUST remind of `.claude/rules/testing.md` § "Test Quality — False-Positive Prevention" (test-the-mock) and say: "Do NOT change test mocks to make tests pass. Fix the actual code defect."
MUST include failed gate output + corrective_context + changed-files since last green SHA. MUST NOT broaden beyond failing-gate scope: no refactors, unrelated cleanup or "while we're here" changes.

Exhausted retries: triage bundle — new-wave bug → fix + commit; pre-existing flake → fix test + regression issue; auto-fixer/test-the-mock regression → revert auto-fix attempts.

## Session Config Command Injection — SEC-020 Cross-Reference
Trust model, command-bearing surfaces and audit checklist: `.claude/rules/security.md` § "Session Config Command Trust (Quality-Gate Command Injection)".

## Cross-references
API/retry mechanics: `scripts/lib/quality-gate.mjs` (`runQualityGateWithRetry`); bundle schema: `scripts/lib/quality-gate/diagnostics.mjs`; drift banner: `scripts/lib/qg-command-drift-banner.mjs`.
Integration: `skills/wave-executor/SKILL.md` § "Inter-Wave Quality-Gate (with Auto-Fix Loop — #521)".
Anti-patterns: `.claude/rules/testing.md` § "Test Quality — False-Positive Prevention" (BE-012). PRD "gsd Pattern Adoption Quick-Wins" (#521, private Meta-Vault archive) § Pattern 4; Issue #521.

## See Also
development.md · testing.md · verification-before-completion.md · parallel-sessions.md
