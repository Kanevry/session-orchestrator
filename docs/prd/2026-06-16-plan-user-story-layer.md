# Feature: Optional User-Story Layer for /plan

**Date:** 2026-06-16
**Author:** Bernhard + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 1w
**Parent Project:** session-orchestrator (standalone feature, no open epic — lineage: #487 / #440 / ADR-0005)

## 1. Problem & Motivation

### What
Add an **optional User-Story intent layer** to the `/plan` skill (`feature` + `new` modes). When enabled, `/plan` emits a `## User Stories` section in the PRD — canonical `Als <Persona> möchte ich <Capability>, damit <Nutzen>` form — that **links** each story to its existing acceptance criteria (Gherkin §3 / EARS §3.A) and derives **one issue per story** (story text + linked ACs in the issue body). The layer is triggered by a single explicit Wave-1 Q&A question. When the operator declines, behaviour is **byte-for-byte status quo** (acceptance-criterion-group → issue).

### Why
Today the `/plan` chain runs `Persona/Who → Scope-Items → Acceptance Criteria (Gherkin + EARS) → Issues`. The repo has the **behaviour half** of specification solid (Gherkin + EARS + the `write-executable-plan` seam), but the **intent half is missing**: the chain jumps straight from persona to scope items, so the `damit`/"so-that" value never gets its own home and issues lose their anchor to *who needs this and why*. User stories are not a substitute for acceptance criteria — research confirms they are a complementary layer: story = who/why, Gherkin = verify, EARS = system-shall. The gap is the intent layer, not the behaviour layer.

`/plan` is the planning engine across the whole baseline ecosystem — much of its traffic is technical/chore work where forcing `As a developer I want…` is a documented anti-pattern. The deliberate design choice is therefore **optional and explicitly opt-in per run**, never "always".

### Who
The **operator/planner** running `/plan` on user-facing features — the genuine end-user of the planning engine — across the baseline ecosystem repos. Beneficiaries downstream: anyone reading the resulting backlog who needs the "why" attached to an issue without re-reading the full PRD.

## 2. Solution & Scope

### In-Scope
- [ ] Wave-1 Q&A toggle question ("User-Story-Schicht für dieses Feature erzeugen?") in `feature` and `new` modes, placed adjacent to the existing audience/persona question.
- [ ] New `## User Stories` PRD section (un-numbered, collision-proof) in both `prd-feature-template.md` (between §2 Scope and §3 Acceptance Criteria) and `prd-full-template.md` (between §3 Personas and §4 Solution & Scope), emitted only when the toggle is `yes`.
- [ ] Story→issue derivation: when stories exist, each story = 1 issue, body carries the story text + its linked Gherkin/EARS acceptance criteria. Status-quo derivation (AC-group → issue) preserved when no stories.
- [ ] Minimal, gated reviewer criterion #7 in `prd-reviewer-prompt.md`: active **only** when stories were requested — checks (a) section present, (b) `Als/möchte/damit` form complete, (c) each story links ≥1 acceptance criterion. No INVEST gate.
- [ ] Tests in `tests/skills/plan/` covering story-section existence, the toggle-off status-quo path, and the section-ordering invariant.

### Out-of-Scope
- New Session-Config key — explicitly rejected; the Q&A-gate was chosen over a config flag (avoids `claude-md-drift-check` Check-6 parity work, no heuristic to drift).
- Audience/visibility auto-heuristic for the gate — rejected in favour of "always ask".
- Full INVEST reviewer gate (Independent/Negotiable/Estimable) — rejected as ceremony; only Valuable/Small/Testable-equivalent checks survive.
- `/plan retro` mode — retrospectives are backward-looking, no stories.
- `/brainstorm` skill and the `analyst` agent — deferred to a follow-up issue to keep the first slice coherent.
- **Renumbering any existing PRD section** (§3/§3.A/§4/§5/§5.A) — would break the EARS tests and the `write-executable-plan` seam. The new section is purely additive.
- Any change to the EARS heading literals or the `write-executable-plan` EARS→vitest contract.

## User Stories

> Dogfood — this PRD emits its own story layer. The operator/planner is the genuine end-user of `/plan`; the benefit (intent traceability) is real, so these are honest user stories, not dev-persona anti-patterns.
>
> Note: FA4 (gated reviewer criterion) is intentionally story-less — it is an internal-quality concern, not an operator-facing capability, so there is no US-4 by design.

### US-1 (→ FA1 Toggle)
**Als** Planer **möchte ich** beim `/plan`-Lauf explizit entscheiden, ob eine User-Story-Schicht erzeugt wird, **damit** technische/Chore-Plans nicht mit Fake-Personas verwässert werden und user-facing Plans ihren Intent behalten.
- ↳ AC: §3 FA1 (Gherkin) · EARS: §3.A FA1

### US-2 (→ FA2 Section + Traceability)
**Als** Planer **möchte ich**, dass jede emittierte User Story auf ihre Acceptance Criteria verlinkt (Story → §3/§3.A), **damit** der "Warum"-Nutzen bis ins Backlog erhalten bleibt und kein Gherkin dupliziert wird.
- ↳ AC: §3 FA2 (Gherkin) · EARS: §3.A FA2

### US-3 (→ FA3 Issue Derivation)
**Als** Planer **möchte ich**, dass bei vorhandenen Stories aus jeder Story genau ein Issue mit Story-Text + verlinkten ACs im Body entsteht, **damit** jedes Backlog-Item seinen Persona→Story→Issue-Anker behält.
- ↳ AC: §3 FA3 (Gherkin) · EARS: §3.A FA3

## 3. Acceptance Criteria

### Feature Area 1 — Wave-1 Toggle
```gherkin
Given a /plan feature or /plan new run
When Wave 1 reaches the audience/persona question
Then the operator is asked exactly one additional question whether to emit a User-Story layer
And the question is asked unconditionally (no audience heuristic gates it)
```

### Feature Area 2 — User Stories section + traceability
```gherkin
Given the operator answered "yes" to the Wave-1 story toggle
When the PRD is generated
Then a "## User Stories" section is emitted between Scope and Acceptance Criteria
And each story uses the "Als/möchte/damit" form
And each story carries a "↳ AC:" pointer to at least one §3/§3.A acceptance criterion
And no existing section is renumbered
```

### Feature Area 3 — Story-first issue derivation
```gherkin
Given a PRD containing a populated User Stories section
When Phase 6 derives the issue structure
Then each user story becomes exactly one issue
And the issue body contains the story text plus its linked Gherkin/EARS acceptance criteria
```

### Feature Area 4 — Gated reviewer criterion
```gherkin
Given stories were requested and the PRD reviewer runs
When the reviewer evaluates the PRD
Then it checks the stories are present, the Als/möchte/damit form is complete, and each story links ≥1 AC
And it does NOT apply Independent/Negotiable/Estimable INVEST checks
```

### Edge Case / Error Handling
```gherkin
Given the operator answered "no" to the Wave-1 story toggle
When the PRD is generated and Phase 6 runs
Then no User Stories section is emitted
And issue derivation is byte-for-byte the current acceptance-criterion-group behaviour
And the reviewer applies only the existing 6 criteria
```
```gherkin
Given the new User Stories section is added to the full template
When write-executable-plan scans the PRD for its EARS seam
Then the User Stories heading does not match the "## 3.A" or "## Acceptance Criteria (EARS)" trigger
And no story content is mis-parsed as an EARS clause-set
```

## 3.A Acceptance Criteria (EARS)

> Companion to Section 3 — EARS clause-set for the same Feature Areas. Feeds `/write-executable-plan` Step-1 deterministic stub generation.

### Feature Area 1 — Wave-1 Toggle

**Ubiquitous:**
- The plan skill shall present the User-Story toggle question in Wave 1 of both `feature` and `new` modes.

**Event-driven:**
- When a `/plan feature` or `/plan new` Wave 1 is presented, the plan skill shall include exactly one additional toggle question adjacent to the audience question.

### Feature Area 2 — User Stories section + traceability

**State-driven:**
- While the story toggle is `yes`, the plan skill shall emit a `## User Stories` section between Scope and Acceptance Criteria.

**Ubiquitous:**
- Each emitted user story shall use the `Als <persona> möchte ich <goal> damit <benefit>` form and carry a pointer to at least one §3/§3.A acceptance criterion.

**Unwanted behaviour:**
- If the User Stories section is added, then the plan skill shall not renumber any existing PRD section.

### Feature Area 3 — Story-first issue derivation

**State-driven:**
- While a PRD contains a populated User Stories section, the issue-derivation step shall create exactly one issue per story with the story text and its linked acceptance criteria in the body.

**Optional feature:**
- Where no User Stories section is present, the issue-derivation step shall use the existing acceptance-criterion-group derivation.

### Feature Area 4 — Gated reviewer criterion

**State-driven:**
- While stories were requested, the PRD reviewer shall verify story presence, complete `Als/möchte/damit` form, and ≥1 AC link per story.

**Unwanted behaviour:**
- If stories were not requested, then the reviewer shall apply only the existing six criteria.

### Edge Case / Error Handling

**Unwanted behaviour:**
- If `write-executable-plan` scans a PRD carrying a `## User Stories` section, then it shall not match that heading as an EARS seam trigger.

## 4. Technical Notes

### Affected Files
- `skills/plan/mode-feature.md` — add the Wave-1 toggle question (5→6 questions; AUQ split shifts 3+2 → 3+3); add Phase-2 fill-table row for the conditional User Stories section; update the Phase-3 issue-derivation source when stories present.
- `skills/plan/mode-new.md` — add the parallel Wave-1 toggle question and issue-derivation note.
- `skills/plan/prd-feature-template.md` — insert `## User Stories` (optional/gated) between §2 and §3.
- `skills/plan/prd-full-template.md` — insert `## User Stories` (optional/gated) between §3 Personas and §4 Solution & Scope.
- `skills/plan/SKILL.md` — Phase 6.1 derive-issue-structure: story-present branch (story → issue) with status-quo fallback; note the 6→7 reviewer criterion count.
- `skills/plan/prd-reviewer-prompt.md` — add gated criterion #7; bump the advertised "6 criteria" count and the 6-row output table to 7.
- `tests/skills/plan/` — new test asserting story-section existence + ordering invariant + toggle-off status-quo path (mirror the structure of `ears-section.test.mjs` / `ears-edge-cases.test.mjs`).

### Architecture
Additive, opt-in, mirrors the **ADR-0005 "Add-Section / Adapter"** pattern (the same shape that landed EARS via #487): a new optional template section + a Q&A gate + a conditional derivation branch, with the existing path untouched when the gate is off. Heading is **un-numbered `## User Stories`** in both templates — chosen specifically so it never matches the `write-executable-plan` EARS seam triggers (`## Acceptance Criteria (EARS)` / `## 3.A`).

### Data Model Changes
None.

### API Changes
None. Issue bodies remain free-text (no machine-parsed contract), so the story-first body is a narrative change, not a schema change.

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| `## 3.A` heading collision: full-template story slot would false-trigger the `write-executable-plan` EARS seam | High (silent mis-parse of stories as EARS) | Use un-numbered `## User Stories` in both templates; add an edge-case test asserting the heading does not match the seam triggers |
| Renumbering existing sections breaks EARS tests + seam | High | Section is purely additive; no §3/§3.A/§4/§5/§5.A renumber; ordering-invariant test guards it |
| Wave-1 6th question breaks the 3+2 AUQ split assumption | Medium | Re-split to 3+3 explicitly in `mode-feature.md` / `mode-new.md`; note the change in `SKILL.md` Phase 3.2 |
| Reviewer "6 criteria" count drifts out of sync with the new criterion | Low | Update both the prose count and the 6-row output table to 7 in the same edit; test the count string |
| Forcing stories onto technical/chore plans (dev-persona anti-pattern) | Medium | The gate is explicit per-run; "no" → byte-for-byte status quo; documented as the intended technical-work path |

### Dependencies
- ADR-0005 / #487 (EARS Add-Section): design lineage and the contract this feature must not break. Status: implemented/closed.
- `write-executable-plan` EARS seam: must remain intact — verified via the collision-proof heading + edge-case test.
- #440 (EARS evaluation): referenced for the `MVP-XXX` / `appetite:` orthogonality (untouched here).

### Follow-ups (deferred, out of this slice)
- Extend the optional story layer to `/brainstorm` design specs (it has its own EARS section feeding the same seam).
- Make the read-only `analyst` agent story-aware (second PRD reviewer).
