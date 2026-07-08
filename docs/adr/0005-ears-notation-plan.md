# ADR 0005: EARS Notation for /plan

> Status: ACCEPTED · session main-2026-05-19-deep-2 · issue #440
> Source research: "EARS Evaluation" (#440; archived in the private Meta-Vault)
> Project-instruction file resolution: `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see `skills/_shared/instruction-file-resolution.md`. References to `CLAUDE.md` below resolve via that precedence rule.

## Context

Spec-Driven Development (SDD) — specifications that *generate* code and tests rather than merely guide them — is the second-largest 2026 community trend. The premise: *"User stories become API endpoints. Acceptance scenarios become tests."* ([github/spec-kit `spec-driven.md`](https://github.com/github/spec-kit/blob/main/spec-driven.md)). EARS (Easy Approach to Requirements Syntax — Mavin / Rolls-Royce, RE'09; used by Airbus, Bosch, NASA, Siemens; five templates Ubiquitous/State-driven/Event-driven/Optional/Unwanted + Complex — [alistairmavin.com/ears](https://alistairmavin.com/ears/)) is the constrained `shall`-clause grammar the SDD ecosystem points at for machine-checkable acceptance criteria. Issue #440 asked whether `/plan feature` (and the `/brainstorm` design-spec follow-up) should emit EARS.

**Issue-framing correction (load-bearing).** #440 implicitly assumed Spec Kit standardises on EARS. It does not. The research established (cited):

- **GitHub Spec Kit does NOT use EARS.** `spec-template.md` ships Given/When/Then acceptance scenarios (`1. **Given** [state], **When** [action], **Then** [outcome]`) plus numbered `FR-NNN` MUST-statements; `spec-driven.md` never mentions EARS. EARS support is **issue #1356** — opened 2025-12-20, *state: open, no assignee, no labels, no maintainer triage* — proposing the exact three options #440 itself raises ([spec-kit/templates/spec-template.md](https://github.com/github/spec-kit/blob/main/templates/spec-template.md), [spec-kit#1356](https://github.com/github/spec-kit/issues/1356)).
- **Only AWS Kiro and gotalab/cc-sdd genuinely emit EARS today.** Kiro's `requirements.md` = user stories with EARS acceptance criteria ([kiro.dev/docs/specs](https://kiro.dev/docs/specs/)); cc-sdd wraps Kiro's loop as Agent Skills and outputs "EARS-format requirements with acceptance criteria" ([github/gotalab/cc-sdd](https://github.com/gotalab/cc-sdd)).

So **EARS is the trajectory, not a settled de-facto standard** (Kiro live, cc-sdd live, the 71k-star flagship still on Given/When/Then with EARS un-triaged). This materially lowers replace-urgency and raises augment-attractiveness.

**Our code-state today (verified).** `/plan feature` already emits Gherkin Given/When/Then as freeform Markdown: `skills/plan/prd-feature-template.md:39-60` (fenced ` ```gherkin ` blocks, one per Feature Area + an Edge Case block), `skills/plan/mode-feature.md:86` (1-3 Gherkin scenarios per sub-feature), `skills/plan/SKILL.md:267` (each Given/When/Then block → one sub-issue). `skills/plan/prd-reviewer-prompt.md:31` hard-codes a "Given/When/Then with concrete values" testability check. `skills/brainstorm/SKILL.md:144-181` has *no* acceptance-criteria section at all (AC deferred to the `/plan` hand-off). `skills/write-executable-plan/SKILL.md:60-126` Step 1 manually derives a failing test from prose AC — the natural EARS→vitest seam.

**`appetite:` / `MVP-XXX` orthogonality (verified, decisive).** The `appetite:` Shape-Up time-box lives in PRD frontmatter and the `appetite:N w` issue label (`prd-feature-template.md:13`, `mode-feature.md:120`); `MVP-XXX` is a commit-message↔scope-item link (`.claude/rules/mvp-scope.md:24-26`). Neither writes into the Section-3 acceptance-criteria slot EARS would occupy. The research confirmed **no conflict on any of the three options** — these are orthogonal axes, not casualties of EARS adoption. The "preserve our novel constructs" concern in #440 is therefore an argument against a *careless replace*, not a blocker for adoption.

## Decision

