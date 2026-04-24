# Fixture: Clean-Repo Harness-Audit Baseline

Minimal repo that satisfies all 7 harness-audit categories at ≥8/10.
Used by `tests/integration/harness-audit.integration.test.mjs`.

## v2.0 Features

- Session persistence via STATE.md
- Scope enforcement hooks

## Session Config

persistence: true
enforcement: warn
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
