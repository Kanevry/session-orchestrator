# Feature: /discovery Feature Scope + PM-Technique Cribs (pm-skills evaluation)

> **RECONSTRUCTED 2026-07-06** (session main-2026-07-06-deep-1): the original PRD from the 2026-07-05 planning session was never committed — this file was rebuilt from Epic #750 + issue bodies #751-#763 so the path references resolve. Wording is a faithful reconstruction, not the original text.

**Date:** 2026-07-05 (original planning session)
**Reconstructed:** 2026-07-06
**Status:** In progress — FA1/FA2/FA3/FA4 delivered 2026-07-06 (session main-2026-07-06-deep-1), FA5 open
**Appetite:** Medium Batch (2w) — see `appetite:2w` on #751
**Parent Epic:** #750 — `[Epic] /discovery feature scope + PM-technique cribs (pm-skills eval)`

## 1. Context & Motivation

**What.** The `phuryn/pm-skills` evaluation (68-skill PM marketplace, MIT license) surfaced real technique value, but the verdict was: adopt selected value **without bulk-vendoring**. Concretely: extend `/discovery` with a grounded `feature` scope — evidence-anchored product/feature discovery riding our existing probe → verify → triage → issue rails — and crib proven PM techniques into `/grill`, `/brainstorm`, and `/plan`. Judgment-based PM (Opportunity Solution Tree, personas, market-sizing) deliberately stays **out** of the verified-findings pipeline; it is not falsifiable the way a grep-verified probe finding is.

**Why not vendor the marketplace wholesale:**
- Roster growth 43→111 skills dilutes dispatch (`auto-skill-dispatch` phrase-matching gets noisier per addition).
- Sunset-noise: most of the 68 skills would sit unused, becoming `sunset-review` churn within a session or two.
- Second-class wiring: vendored skills would not integrate with our Phase 4.2 verification discipline (PSA-006) or the issue-creation rails `/discovery` already has.
- Cursor-invisible: pm-skills targets Claude-Code-shaped skills; no guarantee of Cursor IDE parity, which this plugin maintains cross-platform.
- We already own ~80% of the underlying value (probe/verify/triage, `/grill` interrogation, `/brainstorm` Socratic design, `/plan` PRD generation) — the marginal adopt is techniques + the one true gap (an intent-audit discovery category), not a parallel skill roster.

**Who.** The operator running `/discovery` and `/plan`/`/grill`/`/brainstorm` across the repo fleet, who wants PM-quality technique coverage without a second skill catalog to maintain.

## 2. Scope

### In-Scope (Epic #750 core train)

| Slice | Issue | One-liner | PRD Functional Area |
|---|---|---|---|
| S1 | #751 | Wire `feature` into the scope-argument enum (SKILL.md, commands/discovery.md, pi/prompts/discovery.md) + config-field docs + finding Category field; add the runtime-router AUQ (grounded-scan / also-judgment / route-out / skip); promote `area:skills` to the canonical gitlab-ops taxonomy | FA1, FA3 |
| S2 | #752 | New `skills/discovery/probes-feature.md`: intent-drift probe (docs vs code enforcement) + stubbed-dead-feature probe (throw-not-implemented, dead flags, commented routes) | FA2 |
| S3 | #753 | New `tests/skills/discovery-probes-wiring.test.mjs`: scope-enum consistency + probe-file existence, with a fake-regression check | FA4 |
| S4 | #754 | Crib into `/grill`: kill-assumption operationalization + pre-mortem/Tiger-Paper-Tiger-Elephant + Value/Usability/Viability/Feasibility sweep | FA5 |
| S5 | #755 | Crib into `/brainstorm`: three-lens (PM/Designer/Engineer) divergent ideation + Mom-Test questioning discipline | FA5 |
| S6 | #756 | Crib into `/plan`: Opportunity Score ranking, Impact×Risk 2×2 triage, job-story format option | FA5 |

### Out-of-Scope (deferred follow-ups)

| Issue | One-liner |
|---|---|
| #757 | feature-request-cluster probe (issue-tracker scan) — needs a Phase 4.2 verification adaptation (glab/gh, not file Read) |
| #758 | OST (outcome→opportunity→solution) output-framing in the `/discovery` feature-scope report |
| #759 | Judgment-branch expansion of the S1 runtime router (inline OST/personas or routed hand-off) |
| #760 | persona-panel PM/Designer/Engineer 3-lens preset |
| #761 | pm-skills marketplace companion doc (install-alongside guidance, Option-B distribution) |
| #762 | scope-enum single-source consolidation (8-surface / 3-token-set duplication) |
| #763 | gitlab-ops SKILL.md fallback doc for the non-Premium HTTP-403 on native `blocks`/`is-blocked-by` |

