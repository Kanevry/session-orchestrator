# Feature: `/test` — Agentic End-to-End Test Command

**Date:** 2026-05-14
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning, /plan feature)
**Status:** Draft
**Appetite:** Medium-Plus (~2–3 weeks)
**Parent Project:** session-orchestrator v3.6 candidate (post v3.5.0)

## 1. Problem & Motivation

### What
A new standalone slash-command `/test [scope]` for the session-orchestrator plugin. It is an agentic end-to-end test orchestrator that drives real user flows against running applications — `playwright-cli` for web targets, `peekaboo` for macOS targets — captures deterministic artifacts (accessibility-tree snapshots, screenshots, console output), then runs a single LLM-evaluation pass against a configurable UX rubric, and finally reconciles findings against the project's open issue tracker.

It is delivered as three composable skills (`test-runner` orchestrator, `playwright-driver`, `peekaboo-driver`), one new read-only agent (`ux-evaluator`, pinned to opus), and an optional per-repo policy file `.orchestrator/policy/test-profiles.json`. The command is wrapped, not forked — upstream tools stay on their mainline. Our value lives in the orchestration, the UX rubric, and the issue-reconciliation loop.

### Why
Two recent failure modes motivated this plan:

1. **mail-assistant V3.3 (commit `b29ea71`, 2026-05-12) shipped a 4-stage onboarding wizard (LLM-Provider + Test-Run + Keychain + Mail-Surface, ~2 500 LOC SwiftUI) with zero end-to-end coverage.** The result was post-launch revision work for the operator. A `/test` run driving Peekaboo through the wizard would have flagged a step-count regression (>7) and dead-end paths before merge. The "10-page onboarding" pain is the canonical example of the regression class we want to catch.
2. **Apple Liquid Glass design tokens (iOS 26 / macOS Tahoe, WWDC25) are emerging as the canonical SwiftUI 2026 standard.** Without an automated check that `.glassEffect()` is applied where expected, Swift apps in the portfolio drift away from the platform baseline silently.

A secondary motivation: `aiat-pmo-module` already has 16 Playwright tests + a live EspoCRM stack. We can prove `/test` value against that target in week one and only then move to the harder Mac/Peekaboo path. End-to-end verifiable: step 1 proves the chain, every subsequent step extends it.

