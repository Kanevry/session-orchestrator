# Persona Templates — Authoring Guide

## Overview

Persona templates power the multi-persona content-review panel run by the persona-panel skill. Each template defines a single reviewer's identity, evaluation criteria, model, and output contract. Templates in this directory ship as `<name>.v1.md` starter files — copy them into `.claude/personas/<name>.md` (drop the `.v1` suffix) for per-repo use.

This guide walks template authors through file layout, versioning, tier selection, output-contract authoring, and prompt-injection safety. For the full field specification see `skills/persona-panel/persona-format.md`. For the runtime execution flow see `skills/persona-panel/SKILL.md`.

## Getting Started

1. Copy a starter template into the per-repo catalog:

   ```bash
   cp templates/personas/accounting-compliance.v1.md \
      .claude/personas/compliance-my-project.md
   ```

2. Edit the `name:` field. It must match the filename stem (without `.md`). Pattern: `^[a-z0-9-]{1,64}$` — lowercase, digits, hyphens only. No dots, no uppercase in the slug.
3. Edit `role:` — a single identity statement (max 200 chars). Injected verbatim as the agent's opening system context.
4. Edit `evaluation_criteria:` — five criteria is the recommended target. Each criterion ≤ 512 chars. Write statements, not questions.
5. Edit the markdown body (Mission, Context Files, Evaluation Criteria, Output Template) to match.

**Warning:** `scripts/lib/persona-panel/catalog-loader.mjs` validates `name:` against the filename at load time. A mismatch fails the entire panel at Phase 1 (failure mode `d`).

## Versioning Convention