**Decision: Add-Section (= Adapter in the session-brief vocabulary) — add an `## Acceptance Criteria (EARS)` companion section alongside the existing narrative Gherkin block; do NOT Replace Gherkin and do NOT Stay Gherkin-only.** `/plan feature` and `/brainstorm` will emit a parseable EARS clause-set in addition to (not instead of) the current Gherkin Given/When/Then, and `write-executable-plan` Step 1 gains a deterministic EARS→vitest stub seam.

> **Vocabulary note (cross-ADR):** "Adapter" here means an *additive, unconditional, ship-now* template section — it carries **no** Session-Config flag, no telemetry-promotion gate, and no falsifiable kill condition. This is deliberately distinct from the "Adapter" verdict in ADR 0002/0003, which denotes a *flag-gated, default-off, telemetry-promoted guarded spike*. The shared token spans two decision shapes; when cross-reading the cluster, treat 0005's Adapter as immediate-and-additive, not a guarded spike.

Rationale: The evidence makes Adopt (replace) and Stay both inferior to Adapter. **Adopt is rejected** because it would chase a format the 71k-star flagship (Spec Kit) has not itself committed to — EARS there is the un-triaged feature request #1356 — and would break the hard-coded `prd-reviewer-prompt.md:31` Given/When/Then check, forcing a reviewer rewrite for a non-settled standard. **Stay is rejected** because it forfeits the one mechanical, high-confidence win: the research established the EARS→vitest mapping is a 1:1 template-to-test-skeleton transform (Ubiquitous→invariant `it`, Event-driven→arrange/trigger/expect, State-driven→`describe` state-enter, Unwanted→error-path `it`, Optional→`it.skipIf`) that slots directly onto the existing `write-executable-plan` Step-1 seam and aligns with `.claude/rules/test-quality.md` (the EARS clause *is* the behavioural contract a quality-compliant test asserts). **Adapter captures the win at modest cost**: it keeps the narrative Gherkin (so existing PRDs and the reviewer check need no rewrite), leaves `appetite:`/`MVP-XXX` untouched (they never lived in the AC body), gives `/brainstorm` EARS as a *net-new* section with zero replacement risk, and makes our PRDs natively consumable by Kiro/cc-sdd's `/kiro-spec-requirements` instead of requiring a lossy re-derivation. The research's worked example — issue #458's bundled `mode: warn / strict / off` checklist criterion split into three atomic Event-driven/Unwanted EARS clauses mapping 1:1 onto the `mode=off|warn|strict` cases in `tests/lib/wave-executor/persona-gate-hook.test.mjs` — confirms EARS feels natural and clarifying for our domain, with the `appetite:1w` label and any `MVP-XXX` ref demonstrably unaffected. (Empirical validation was docs+code-analysis only per session-start AUQ — no generator prototype or live Kiro run; mechanical EARS→vitest emitter validation is a follow-up, not a precondition for this verdict.)

## Consequences

**What changes:**

