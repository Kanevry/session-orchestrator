# Deep session: product quality, 2026-09-08

Authorization: user requested autonomous end-to-end work; no additional alignment prompt. Branch codex/product-quality-deep-20260908. Four native concurrent slots incl coordinator; maximum three subagents. Shared branch, disjoint declared paths; coordinator owns git writes.

1. Discovery: CI/backlog/public research/visual audit. Baseline HEAD e79ccb74, GitLab 8817 and GitHub 34155631481 success. 133 open GitLab issues, zero public issues, no open MRs.
2. Impl-Core: privacy (#1267/#1269); release recovery + audit detection (#1095/#1040); public site and guide factual corrections (#1080 residual + new confirmed findings).
3. Impl-Polish: README onboarding, distribution evidence/submission drafts, metadata and integration fixes.
4. Quality: independent skeptical review; focused regression tests; canonical full gate; plugin/package validation; Chrome desktop/mobile 320px/DE/guide visual checks.
5. Finalization: commit, push, MR/CI, merge when green, deployment verification, release if appropriate and ready, issue closure with evidence, session metrics/close.

Acceptance: real vulnerabilities/false positives covered by behavior tests; recovery argv has exact repository/tag and unknown states inspect only; public docs match shipped capabilities and installation; no unverified superiority claims; no duplicate directory submissions. Third-party outreach is drafted only (user asked to consider where to submit, not explicitly send messages).

## Initial file scopes

```json
[
  {
    "id": "privacy",
    "files": [
      "scripts/lib/validate/check-owner-leakage.mjs",
      "tests/lib/validate/check-owner-leakage.test.mjs",
      "tests/husky/pre-commit-owner-leakage.test.mjs"
    ]
  },
  {
    "id": "runtime",
    "files": [
      "scripts/release.mjs",
      "tests/scripts/release.test.mjs",
      "scripts/lib/project-hygiene.mjs",
      "tests/lib/project-hygiene.test.mjs"
    ]
  },
  {
    "id": "public",
    "files": [
      "site/**",
      "scripts/site-numbers.mjs",
      "tests/scripts/site-numbers.test.mjs"
    ]
  },
  {
    "id": "coordinator",
    "files": [
      "README.md",
      "docs/distribution/**",
      "docs/audits/2026-09-08-product-quality.md",
      ".orchestrator/steering/product.md",
      ".orchestrator/steering/tech.md",
      ".orchestrator/steering/structure.md",
      ".codex/STATE.md",
      ".codex/session-plan.md"
    ]
  }
]
```

Confirmed runtime discovery: native CODEX_THREAD_ID is ignored by process identity. Added identity task before review; file declaration .codex/filescopes/wave-2/identity.json.

Final scope changes: native identity and test isolation (#1274), guide copy layout (#1275), lifecycle counters in vault rendering (#1276). Canonical per-agent arrays and aggregate manifests live in .codex/filescopes/wave-4, with a process-confirmed native binding.

Quality findings: first full gate found the renderer bug and two load-related 30s timeouts. The renderer has a synthetic regression; the timeout suites pass unchanged in 9.20s. Final full gate uses the supported VITEST_MAX_WORKERS=4 setting, with all commands, checks and timeouts preserved. New CLI functionality makes the release target 4.1.0 under repository semver rules.

W4 result: canonical full gate passed 16,787 tests in 667 files; typecheck/lint clean, no skipped or stubbed checks. Plugin validation 229 pass / 0 fail.

W5 findings: GitLab MR !30 pipeline 8839 passed both test shards but its coverage lane hit the validator child's 30-second limit. A targeted 60-second budget also failed in pipeline 8843. Issue #1278 now runs the full validator once before Vitest workers and shares the result with the four existing smoke suites, removing competing scans without bypassing their assertions. Issue #1277 corrects the release instructions to require the fully green preflight after commit, both pushes and exact-commit CI. GitLab now requires a successful pipeline before merging; failed coverage correctly blocked this MR.

W5 gate review: #1279 closes a distinct false-success path found in the green baseline: coverage.ok was written despite a missing Cobertura file, and both current and old-format threshold failures also passed the exact shell tail. Auto-merge was stopped for a structured report check against canonical thresholds, with real CI-script behavior tests. Canonical scope: .codex/filescopes/wave-5/coverage-gate.json.

W5 delivery: MR !30 merged as 5066f148 after pipeline 8847 passed all 17 jobs, including verified uploaded coverage artifacts. Thirteen issues closed. GitHub mirror synchronized before the 4.1.0 version bump; the release commit must pass exact-commit CI on both remotes before publication.
