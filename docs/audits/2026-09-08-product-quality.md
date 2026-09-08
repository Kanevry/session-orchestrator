# Product quality review — 2026-09-08

## Scope and baseline

Reviewed the plugin runtime, all 133 open GitLab issues, recent closed issues, repository instructions, npm packaging, the public GitHub README, English/German landing pages and guide, and distribution directories. Work started from `e79ccb745e5208b33d5496f517f43c5e2113b0a2` (4.0.1), clean and synchronized with origin. Baseline GitLab pipeline 8817 passed all 17 jobs; GitHub Tests run 34155631481 passed all four jobs. No open merge requests or public GitHub issues/PRs were present.

Three parallel agents handled backlog/runtime, privacy/identity and public surfaces. Authors and reviewers exchanged areas; review findings were reproduced before repairs. This is a prioritized quality pass, not a claim that all 133 backlog items were completed.

## What works well

- The core workflow is concrete: discovery, scope selection, execution in waves, verification and recorded handover. Safety mechanisms have source references and meaningful failure-case tests.
- Release publication has an explicit npm receipt boundary and checks exact-commit CI on GitLab and GitHub. The GitHub macOS matrix complements GitLab's Linux checks.
- Shared-checkout hazards are addressed through session locks, process-confirmed ownership, scope declarations and git-index rules. Native Codex collaboration can use the same runtime artifacts once its session identity is recognized.
- The site is readable without a client application, has canonical/language links and a sitemap, and keeps visible FAQs aligned with structured data. Its measured inventory is generated rather than hand-maintained.
- The npm package includes the documented runtime and setup material. Pi already indexes the package; a fresh gallery submission is unnecessary.

## Repairs in this session

| Issue | Trigger and resulting behavior | Verification |
| --- | --- | --- |
| #1267 | Private owner material in MDX was outside the privacy scan. MDX is now included; optional `--include-untracked` includes new files while honoring ignore rules. Default behavior stays tracked-only. | Temporary git repositories, ignored/untracked/tracked combinations, Unicode and newline filenames. |
| #1269 | Fail-closed hook behavior could be weakened without the old assertion noticing. Failure output now includes scan context and the hook regression checks actual rejection. | Mutation check: removing the rejection makes the test fail. |
| #1095 | Release reconciliation could print an incomplete command or delete the notes file needed to retry. Recovery now includes exact repository, tag and retained notes; uncertain states inspect first. | Exact argv through a POSIX shell, creation success/failure, unknown release state and missing repository. |
| #1040 | CI metadata, comments or command strings could look like audit coverage; legitimate package-manager options were missed. Recognition now checks executable workflow locations and command verbs, with bounded local GitLab references/inheritance. | Negative metadata/echo/template fixtures plus real audit commands, options, wrappers and GitLab syntax. External includes and dynamic conditions remain outside this local heuristic. |
| #1274 | Native `CODEX_THREAD_ID` was omitted from process identity, leaving this session's manifest unbound. The shared identity reader now recognizes it and rejects ambiguous native IDs unless a harness is explicitly selected. | Native CLI/event/ownership regressions; independent raw-vs-semantic and peer-lock fixtures; live scope binding in this Codex session. |
| #1275 | Public installation and protection claims differed from the runtime. README, EN/DE, guide and `llms` files now describe actual prerequisites, install paths, Codex skills, Cursor bridges, strict/warn behavior and update-cache semantics. | README package links, HTML/anchor/copy payload checks and matching FAQ JSON-LD. |
| #1276 | Vault notes displayed ? despite documented lifecycle counters. Started counts now render, completed/planned-only counts retain labels, and measured zero stays zero. | Seven synthetic precedence cases and the unchanged live-ledger regression pass. |
| #1275 | Guide Copy buttons had no positioned command container and appeared over the hero. Each of eight buttons now belongs to its command block, including multiline code. | Chrome visual reproduction and recheck at 320px; all buttons remain within their blocks; real click reports Copied. |
| #1277 | Release instructions required a fully green preflight before committing the version bump, while that gate requires a clean and pushed commit. The documented order now matches the executable gate. | Independent comparison of the procedure and preflight checks; no runtime gate changes. |
| #1278 | Four suites independently ran the complete validator while coverage workers competed for resources. Validation now runs once before those workers start; the existing smoke assertions consume that run's result. | Both 30-second and targeted 60-second child budgets failed in CI. Local isolated profiling completed all 40 child checks in 8.157s with 229 pass / 0 fail. The correction removes duplicate work while preserving mandatory validation and all smoke assertions. |
| #1279 | Coverage could write its verified marker with a missing report or failed threshold. Report generation and structured measurement checks now precede that marker. | Baseline job 89020 succeeded despite a missing Cobertura artifact. Three executions of the actual shell tail reproduced false success for missing XML, current threshold-error output and even an old grep-matching error. |