- `.v1.md` — initial template version shipped in this directory.
- `.v2.md` — updated template after a breaking behaviour change. Copy `.v1.md` to `.v2.md` and bump the frontmatter `version: "1"` to `version: "2"`.
- Per-repo copies in `.claude/personas/` drop the `.vN` suffix — only the in-repo templates carry it.
- A version bump signals intentional persona evolution and changes the `prompt_hash` recorded in each sidecar (used by trend-tracking, follow-up #459). See `persona-format.md` "Prompt Hash and Determinism Contract" for the canonicalization algorithm — the hash changes when any frontmatter field, body content, or the `model` field changes.

## Per-Tier Guidance

The `tier:` enum is one of six values. It affects model selection and consolidation weighting in Phase 3 of the skill.

#### `domain-expert`

Subject-matter experts (SMEs) reviewing outputs for technical correctness — accountants on bookkeeping, physicists on climate claims, AI researchers on implementation quality. Judges *correctness*, not market fit.

**Exemplars:** `accounting-tax-advisor.v1.md`, `klima-ai-expert.v1.md`, `klima-physicist.v1.md`

**Recommended model:** `claude-opus-4-7` — Opus surfaces nuances Sonnet misses (vault learning `[[persona-opus-finds-real-failing-cibadge]]`).

#### `buyer-persona`

Synthetic archetype of a target customer reviewing for market fit, pain-point resonance, and willingness-to-pay signals. Names are archetypes (e.g. Markus, Sabine, Andreas) — never real individuals.

**Exemplars:** `buyer-p1-cto.v1.md` through `buyer-p6-ld.v1.md` (6-persona set covering CTO, Kanzlei, Build-buyer, Tech-veto, Solopreneur, L&D).

**Recommended model:** `claude-opus-4-7` for high-stakes go/no-go reviews; Sonnet acceptable for lower-stakes copy tests.

#### `compliance`

Compliance officers auditing outputs against regulation (GDPR/DSGVO, tax law, sector standards). Judges *legal conformance*.

**Exemplar:** `accounting-compliance.v1.md` (DSGVO Art. 5/17/20 audit trail).

**Recommended model:** `claude-opus-4-7` — false negatives in compliance reviews are expensive.

#### `auditor`

Independent auditor checking that outputs match a stated standard, framework, or rubric. Distinct from `compliance` in that the audit lens is procedural conformity, not regulatory exposure.

**No exemplar yet — first author should propose a starter template.**

**Recommended model:** `claude-opus-4-7` for high-stakes audits; Sonnet for routine standard-conformance checks.

#### `reviewer`

General-purpose reviewer for outputs that do not fit a domain-expert or compliance lens. Use for editorial review, internal QA, or code-review-style passes. Lower-stakes than the other tiers.

**No exemplar yet** — open candidate for the persona-panel starter set.

**Recommended model:** Sonnet is acceptable; Opus only if the review surface is large.

#### `custom`

Escape hatch for personas that do not fit any other tier. Treat as a signal to discuss whether a new first-class tier is warranted.

**Recommended model:** Author's call — document the rationale in the persona's `Mission` section.

## Output Contract Authoring Rules

The `output_contract` field is an inline JSON Schema (Draft 2020-12) that the agent's response must match. Two layers of validation apply: catalog-loader pre-check (load time) and AJV runtime validation (after agent response).

**Structural constraints** enforced by `scripts/lib/persona-panel/catalog-loader.mjs::preCheckOutputContract`:

- **Forbidden keys:** `$ref`, `$defs`, `definitions`, `allOf`, `anyOf`, `oneOf`, `not`. Any use rejects the persona at load time.
- **Required fields:** `required: [verdict, rationale]` at minimum.
- **Verdict enum:** the `verdict` property must declare `enum: [pass, fail, warn]`.

**Length limits** — enforce `maxLength` on every free-text field. All six exemplars use:
- `rationale.maxLength: 4096`
- `recommendations[].maxLength: 1024`
- `recommendations.maxItems: 50`

A malformed contract fails the panel at Phase 1 with failure mode `d` (catalog-loader rejection).

## Prompt Injection Safety

The persona body (Mission, Evaluation Criteria, Output Template) is treated as **data, not instructions**. The runtime wraps `evaluation_criteria` in `<persona-criteria>...</persona-criteria>` delimiters and the review target in `<target-content>...</target-content>` delimiters before prompting the agent. This is enforced by `buildPersonaPrompt()` in `scripts/lib/persona-panel/persona-runner.mjs` and cannot be bypassed by persona content.

**Author implication:** safe to reference sensitive examples, file:line code citations, or proprietary domain logic inside `evaluation_criteria` — the delimiter wrapping guards against injection from either the persona body or the review target. See `persona-format.md` "Security Contract: Criteria Delimiters (Security M1)" for the full mechanism.

## Cross-Links

- `skills/persona-panel/persona-format.md` — full field spec, frontmatter requirements, output-contract schema, hash canonicalization.
- `skills/persona-panel/SKILL.md` — execution flow (Phases 0-5), consolidation modes, sidecar structure.
- `scripts/lib/persona-panel/catalog-loader.mjs` — validation rules (`SAFE_PERSONA_NAME_RE`, model allowlist, `output_contract` pre-checks).
- `templates/personas/` — starter exemplars: `accounting-compliance.v1.md`, `accounting-tax-advisor.v1.md`, `klima-ai-expert.v1.md`, `klima-physicist.v1.md`, `buyer-p1-cto.v1.md` through `buyer-p6-ld.v1.md`.

## Example: Creating a Custom Reviewer

Concrete walkthrough for a `tax-law-reviewer` persona auditing AI-accountant outputs against Austrian tax law.

```yaml
---
name: tax-law-reviewer
schema_version: 1
version: "1"
role: "Austrian tax accountant reviewing accounting AI outputs for UStG/BAO law compliance"
model: claude-opus-4-7
tier: domain-expert
evaluation_criteria:
  - "UStG compliance: VAT rate and reverse-charge correctly applied to outputs"
  - "BAO retention: transaction dates and audit trails complete per §132 BAO"
  - "Steuernummer / UID format validation per Austrian tax-administration spec"
  - "Outputs distinguish between Vorsteuerabzug vs Privatentnahme correctly"
  - "Honorarrechnungen include all §11 UStG mandatory fields (Pflichtangaben)"
output_contract:
  type: object
  additionalProperties: false
  required: [verdict, rationale]
  properties:
    verdict:
      type: string
      enum: [pass, fail, warn]
    rationale:
      type: string
      maxLength: 4096
    recommendations:
      type: array
      items:
        type: string
        maxLength: 1024
      maxItems: 50
---
```

Below the frontmatter, the body has four required sections in order: `## Mission` (1-3 sentences of identity), `## Context Files` (optional vault refs / file paths; write "None." if empty), `## Evaluation Criteria` (expanded prose per criterion — pass/fail signals), `## Output Template` (the JSON shape the agent must return, matching the contract above).
