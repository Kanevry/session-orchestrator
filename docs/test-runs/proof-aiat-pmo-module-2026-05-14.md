# /test --target aiat-pmo-module — Value-Proof Report

> **Issue:** [#385](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/385) — end2end-proof: /test --target aiat-pmo-module (web-gate)
> **Session:** main-2026-05-14-deep-3 W1 (coord-direct)
> **Status:** Mechanism + live-execution proven. Coverage-proof partial — rubric-v1 artifact gap surfaced for follow-up.

## Run Metadata

| Field | Value |
|---|---|
| Target | `/Users/bernhardg./Projects/intern/aiat-pmo-module/tests/e2e` |
| Profile | `web-gate` (`.orchestrator/policy/test-profiles.json`) |
| Driver | `scripts/lib/playwright-driver/runner.mjs` (Playwright 1.x via global npx) |
| Run-ID | `aiat-pmo-2026-05-14-170021-v3` |
| Run-Dir | `.orchestrator/metrics/test-runs/aiat-pmo-2026-05-14-170021-v3/` |
| Started | 2026-05-14T15:00:22.316Z |
| Duration | 547 ms (test execution); ~30 s wall-clock incl. spawn + reporter |
| Exit code | 1 (Playwright: ≥1 unexpected failure) — runner.mjs maps to exit 1 per spec |
| Orchestrator session | `main-2026-05-14-deep-3` |
| Plugin version | v3.5.0 |

## Stack Setup

Pre-existing (3 h uptime at session start):

```bash
docker compose -f ~/Projects/intern/aiat-pmo-module/dev/docker-compose.yml ps
# aiat-pmo-daemon, aiat-pmo-ws, aiat-pmo-espo, aiat-pmo-db (healthy)
```

Bootstrap (coord-direct W1, ~30 s):

```bash
cd ~/Projects/intern/aiat-pmo-module/tests/e2e && npm install   # 4 packages
npx playwright install chromium                                  # 92.4 MiB → ~/Library/Caches/ms-playwright/chromium_headless_shell-1223
```

Health: `curl http://localhost:8090` → 200 OK (EspoCRM responding).

Env: `tests/e2e/.env` not used; tests read `process.env.ESPOCRM_URL` (defaults to `http://localhost:8090`). No `TEST_INITIATIVE_ID` env var set → most tests conditionally skipped.

## Test Execution Summary

| Metric | Value |
|---|---|
| Expected (passed) | 0 |
| Unexpected (failed) | 1 |
| Flaky | 0 |
| Skipped | 31 |
| Total declared | 32 |

The single failure is `initiative-list.spec.ts:27 — GET /api/v1/Initiative returns 200 with total and list`. The test asserts `expect(response.status()).toBe(200)` but the server returns 401 because no API key / session token was provided in the test environment. The 31 skipped tests all carry conditional `test.skip(!ENV_VAR, '...')` guards; this one is missing that guard, so it executes and fails immediately. **This is a minor finding in `aiat-pmo-module` (missing skip-guard) — not a /test bug.**

Skip distribution (31 across 14 spec files):

| File | Skipped |
|---|---|
| `api/restricted-role-403.spec.ts` | 6 |
| `api/acl-team-isolation.spec.ts` | 3 |
| `api/auth-token.spec.ts` | 3 |
| `api/cluster-routing.spec.ts` | 3 |
| `api/create-via-api-key.spec.ts` | 3 |
| `api/stale-filter.spec.ts` | 3 |
| `initiative-auth.spec.ts` | 2 |
| `api/score-live.spec.ts` | 2 |
| Remaining 6 spec files | 1 each |

## Artifacts Captured

```
.orchestrator/metrics/test-runs/aiat-pmo-2026-05-14-170021-v3/
├── console.log         17 279 B   combined stdout+stderr from npx
├── exit_code            1 B       Playwright exit code (1)
├── report/index.html             Playwright HTML reporter output
├── results.json        27 154 B   Playwright JSON reporter
└── test-results/                  per-test artifacts
    ├── .last-run.json
    └── <test-name-chromium>/      32 sub-dirs
        └── trace.zip              Playwright trace (`--trace on`)
```

## ux-evaluator Status — Coverage Gap

ux-evaluator agent **not dispatched** this run. Rationale: the rubric-v1 specifies 4 checks each requiring artifact shapes the current playwright-driver runner does not produce:

| rubric-v1 check | Required artifact | Produced this run? |
|---|---|---|
| 1. onboarding-step-count ≤ 7 | AX-tree snapshots (`ax-snapshots/*.yaml` or similar) | ❌ no — peekaboo-style concept, not implemented for web in v1 |
| 2. axe-violations critical/serious | `axe-*.json` from @axe-core/playwright | ❌ no — soft-skipped (axe-core not in tests/e2e deps) |
| 3. console-errors visible-to-user | `console.ndjson` structured | ❌ no — only flat `console.log` (combined stdout) |
| 4. Apple-Liquid-Glass conformance | macOS-only (peekaboo) | n/a — web target |

The agent would have nothing actionable to classify. Two follow-up issues were filed to close this gap (see Findings & Follow-ups below).

## Findings & Follow-ups (filed this session)

| # | Severity | Description | Disposition |
|---|---|---|---|
| RUNNER-1 | MED | `runner.mjs:174-180` used Jest/Vitest `--reporter html:<path>,json:<path>` syntax; Playwright canonical is `--reporter=html,json` + `PLAYWRIGHT_HTML_OUTPUT_DIR` / `PLAYWRIGHT_JSON_OUTPUT_FILE` / `PLAYWRIGHT_HTML_OPEN` env vars. | **Fixed inline this session** (coord-direct W1 hotfix; deviation logged in STATE.md). Filed retro issue for the regression-test gap (mechanism-proof dry-run didn't catch this — only live spawn does). |
| RUNNER-2 | MED | `runner.mjs` does not write rubric-v1 expected artifacts: no `ax-snapshots/`, no `console.ndjson`, no `screenshots/` namespace. Only Playwright-native artifacts. Skips axe-core unconditionally if `@axe-core/playwright` isn't in target's package.json. | **New issue filed** — V2 capture-extension to bridge runner.mjs ↔ rubric-v1. Until then, /test on web targets is mechanism-proven but coverage-proof partial. |
| TARGET-RESOLUTION | LOW | Runner uses `--target <repo-root>` but tests/e2e is a nested package (own playwright.config.ts + node_modules). First retry failed with "two different versions of @playwright/test" because npx fell back to global. Resolved by passing `--target tests/e2e` directly. Profile registry should grow a `tests-dir` field or runner.mjs should walk for the closest `playwright.config.*`. | **Documented here**; deferred to a future profile-schema enhancement. |
| AIAT-PMO-INIT-LIST | LOW | `aiat-pmo-module tests/e2e/tests/initiative-list.spec.ts:27` lacks the `test.skip(!AUTH_ENV, …)` guard the other 13 spec files use; fails 401 in any env without auth. | **Cross-repo finding** — not filed here. Will surface to aiat-pmo-module backlog. |

## Re-Run Dedupe Verification

Not exercised this session. The first live run (`aiat-pmo-2026-05-14-165941-retry`, target=repo-root) errored at the spawn level before reporter output. The second run (`aiat-pmo-2026-05-14-170021-v3`, target=tests/e2e) is the first artifact-producing run. A re-run dedupe pass requires reconcile triage, which is gated on the ux-evaluator artifact-shape fix (RUNNER-2 above).

## Conclusion

The /test command's end-to-end pipeline is **mechanically proven** against a real live target: bootstrap → driver spawn → Playwright execution → HTML/JSON reporter → exit-code mapping all work as specified. The reporter-syntax bug (RUNNER-1) blocked the value-proof at first attempt; it was fixed inline using canonical Playwright documentation (https://playwright.dev/docs/test-reporters) sourced via ref-mcp + WebFetch, then re-verified in the same session.

The **coverage-proof is partial**: the runner's artifact shape does not yet match rubric-v1's expectations (RUNNER-2), so the ux-evaluator agent cannot perform its 4-check classification. This is a V2-substrate gap, not a mechanism failure. /test on web targets is usable today for "did Playwright tests pass" answers; value-proof for the agentic UX-rubric flow needs RUNNER-2.

Real findings in the target repo (1 missing skip-guard) demonstrate the pipeline produces actionable, repo-relevant signal even in this stub state.

**Recommendation:** Close #385 with status "mechanism + minimal-coverage proof PARTIAL". File RUNNER-2 as the gating issue for full rubric-v1 coverage on the next /test --target aiat-pmo-module pass.