README installation now uses the enabled entry's `installPath` from `claude plugin list --json`. The old `find ... | head -1` recipe could choose an unrelated or stale cache. Upgrade/removal distinguishes npm-managed Pi packages from the clone fallback. Repository-only links resolve on npm as well as GitHub. Stable steering files now point to the actual Cursor manifest and distinguish ordinary tests from coverage runs.

## Visual and discoverability checks

Chrome checked the live baseline and the revised local EN/DE/guide pages. At 320 CSS pixels and scale 1, all three had document width 320; the guide's intentionally offscreen screen-reader status text was excluded from visual-overflow findings. The revised desktop homepage retained clear hierarchy and readable installation links. The baseline narrow-table concern in #1080 did not reproduce.

The local Chrome console showed the analytics request blocked by the user's content blocker. The live baseline also showed extension messaging errors and an unsupported Permissions-Policy feature warning; these did not establish an application runtime failure. This review did not modify user extensions or weaken response headers.

Google's [AI search guidance](https://developers.google.com/search/docs/appearance/ai-features) requires no special AI file or additional schema. Work therefore focused on truthful visible content, matching structured data and usable installation paths. `llms.txt` remains a reader convenience. No ranking, conversion or Search Console improvement was measured.

## Backlog and distribution decisions

- #973 (generated root AGENTS parity) and #1059 (agent-authoring contract) already have implementation evidence; reconcile them against current source instead of implementing them again.
- #1080's previously remaining narrow-screen concern is covered by the Chrome measurements above; the other shipped improvements were checked against current site source.
- #1263/#1266 still need the visible Codex picker acceptance evidence specified by their issues. API enumeration alone does not establish that acceptance.
- #1079's GitHub administrator-enforcement setting is still disabled. Changing it requires understanding the mirror/deployment path; this review leaves the configuration in place.
- #824 remains the distribution follow-through tracker. The [updated submission kit](../distribution/submission-kit.md) contains verified destinations and unsent drafts. The highest-value opportunity is refreshing Anthropic's existing April alpha pin, followed by an Awesome Codex listing and correction of the already-open Awesome Claude Code recommendation.
- Startup advisories included stale user notes, accumulated learnings and old runtime artifacts. They were not bulk-deleted during product work. The backlog contains broader architectural and memory-lifecycle work that warrants separate acceptance criteria.

## Validation and delivery record

The first canonical full gate passed typecheck and lint, but exposed the renderer bug above plus two 30-second timeouts under heavy host contention. Those two suites passed unchanged together in 9.20 seconds; the validator child took 8.741 seconds. The final full gate uses Vitest's supported VITEST_MAX_WORKERS=4 setting, preserving every test, check and timeout. Standalone plugin validation passed 229 checks with 0 failures. Native identity passed an independent eight-case ownership probe, and the site suites passed 151 tests. The final canonical gate passed in 243 seconds: 16,787 tests across 667 files, typecheck with zero errors and lint with zero warnings. No gate was stubbed or bypassed. Exact-commit CI remains a separate publication gate.

GitLab's `only_allow_merge_if_pipeline_succeeds` setting was disabled at the start. This session enabled it and verified the change through the API. MR !30 then correctly remained blocked when pipeline 8839's coverage lane failed: 16,752 tests passed, 37 platform-dependent tests skipped, and the aggregate validator child timed out. A targeted 60-second budget also failed in pipeline 8843. The final correction runs one validator before worker dispatch and shares its output with the four smoke suites. Global test timeouts, coverage thresholds and exclusions remain unchanged. The initial local full-gate result above predates that CI finding. Delivery requires the follow-up pipeline to pass.

A further inspection found a separate false-success path in the coverage stage. Baseline pipeline 8817's successful job 89020 warned that its configured Cobertura upload did not exist. The artifact check used an AND-list and the threshold check shell negation; neither stopped the newline-separated script under `set -e`. The threshold grep also expected wording no longer emitted by Vitest. The numeric coverage itself was measured in that baseline (75.44% lines); the defect was in enforcement and artifact verification. The auto-merge was stopped while #1279 added structured checks and behavior regressions for these paths.

The complete local coverage run subsequently passed 16,801 tests and produced both required reports: lines 75.8%, functions 78.52%, statements 73.97% and branches 71%. The structured verifier accepts those real artifacts. Independent negative tests confirm that missing, empty, malformed and duplicate-attribute XML fails before the marker is written; real partial-coverage reports remain accepted when their measurements meet the configured thresholds.
