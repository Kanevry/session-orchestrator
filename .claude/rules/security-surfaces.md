---
paths: ["scripts/lib/config/**", "scripts/lib/quality-gate*.mjs", "scripts/lib/quality-gate/**", "scripts/lib/wave-executor/foreign-dispatch.mjs", "scripts/lib/validate/check-owner-leakage.mjs", "scripts/lib/secret-masker.mjs", "scripts/*install*.mjs", "hooks/config-protection.mjs", "skills/bootstrap/**", "skills/session-start/**", "skills/session-end/**", "skills/wave-executor/**", "agents/**", "commands/**", "tests/lib/config/**", "tests/lib/validate/check-owner-leakage.test.mjs", "tests/husky/**", "tests/hooks/config-protection.test.mjs", "tests/lib/wave-executor/foreign-dispatch.test.mjs", "tests/unit/quality-gate*.test.mjs", "package.json", "package-lock.json", ".npmrc", ".husky/**", ".gitlab-ci.yml", ".github/workflows/**", ".gitleaks.toml", ".semgrep.yml", "CLAUDE.md", "AGENTS.md", ".claude/settings*.json", "templates/**"]
tier: always
review-date: 2026-10-23
---

# Security Surface Mechanics
Universal SEC duties remain in security.md. Wire pre-commit owner scanner with repo root, output suppressed on success; nonzero prints privacy error + diagnostic command and exits 1. Regression: tests/husky/pre-commit-owner-leakage.test.mjs. Tracked-only scanner cannot cover untracked settings.local.json; repo-audit reads on disk.
Command drift: scripts/lib/qg-command-drift-banner.mjs. Custom phase validation: scripts/lib/config/custom-phases.mjs WARN/drops metacharacters in command/review/name. Foreign dispatch: known channel/nonempty target is validation, not proof of binary behavior or native hook coverage. Treat changed commands/targets as code with explicit before/after review.
## See Also
security.md · quality-gates-autofix.md · docs/github-mirror-protection.md
