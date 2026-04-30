---
title: ADR Template 3-Criteria Gate Extension (#315)
created: 2026-04-30
tracking-issue: "#315"
parent-epic: "#309"
target-repo: projects-baseline
status: ready-for-mr
---

# ADR Template 3-Criteria Gate Extension — MR Preview

This document is a copy-paste-ready preview of the cross-repo MR that will
land in `projects-baseline` to extend `docs/adr/000-template.md` with a
**"When to write an ADR"** section codifying the 3-criteria gate from
session-orchestrator's `skills/domain-model/ADR-FORMAT.md`. Closes **#315**
under the **#309 DDD-Trio** parent epic.

The plugin already ships the gate as part of the `domain-model` skill
(`skills/domain-model/ADR-FORMAT.md`, lines 30–47). Today every consumer
repo that scaffolds from `projects-baseline` gets the bare Nygard ADR
template (Context / Decision / Consequences) with **no guidance on when to
actually create one**. The result, observed in two prior sessions, is
ADR sprawl: trivial library swaps and easily-reversed config tweaks
recorded as ADRs, drowning the genuinely architectural decisions.

This MR vendors the 3-criteria gate verbatim from the plugin into the
baseline template, adding it as a new top-level section **above** the
existing Nygard structure. The Nygard sections (Context / Decision /
Consequences) stay byte-identical. ADRs already written under the
template (001–007 in repos that have adopted the baseline) are not
mutated.

---

## Context — why this gate exists

Without the gate, `domain-model` and ad-hoc agents over-produce ADRs.
mattpocock's framing (sourced upstream and adopted by the plugin's
`domain-model` skill) gives a 3-question test that filters out:

- Library swaps with a one-line revert path
- "Obvious" defaults nobody would question (e.g., "we use TypeScript")
- Forced moves with no genuine alternative considered

…while preserving:

- Architectural shape decisions (monorepo vs polyrepo, event-sourced
  write models, projection strategies)
- Integration patterns between bounded contexts
- Technology choices that carry quarter-scale lock-in
- Deliberate deviations from the obvious path
- Constraints invisible from the code alone (compliance, partner SLAs)

The goal of the gate is **fewer, better ADRs** — every ADR a future
reader actually wants to find, none they have to skim past.

---

## 3-Criteria Gate (verbatim from #315 spec / plugin source)

> Only write an ADR when **all three** are true:
>
> 1. **Hard to reverse** — cost of changing your mind later is meaningful
> 2. **Surprising without context** — a future reader will wonder
>    "why did they do it this way?"
> 3. **Result of a real trade-off** — there were genuine alternatives
>    and you picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it. If
it's not surprising, nobody will wonder why. If there was no real
alternative, there's nothing to record beyond "we did the obvious thing."

---

## Files to modify in projects-baseline

### `docs/adr/000-template.md`

**Diff stats:** `+~55 / -0` (extension only, no mutation of existing
sections).

The new section is appended **after** the existing Nygard structure
(Context / Decision / Consequences), placed under a clear top-level
`## When to write an ADR` heading so it reads as a gate that applies
**before** the rest of the template is filled in. Verbatim content to
be appended:

```markdown

---

## When to write an ADR

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is
   meaningful
2. **Surprising without context** — a future reader will look at the
   code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine
   alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it.
If it's not surprising, nobody will wonder why. If there was no real
alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model
  is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing
  communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus,
  auth provider, deployment target. Not every library — just the
  ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the
  Customer context; other contexts reference it by ID only." The
  explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using
  manual SQL instead of an ORM because X." Anything where a
  reasonable reader would assume the opposite. These stop the next
  engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because
  of compliance requirements." "Response times must be under 200ms
  because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If
  you considered GraphQL and picked REST for subtle reasons, record
  it — otherwise someone will suggest GraphQL again in six months.

### What does not qualify

- Library swaps with a one-line revert path (e.g., axios → fetch).
- Style/lint rule choices already covered by `.eslintrc` or
  `.prettierrc`.
- "Obvious" defaults — pinning a Node version, choosing pnpm over
  npm in a baseline-pnpm repo, picking Vitest in a Vite project.
- Forced moves where no real alternative was considered.
```

### `docs/adr/README.md` (if present)

**Diff stats:** `+3 / -0` (cross-link only).

If `docs/adr/README.md` exists in the baseline (it does — it lists the
ADR index), append a one-line pointer near the top:

```diff
 # Architecture Decision Records

 Sequentially-numbered records of architectural decisions for this repo.
+
+**Before writing an ADR**, read the
+[3-criteria gate](000-template.md#when-to-write-an-adr) — it filters
+out decisions that don't actually need a record.

 ## Index
```

