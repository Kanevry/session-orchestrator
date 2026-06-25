---
tier: always
---

# Quality-Gates Auto-Fix Loop (#521)

When `verification-auto-fix.enabled: true` in Session Config (default: `false`),
the inter-wave Quality-Gate dispatches up to `max-retries` (default: 2)
code-implementer fixer-agent retries on each failure before hard abort.

## When the auto-fix loop is active

- Session Config: `verification-auto-fix.enabled: true`
- Each inter-wave Quality-Gate failure triggers a fixer-agent dispatch
- After `max-retries` (default 2) failed dispatches → diagnostics-bundle write
  at `.orchestrator/metrics/verification-failures/<ISO-timestamp>.json` and
  hard abort of the wave

## Anti-pattern guardrails (BE-012)

The fixer-agent prompt MUST include a reminder of `.claude/rules/testing.md` § "Test Quality — False-Positive Prevention"
"test-the-mock" anti-pattern. A fix that makes tests green by mocking the
real failure is a silent-pass regression vector — exactly the bug class that
the BE-012 wrapper contract was designed to prevent.

Concretely, the fixer prompt:
- MUST say: "Do NOT change test mocks to make tests pass. Fix the actual code defect."
- MUST include the failed gate output + corrective_context + changed-files since
  last green SHA
- MUST NOT broaden scope beyond the failing gate — no refactors, no unrelated
  cleanup, no "while we're here" changes

## When NOT to enable the auto-fix loop

- During architectural decisions (the loop will paper over deeper design issues)
- During first-pass implementations where the fixer cannot understand the broader
  intent
- During security-sensitive code paths where a wrong fix has high blast radius

## Diagnostics-bundle schema

When the loop exhausts retries:

```json
{
  "timestamp": "<ISO>",
  "wave": "<wave-id>",
  "gate": "lint|typecheck|test",
  "retryAttempts": 3,
  "maxRetries": 2,
  "failures": [{ "gate": "...", "exitCode": 1, "output": "...", "command": "...", "attempt": 1 }],
  "finalError": { "gate": "...", "exitCode": 1, "output": "..." },
  "changedFiles": ["src/foo.ts", "..."],
  "correctiveContext": ["prior-fix-hint-1", "..."],
  "commands": { "lint": "npm run lint", "typecheck": "npm run typecheck", "test": "npm test" },
  "repoRoot": "/path/to/repo"
}
```

Operators should review the bundle to determine if the failure is:
- (a) Genuine bug in the new wave's work — fix manually and commit
- (b) Pre-existing flake — fix the test, file regression issue
- (c) Auto-fixer regression (test-the-mock case) — revert auto-fix attempts

## Session Config Command Injection — SEC-020 Cross-Reference

See `.claude/rules/security.md` § "Session Config Command Trust (Quality-Gate Command Injection)" for the trust model, the four command-bearing surfaces, and the operator audit checklist.

## Cross-references

- API: `scripts/lib/quality-gate.mjs` (`runQualityGateWithRetry`)
- Wave-executor integration: `skills/wave-executor/SKILL.md` § "Inter-Wave Quality-Gate (with Auto-Fix Loop — #521)"
- Test anti-patterns: `.claude/rules/testing.md` § "Test Quality — False-Positive Prevention" (BE-012, test-the-mock)
- PRD: `docs/prd/2026-05-22-gsd-pattern-adoption-quickwins.md` § Pattern 4
- Issue: #521

## See Also
development.md · testing.md · verification-before-completion.md · parallel-sessions.md