Dependencies among all of the above are expressed via `relates_to` + body-ordering, not native GitLab `blocks` — this GitLab instance is non-Premium and native blocks return HTTP 403 (see #763).

## 3. Functional Areas

### FA1 — Scope-wiring + runtime router (#751)
**Status: delivered 2026-07-06 (session main-2026-07-06-deep-1).**
- `feature` is a valid value of the `/discovery` scope-argument enum across every tracked surface (SKILL.md, commands/discovery.md, pi/prompts/discovery.md).
- Config-field docs for `discovery-probes` and the finding `Category` field enumerate `feature` alongside existing scopes.
- A runtime-router `AskUserQuestion` fires at the head of the `feature` scope with four routes: grounded-scan, also-judgment, route-out, skip.
- Route selection is honored — `skip` short-circuits before any probe runs; `route-out` hands off to `/brainstorm` or `/plan` rather than running probes.

### FA2 — probes-feature.md (#752)
**Status: delivered 2026-07-06 (session main-2026-07-06-deep-1).**
- New `skills/discovery/probes-feature.md` in the markdown probe-agent style (parallel to `probes-code.md`).
- **intent-drift** probe: parses documented claims (README/architecture/permission docs) and greps each against code enforcement; flags documented-but-unenforced and undocumented-but-enforced pairs.
- **stubbed-dead-feature** probe: greps for `throw ... not implemented`, permanently-off feature flags, and commented-out routes.
- Both probes' findings pass Phase 4.2 verification (file:line re-read) before surfacing — no probe finding ships unverified.

### FA3 — area:skills taxonomy promotion (#751)
**Status: delivered 2026-07-06 (session main-2026-07-06-deep-1).**
- `area:skills` is promoted to the canonical gitlab-ops label taxonomy (alongside `area:testing`, `area:docs`, `area:vcs`).
- New issues touching skill bodies use `area:skills` consistently — evidenced by #751-#756, #757-#760 all carrying the label.

### FA4 — Wiring-guard test (#753)
**Status: delivered 2026-07-06 (session main-2026-07-06-deep-1).**
- New `tests/skills/discovery-probes-wiring.test.mjs` asserts scope-enum consistency across every tracked surface named in FA1.
- Asserts every `probes-<category>.md` referenced in `/discovery` Phase 3 actually exists and is non-empty.
- Includes a fake-regression check: temporarily remove `feature` from one surface, confirm the test goes RED, then revert — closes the zero-coverage gap this rule's `testing.md` § "Negative-Assertion Fake-Regression Check" requires.

### FA5 — PM-technique cribs: /grill, /brainstorm, /plan (#754, #755, #756)
**Status: open.**
- `/grill`: kill-assumption operationalized as Fails-if / Evidence-this-week / Kill-criterion / Cheapest-test, plus steelman-then-attack; pre-mortem prospective-hindsight with a Tiger/Paper-Tiger/Elephant taxonomy; a Value/Usability/Viability/Feasibility coverage sweep. Tactic-count references (e.g. "Five Tactics") are grep-verified after the rename.
- `/brainstorm`: three-lens divergent ideation (PM / Designer / Engineer, 5 ideas each, then converge) fills the GENERATE step the skill currently lacks; Mom-Test questioning discipline (ask about the past not the future, treat compliments as noise, talk less) is added to the interview phase.
- `/plan`: Opportunity Score (`Importance × (1 − Satisfaction)`) as an upstream scoping ranking; Impact×Risk 2×2 triage (Defer / Implement / Reject / Experiment) for surfaced risks; job-story format (`When [situation], I want…, so I can…`) offered as a story-toggle alongside the existing Als/möchte/damit format.

## 4. Non-Goals

- **Judgment-based PM stays out of the verified-findings pipeline.** OST, personas, and market-sizing are not falsifiable via grep/file-read the way probe findings are — they route to `/brainstorm`/`/plan` (FA1 router `also-judgment`/`route-out`) rather than becoming `/discovery` findings.
- **No bulk-vendoring of `phuryn/pm-skills`.** Adoption is technique-level cribs into existing skills, never a parallel 68-skill roster (see §1 why-not-vendor).
- **No native GitLab `blocks`/`is-blocked-by` dependency wiring in this Epic's issues** — this instance is non-Premium (403); `relates_to` + ordering is the substitute (#763 documents the fallback for future issues).
- **Scope-enum single-sourcing (#762) is explicitly deferred**, not solved by S1 — S1 wires `feature` into the existing multi-surface pattern; consolidating the pattern itself is a follow-up.

## 5. Dependencies & Sequencing

- **Core train: S1 → S2 → S3.** S2 (probes-feature.md) depends on S1 having activated the `feature` category in the scope enum and router; S3 (wiring-guard test) depends on both S1's tracked surfaces and S2's probe file existing, since it asserts consistency across all of them.
- **S4, S5, S6 (FA5) are independent** of the S1-S3 train and of each other — each cribs techniques into a single existing skill (`/grill`, `/brainstorm`, `/plan` respectively) with no shared code path.
- All cross-issue dependencies are expressed via `relates_to` + deliberate body-ordering (see §2 note) rather than native `blocks`, per the #763 fallback.
- Follow-ups #757-#763 have no hard dependency on each other; #762 (scope-enum consolidation) is guarded by the S3 wiring test once S3 lands, and #763 (gitlab-ops fallback doc) documents a process gap surfaced during the original 2026-07-05 planning session itself.