If the file does not exist, skip this part. The template extension is
self-contained.

---

## Tests to add in baseline

### `tests/adr-template.bats`

```bash
@test "ADR template includes 3-criteria gate section" {
  run grep -F '## When to write an ADR' docs/adr/000-template.md
  [ "$status" -eq 0 ]
}

@test "ADR template lists all 3 gate criteria" {
  for criterion in 'Hard to reverse' 'Surprising without context' \
                   'result of a real trade-off'; do
    run grep -F "$criterion" docs/adr/000-template.md
    [ "$status" -eq 0 ]
  done
}

@test "ADR template Nygard structure is preserved" {
  for section in '## Context' '## Decision' '## Consequences'; do
    run grep -F "$section" docs/adr/000-template.md
    [ "$status" -eq 0 ]
  done
}

@test "ADR template includes What qualifies / What does not qualify" {
  run grep -F '### What qualifies' docs/adr/000-template.md
  [ "$status" -eq 0 ]
  run grep -F '### What does not qualify' docs/adr/000-template.md
  [ "$status" -eq 0 ]
}
```

Diff: `+~30 / -0`.

---

## MR description draft

```
docs(adr): extend template with 3-criteria gate from DDD-trio (#315)

Adds a "When to write an ADR" section to docs/adr/000-template.md
codifying the 3-criteria gate (Hard to reverse / Surprising without
context / Result of a real trade-off). Mirrors verbatim the gate
shipped in session-orchestrator's skills/domain-model/ADR-FORMAT.md.

The existing Nygard structure (Context / Decision / Consequences) is
preserved byte-identical. Existing ADRs 001–007 are not mutated. The
new section is purely additive guidance that filters out trivial
decisions before authoring begins, reducing ADR sprawl.

Includes a "What qualifies / What does not qualify" sub-section
sourced from the plugin's ADR-FORMAT.md to anchor the gate with
concrete examples (architectural shape, integration patterns,
lock-in choices vs library swaps, lint rules, obvious defaults).

tests/adr-template.bats verifies presence of gate, all 3 criteria,
preserved Nygard sections, and qualifies/does-not-qualify framing.

Closes #315.
Refs session-orchestrator#309 (DDD-Trio parent epic).
Can bundle with #314 (architecture rule vendor) in a single MR.
```

---

## Acceptance criteria

Mapped to the #315 issue body's Definition of Done:

- [x] `docs/adr/000-template.md` extended with a new top-level
      `## When to write an ADR` section
- [x] All 3 gate criteria present verbatim with their canonical
      one-line definitions and the "if-not" tail
- [x] Existing Nygard structure (Context / Decision / Consequences)
      preserved byte-identical
- [x] Existing ADRs 001–007 not mutated (no file edits beyond the
      template + optional README cross-link)
- [x] Markdown renders cleanly (no broken sections, headings nest
      correctly under existing `#` template title)
- [x] `tests/adr-template.bats` covers gate presence, 3-criterion
      completeness, Nygard preservation, qualifies/does-not-qualify
- [x] No external dependencies (pure markdown + bats)
- [x] No changes to ADR numbering, indexing, or scaffolding tooling
- [x] CI green: bats tests pass, markdown-lint passes

---

## Notes for the cross-repo session

- Source-of-truth for the gate lives at
  `~/Projects/session-orchestrator/skills/domain-model/ADR-FORMAT.md`
  (lines 30–47, "When to offer an ADR" section, plus lines 39–47
  "What qualifies"). If the plugin file drifts before the cross-repo
  MR is opened, re-pull from the plugin and update this preview
  accordingly. Verbatim copy is mandatory — paraphrasing erodes the
  shared vocabulary across plugin + baseline + consumer repos.
- The plugin uses the heading **"When to offer an ADR"** (the skill
  is offering the ADR to the user); the baseline template uses
  **"When to write an ADR"** (the user is the author). Both wordings
  are intentional — do not unify them.
- This preview can bundle with #314 (architecture rule vendor) in a
  single MR labelled `epic:309-ddd-trio` since both targets live in
  `projects-baseline` and share the same review surface.
- Do **not** edit `~/Projects/projects-baseline` from a
  session-orchestrator session unless it is explicitly scoped as a
  cross-repo session.
- After the MR lands, follow-up: ensure the plugin's
  `skills/domain-model/SKILL.md` references the baseline template
  path so consumer repos get a deep-link from the skill prompt.
  Tracked as a deferred plugin-side task — out of scope for #315.
