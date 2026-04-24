# Harness-Audit Clean-Repo Fixture

Minimal repo satisfying all 7 categories of the harness-audit rubric (v2026-05) at ≥8/10.

Used by `tests/integration/harness-audit.integration.test.mjs` as the baseline "healthy" input.

To re-verify manually:

    cd tests/fixtures/harness-audit/clean-repo
    node ../../../../scripts/harness-audit.mjs

Expected: overall ≥ 8.0, band `healthy`.