Tech-stack research (2026-05-14) confirms the cost calculus: Playwright **MCP** burns ~114 K tokens per test (Microsoft's own benchmark) versus ~27 K for `playwright-cli`. Vercel's `agent-browser` is even leaner (~200–400 tokens/page) but does not run our existing Playwright test files — porting 16 specs is the wrong trade-off. `/test` therefore standardizes on the CLI tools, with `agent-browser` recorded as a v2 alternative if upstream friction emerges.

### Who
- **Primary:** the operator running deep / feature sessions in the session-orchestrator plugin, especially when finishing a UI-touching feature.
- **Secondary:** the autopilot loop (Phase D follow-up) and any per-repo CI integration that wants a token-frugal agentic E2E pass.
- **Tertiary:** future operators of repos scaffolded from `projects-baseline` — they inherit `/test` capability via baseline templates without manual wiring.

## 2. Solution & Scope

### In-Scope (v1)
- [ ] **New command file** `commands/test.md` — standalone, no auto-trigger at wave-end in v1.
- [ ] **New skill** `skills/test-runner/SKILL.md` — orchestrator: parses scope, dispatches the right driver(s), invokes the UX-rubric evaluator, runs issue reconciliation, writes artifacts.
- [ ] **New skill** `skills/playwright-driver/SKILL.md` — thin wrapper around `playwright-cli` (`npm i -g @playwright/cli@latest`). Documents canonical usage, session naming, artifact paths, integration with our quality-gates layout.
- [ ] **New skill** `skills/peekaboo-driver/SKILL.md` — thin wrapper around `peekaboo` (`brew install steipete/tap/peekaboo` or `npx -y @steipete/peekaboo`). Documents permission setup, AX-snapshot, agent-mode invocation.
- [ ] **New agent** `agents/ux-evaluator.md` — read-only (`Read, Grep, Glob, Bash`), pinned `model: opus`, color blue. Single responsibility: read driver artifacts + apply UX rubric + emit findings JSON.
- [ ] **UX rubric (4 checks v1):** (a) onboarding step-count ≤7 (else flag); (b) axe-core violations (critical/serious tagged); (c) console errors visible to the user; (d) Apple-Liquid-Glass conformance — `.glassEffect()` presence on SwiftUI 26+ targets where layout suggests glass surface.
- [ ] **Test-profile registry** — Convention-first: auto-detect target type (`playwright.config.*` → web, `Package.swift` → mac). Optional `.orchestrator/policy/test-profiles.json` for per-app overrides (smoke / full / a11y) and `--target <name>` resolution.
- [ ] **Issue reconciliation** — HIGH/CRITICAL findings auto-create issues (`area:testing`, `priority:*`, `status:ready`, plus `from:test-runner` label), MEDIUM/LOW go through `AskUserQuestion` triage mirroring the `/discovery` pattern. Existing issues with matching fingerprint get **commented**, not re-filed.
- [ ] **Artifact storage** — `.orchestrator/metrics/test-runs/<run-id>/` with `report.md`, `findings.json`, `screenshots/*`, `ax-snapshots/*.yaml`. JSONL roll-up at `.orchestrator/metrics/test-runs.jsonl`.
- [ ] **First-target end-to-end proof:** `/test --target aiat-pmo-module` drives the 16 existing Playwright tests, produces report, files HIGH/CRITICAL issues, surfaces MEDIUM/LOW for triage.
- [ ] **Second-target end-to-end proof:** `/test --target mail-assistant` walks the onboarding wizard via Peekaboo, flags `>7` step count, captures screenshots per step.
- [ ] **projects-baseline integration** — minimal template snippets so a freshly scaffolded repo gets `/test` capability without manual wiring (`.orchestrator/policy/test-profiles.json.template`, optional `scripts/test.sh` stub, README pointer).

### Out-of-Scope (v1)
- **Visual-diff / pixel regression** — operator preference: not for development workflows; reconsider for production-monitoring projects only. Defer to v2 candidate.
- **Cross-repo `/test` orchestration** — running aiat-pmo + mail-assistant in one invocation. Single-target v1 only.
- **Stagehand v3 / Browserbase cloud** — vendor lock, value-add unclear for our use case.
- **Forking `playwright-cli` or `peekaboo`** — wrap, do not fork. Upstream PRs if we need extensions.
- **Auto-trigger of `/test` at wave-executor inter-wave** — risk of session-time bloat; can be added in v2 once value is proven and run-time is bounded.
- **Test code generation from live click-throughs** — explicitly out of v1 scope; the goal is regression detection, not test authoring.
- **Cross-platform Windows automation** — Peekaboo is macOS-only; Windows targets stay out until a real need appears.
- **Mobile (iOS / Android device) targets** — only macOS desktop apps and web apps in v1.

## 3. Acceptance Criteria

### AC-1 — Command shape and scope resolution
```gherkin
Given an operator runs `/test` in a session-orchestrator repo
When no `--target` is passed
Then the command auto-detects the target type from `playwright.config.*` or `Package.swift`
And it runs the default profile (`smoke` if defined, else `auto`)
And it writes artifacts to `.orchestrator/metrics/test-runs/<run-id>/`
And it produces `report.md` + `findings.json` + per-finding evidence

Given an operator runs `/test --target aiat-pmo-module --profile full`
When the test-profile registry resolves the target to a web profile
Then `playwright-driver` invokes the 16 existing Playwright tests
And artifacts include screenshots + AX-tree snapshots per test
```

### AC-2 — Driver skills wrap upstream cleanly
```gherkin
Given `playwright-cli` is installed globally via npm
When `test-runner` dispatches `playwright-driver`
Then `playwright-driver` invokes `playwright-cli` via Bash with a deterministic session id (e.g. `so-test-<run-id>`)
And it captures stdout/stderr, snapshot files, and screenshots into the run artifact directory
And it never inlines accessibility-tree dumps into the LLM coordinator context (token-frugal)

Given `peekaboo` is installed via Homebrew or npx
When `test-runner` dispatches `peekaboo-driver` against a macOS app
Then `peekaboo-driver` first verifies Screen Recording + Accessibility permissions via `peekaboo permissions status`
And on missing permissions it surfaces a clear remediation via `AskUserQuestion` rather than failing silently
```

### AC-3 — UX rubric evaluation (v1 = 4 checks)
```gherkin
Given the drivers have produced AX-tree snapshots + screenshots for an onboarding flow
When the `ux-evaluator` agent (opus, read-only) reads the artifacts
Then it counts navigable steps in the onboarding path
And it flags `HIGH` findings when the count is `>7`
And it flags `CRITICAL` when the count is `>10` or a dead-end (no exit path) is detected
And it reports axe-core critical/serious violations as `HIGH`
And it reports visible console errors during the flow as `HIGH`
And it reports missing `.glassEffect()` on SwiftUI 26+ glass-surface candidates as `MEDIUM`
And every finding emits a stable fingerprint (`hash(scope + check + locator)`) for deduplication
```

### AC-4 — Issue reconciliation matches /discovery pattern
```gherkin
Given the evaluator produces a `HIGH` finding with fingerprint `f1`
And no existing open issue has that fingerprint in its description
When `test-runner` runs the reconciliation phase
Then a new GitLab issue is created via `glab issue create`
And it carries labels `area:testing, priority:high, status:ready, from:test-runner`
And the description includes the fingerprint and a link to the run artifact directory

Given an existing open issue already carries fingerprint `f1`
When the same finding re-surfaces in a later run
Then a comment is added to the existing issue (not a duplicate)
And the run-id is appended to a `seen_in_runs` list in the description

Given the evaluator produces `MEDIUM` and `LOW` findings
When the reconciliation phase reaches them
Then they are presented to the operator via a single `AskUserQuestion` call (multiselect)
And the operator chooses which to file, comment, or ignore
```

### AC-5 — End-to-end verification gates
```gherkin
Given the `/test` command is implemented and `aiat-pmo-module` has 16 Playwright tests
When `/test --target aiat-pmo-module --profile full` is executed in a fresh shell
Then exit code is 0 if no HIGH/CRITICAL findings (MEDIUM/LOW pending operator triage do not affect exit code — deliberate, so CI can treat MEDIUM/LOW as advisory)
And exit code is 2 if any HIGH/CRITICAL findings exist
And the report markdown is human-readable and lists each finding with severity, evidence path, and issue link
And the run JSONL entry is appended to `.orchestrator/metrics/test-runs.jsonl`

Given the `aiat-pmo-module` proof has passed
When `/test --target mail-assistant --profile onboarding` is executed
Then `peekaboo-driver` drives the SwiftUI onboarding wizard end-to-end
And the step-count check produces a finding for the historical 4-stage flow
And screenshots of every stage are captured to the artifact directory
```

### AC-6 — projects-baseline carries `/test` forward
```gherkin
Given a new repo is scaffolded from `projects-baseline` after this feature ships
When the operator inspects the resulting repo
Then `.orchestrator/policy/test-profiles.json.template` is present
And the repo's `CLAUDE.md` documents the `/test` command and convention-detected default profile
And no manual wiring is required to make `/test --target <repo>` work for a web stack with a `playwright.config.*`
```

## 4. Technical Notes

### Affected Files (created or modified)

**New files (created):**
- `commands/test.md` — slash-command spec, points to `skills/test-runner/SKILL.md`.
- `skills/test-runner/SKILL.md` — orchestrator skill. Phase 0 bootstrap gate, Phase 1 config + profile resolution, Phase 2 driver dispatch, Phase 3 evaluator, Phase 4 reconciliation, Phase 5 report.
- `skills/test-runner/soul.md` — identity for the orchestrator skill (test orchestrator, not a tester itself).
- `skills/test-runner/rubric-v1.md` — the 4-check rubric as readable text the evaluator agent can pull in.
- `skills/playwright-driver/SKILL.md` — wraps `playwright-cli` (Microsoft, Apache-2.0). Documents install, session naming, snapshot/screenshot paths, headed vs headless modes.
- `skills/peekaboo-driver/SKILL.md` — wraps `peekaboo` (Steipete, MIT). Documents install, permissions, AX-snapshot, agent-mode + scripted-mode.
- `agents/ux-evaluator.md` — read-only agent, `model: opus`, color `blue`, tools `Read, Grep, Glob, Bash`.
- `.orchestrator/policy/test-profiles.json.example` — example registry showing smoke / full / a11y / onboarding profiles for the two first-target repos.
- `scripts/lib/test-runner/` — small helper modules: `fingerprint.mjs` (stable finding hash), `artifact-paths.mjs` (run-id + directory layout), `issue-reconcile.mjs` (glab create vs comment dispatch).
- `tests/lib/test-runner/*.test.mjs` — unit tests for the helpers above.

**Modified files (edited):**
- `CLAUDE.md` — add `/test` to the structure inventory, add a one-paragraph operational rule and a `## Session Config` field `test-runner: { default-profile: smoke }`.
- `README.md` — single-paragraph component bump (commands now N+1, skills N+3, agents N+1).
- `scripts/validate-plugin.mjs` — extend sub-checks to validate the three new skill directories + the new agent.
- `projects-baseline` — three template additions in a follow-up PR (out-of-tree from this repo).

### Architecture

```
/test [scope]
   │
   ▼
commands/test.md ──► skills/test-runner/SKILL.md (orchestrator)
                          │
                          ├── Phase 1: resolve target + profile
                          │     (convention OR .orchestrator/policy/test-profiles.json)
                          │
                          ├── Phase 2: dispatch driver(s)
                          │     ├──► skills/playwright-driver/SKILL.md
                          │     │      └─ Bash: playwright-cli ...
                          │     └──► skills/peekaboo-driver/SKILL.md
                          │            └─ Bash: peekaboo ...
                          │
                          ├── Phase 3: dispatch ux-evaluator
                          │     └──► agents/ux-evaluator.md (opus, read-only)
                          │            └─ reads artifacts, emits findings.json
                          │
                          ├── Phase 4: issue reconciliation
                          │     └─ glab issue create | comment
                          │
                          └── Phase 5: report.md + JSONL roll-up
```

Cross-skill composition follows the established session-orchestrator pattern (gitlab-ops for VCS, quality-gates for gate variants). No new mechanism is introduced — just new content in the existing slots.

### Data Model Changes
- New JSONL stream `.orchestrator/metrics/test-runs.jsonl` with one entry per `/test` invocation. Schema is additive-only and starts at v1: `{ run_id, timestamp, target, profile, drivers, finding_counts: { critical, high, medium, low }, issues: { created: [iid], commented: [iid] }, exit_code, duration_ms }`.
- New per-run directory `.orchestrator/metrics/test-runs/<run-id>/` with `report.md`, `findings.json`, `screenshots/`, `ax-snapshots/`. Retention: 30 days by default, configurable in Session Config.
- New optional registry `.orchestrator/policy/test-profiles.json` — JSON, schema documented in test-runner skill.

### API Changes
None — no public/HTTP API in this plugin. CLI surface: one new slash-command `/test [scope]`. Internal skill APIs are documented inline in each SKILL.md.

### External Dependencies (install at run-time, not bundled)
- `npm i -g @playwright/cli@latest` (Apache-2.0)
- `brew install steipete/tap/peekaboo` OR `npx -y @steipete/peekaboo` (MIT)
- Both are wrapped, not forked. Versions are documented in the driver skills with a known-good pin and an upper-bound advisory.

## 5. Risks & Dependencies

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| R1 | Upstream `playwright-cli` API drift (rapid Microsoft release cadence) | Medium — driver-skill calls break | Pin a known-good version in `skills/playwright-driver/SKILL.md`. Run a weekly sanity check via `/loop`. |
| R2 | Peekaboo macOS permissions friction (Screen Recording + Accessibility) | High on first run — blocks Mac path entirely | `peekaboo-driver` calls `peekaboo permissions status` before every run; on missing permission, surface remediation via `AskUserQuestion`, never fail silently. |
| R3 | LLM rubric produces noisy MEDIUM/LOW findings → issue triage fatigue | Medium — operator abandons reconciliation | Triage UX is a single `AskUserQuestion` (multi-select), not one-question-per-finding. Stable fingerprints prevent re-triage of the same finding. |
| R4 | Opus cost on `ux-evaluator` runs becomes noticeable on frequent `/test` invocations | Low — Opus runs once per invocation, not per agent | Document the cost-per-run order of magnitude in the skill (typical: a few cents). Allow `model: inherit` override per Session Config field if a deployment wants Sonnet. |
| R5 | Token bloat regression — someone wires Playwright MCP back in instead of CLI | High — re-introduces the 4× token cost we just avoided | `skills/playwright-driver/SKILL.md` carries a `<HARD-GATE>` explicitly forbidding MCP for browser drive. validate-plugin grep canary fails on `playwright-mcp` references (scope: `skills/playwright-driver/**` and `scripts/lib/test-runner/**`). |
| R6 | Finding fingerprint collisions or instability across runs | Medium — duplicate issues filed | Fingerprint uses scope + check-id + locator-path, hashed. Unit-tested. Stable for the same DOM/AX surface. |
| R7 | UX rubric definition lacks a clean way to add v2 checks without breaking v1 | Low — but locks us in if we ignore it | Rubric lives in `skills/test-runner/rubric-v1.md` as readable rules. v2 ships as `rubric-v2.md`. `findings.json` carries `rubric_version` so historical comparisons stay clean. |
| R8 | projects-baseline integration drifts behind plugin releases | Medium — new repos lose `/test` capability | Treat baseline integration as part of the Definition of Done for this feature. Add a `/repo-audit` sub-check that flags repos missing the template. |
| R9 | Concurrent `/test` runs on the same target collide in artifact dirs | Low — but observable | Run-id includes `pid` + millisecond timestamp; artifact dir guaranteed unique. |

### Dependencies
- **Tools upstream:**
  - `playwright-cli` (microsoft/playwright-cli, Apache-2.0, 10.3 k⭐, active 2026-05) — wrap, do not fork.
  - `peekaboo` (steipete/peekaboo aka openclaw/Peekaboo — same repo, MIT, 4 k⭐, active 2026-05) — wrap, do not fork.
- **Internal:**
  - `skills/gitlab-ops/` for VCS CLI dispatch (issue create / comment).
  - `skills/_shared/config-reading.md` for Session Config parsing.
  - `agents/qa-strategist.md` — pattern reference (read-only reviewer shape).
  - `skills/discovery/` — pattern reference (interactive triage via AskUserQuestion).
- **Open issues to link or close on landing** (per Wave-1 research):
  - `#41 feat(gitlab-portfolio): cross-repo issue dashboard skill` — `/test`'s reconciliation feeds the dashboard story; **link**, do not close.
  - `#357 Backfill unit tests for 16 untested modules` — separate concern, no overlap; leave as-is.
  - `#363 agents inline worked examples for novel rules` — `ux-evaluator` becomes a candidate target for inline worked examples; **link**.
  - mail-assistant project: a follow-up issue should be filed in its own repo to use `/test --target mail-assistant` as part of its V3.5+ pre-release gate.
- **Out-of-scope, surfaced as separate items** (from Wave-1 research, not part of this PRD):
  - **Journeys data model** in `aiat-pmo-module` (operator-stated need: 1 customer → multiple journeys → multiple projects) — the `Initiative → ProjectTask` schema does not model journeys today. Belongs in a separate PRD against the aiat-pmo-module repo.
  - **CI status / deployable-now check for EspoCRM module** — operator-stated need: "ist was wir aktuell haben deploybar". Belongs in `/session housekeeping` flow, not in this feature.

### Definition of Done
- All AC-1 through AC-6 scenarios pass.
- `npm test` green (existing 4 740 tests + new test-runner unit tests).
- `npm run typecheck`, `npm run lint` green.
- `scripts/validate-plugin.mjs` extended and green for the new skill/agent files.
- `/test --target aiat-pmo-module` executed once successfully against the real EspoCRM stack — report committed to a `docs/test-runs/proof-aiat-pmo-module-<date>.md`.
- `/test --target mail-assistant` executed once against the SwiftUI onboarding — proof report committed similarly.
- projects-baseline templates added in a paired PR; new-repo scaffold smoke-tested.
- CLAUDE.md + README updated, doc-consistency check green.
- Pipeline green on first push from feature branch.