- **`/plan feature` template** (`skills/plan/prd-feature-template.md`, `skills/plan/mode-feature.md`): a new `## Acceptance Criteria (EARS)` section is added *below* the existing Gherkin Section 3. Each Feature Area emits its Gherkin scenario(s) *and* the equivalent EARS clause-set (Ubiquitous / State-driven / Event-driven / Optional / Unwanted / Complex). The mapping `mode-feature.md:86` gains an EARS-derivation step parallel to the Gherkin one.
- **`write-executable-plan` Step 1** (`skills/write-executable-plan/SKILL.md:60-126`): the "Write the failing test" step gains an EARS→vitest stub seam — when the source PRD/spec carries an EARS section, Step 1 emits the deterministic per-template test skeleton (per the research's mapping table) instead of re-deriving a test from prose. Gherkin-only specs continue to work via the existing manual path (backward-compatible).
- **`/brainstorm` design spec** (`skills/brainstorm/SKILL.md:144-181`): gains a *net-new* optional `## Acceptance Criteria (EARS)` section between Trade-offs and Hand-off. Pure addition — `/brainstorm` had no AC section, so there is no replacement risk and no migration of existing specs.
- **Reviewer prompt** (`skills/plan/prd-reviewer-prompt.md`): gains an *additional* EARS-shape awareness clause (well-formed `shall` clauses, edge cases enumerated via Unwanted/Optional templates) — appended to, not replacing, the existing `:31` Given/When/Then check.

**What we keep (explicitly unchanged):**

- The narrative Gherkin Given/When/Then block remains the human-facing AC format — existing PRDs need zero rewrite, and `prd-reviewer-prompt.md:31`'s testability check stays as-is.
- `appetite:` (Shape-Up frontmatter + `appetite:N w` label) and `MVP-XXX` (commit-message↔scope-item link) are untouched — they live in frontmatter and commit messages, never in the AC body; the research confirmed no conflict under any option.
- The per-AC-block → sub-issue decomposition (`SKILL.md:267`, `mode-feature.md:99-103`) is preserved; EARS clauses are a *tighter* seam (one `shall` = one assertion) that fits the existing "one issue per acceptance-criterion group" rule, not a disruption.

**Ecosystem interactions:** Our `/plan` PRDs become a native input to Kiro's and cc-sdd's `/kiro-spec-requirements` step — external SDD spec→test→impl pipelines can consume our acceptance criteria without a lossy re-derivation. We also remain forward-compatible if Spec Kit triages #1356 and ships EARS, since we will already emit the canonical Mavin grammar. EARS additionally *forces* edge/unwanted-case enumeration (first-class `If…Then…shall` and `Where` templates) that our current single ad-hoc Gherkin "Edge Case" block leaves optional — a modelling-fidelity gain (state-via-`While` vs event-via-`When`) we get for free alongside the interop.

## Follow-ups

Issues to file (all additive, none blocking; ordered by dependency):

1. **Add `## Acceptance Criteria (EARS)` companion section to the `/plan feature` template** — edit `skills/plan/prd-feature-template.md` and `skills/plan/mode-feature.md` so each Feature Area emits Gherkin *and* the equivalent EARS clause-set (five templates + Complex). Acceptance: a `/plan feature` run produces both blocks; `appetite:`/`MVP-XXX` unchanged.
2. **EARS→vitest stub generator in `write-executable-plan` Step 1** — implement the per-template test-skeleton emitter (research mapping table) wired into `skills/write-executable-plan/SKILL.md` Step 1; falls back to the existing manual derivation when no EARS section is present. Acceptance: an EARS clause-set deterministically yields runnable `it`/`describe`/`it.skipIf` stubs matching `.claude/rules/test-quality.md` (one meaningful assertion, no branching).
3. **Add an optional `## Acceptance Criteria (EARS)` section to the `/brainstorm` design spec** — net-new section in `skills/brainstorm/SKILL.md:144-181` between Trade-offs and Hand-off; optional, no migration.
4. **Add EARS-awareness to the PRD reviewer prompt** — append an EARS-shape clause to `skills/plan/prd-reviewer-prompt.md` (well-formed `shall`, edge cases via Unwanted/Optional) *alongside* the existing `:31` Given/When/Then testability check; do not remove the Gherkin check.

## Implementation Status — deep-3 (2026-05-19)

ACCEPTED → **IMPLEMENTED**. All 4 follow-up tasks shipped (#487):

1. **`/plan` EARS Add-Section** — `## 3.A Acceptance Criteria (EARS)` companion section added to `skills/plan/prd-feature-template.md`; `## 5.A` in `skills/plan/prd-full-template.md` (Section 3 of the full template is "Target Audience & Personas", so EARS lands semantically after Section 5 Success Criteria — accepted deviation). `skills/plan/mode-feature.md` Phase 2 fill-table row added.
2. **`/write-executable-plan` EARS→vitest 1:1 mapping** — conditional seam + 5-pattern mapping table in `skills/write-executable-plan/SKILL.md` Step 1; seam note in `plan-template.md`. Exemplar: `tests/lib/wave-executor/persona-gate-hook.test.mjs`.
3. **`/brainstorm` net-new EARS section** — `## Acceptance Criteria (EARS) [optional]` in `skills/brainstorm/SKILL.md` Phase 4 (zero replacement risk).
4. **`prd-reviewer-prompt.md` additive clause** — EARS-awareness sibling bullet appended after the Gherkin testability check (existing check unchanged).

Canonical pattern names verified verbatim against alistairmavin.com/ears/ (2026-05-19): Ubiquitous, State-driven, Event-driven, Optional feature, Unwanted behaviour (UK spelling), + Complex. Backwards-compat preserved (narrative Gherkin remains primary; EARS is optional/additive). Test coverage: 50 structural tests (W3 P1) + 19 edge-case tests (W4 Q1). Verdict from W4 architect-reviewer: PASS (matches ADR contract exactly).
