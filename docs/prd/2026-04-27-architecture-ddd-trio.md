# Feature: Architecture-DDD-Trio (mattpocock/skills adoption)

**Date:** 2026-04-27
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 2w (value-first; user explicitly de-prioritised time)
**Parent Project:** session-orchestrator plugin (v3.2.x → v3.3.0 candidate)

## 1. Problem & Motivation

### What
Adopt three skills from `mattpocock/skills` (29k⭐, MIT, SHA `90ea8ee`) into the session-orchestrator plugin as first-class skills, plus a `/discovery code` integration probe and a vendored convention layer in `projects-baseline`:

1. **`architecture`** — interactive skill that surfaces *deepening opportunities* (Ousterhout deep-module refactors) in the live codebase, informed by the project's `CONTEXT.md` and `docs/adr/`. Anchored in a precise vocabulary (Module / Interface / Implementation / Depth / Seam / Adapter / Leverage / Locality) so suggestions stay durable across refactors.
2. **`domain-model`** — grilling session that challenges a plan against the existing domain model, sharpens fuzzy terms inline, updates `CONTEXT.md` lazily, and offers ADRs sparingly under a 3-criteria gate (hard-to-reverse + surprising-without-context + real-trade-off).
3. **`ubiquitous-language`** — extracts a DDD glossary from the current conversation into `UBIQUITOUS_LANGUAGE.md`, calling out ambiguities and synonyms with opinionated canonical-term picks.

Plus:
4. A new `architectural-friction` probe in `skills/discovery/probes-arch.md` (Markdown-pattern probe, not `.mjs`) that links high-density Grep-pattern findings to invocations of the `architecture` skill.
5. An `.claude/rules/architecture.md` rule vendored to `projects-baseline` codifying the LANGUAGE.md vocabulary as a contributor convention.
6. An extension to the existing `projects-baseline/docs/adr/000-template.md` with mattpocock's ADR-FORMAT.md guidance (3-criteria gate, when-to-write).

### Why
Two evidence-grounded drivers:

- **`/discovery code` gap:** The current probe set (`circular-dependencies`, `complexity-hotspots`, `dependency-security`) finds *quantitative* code-quality problems (>500-line files, >50-line functions, cycles) but **never surfaces shallow modules, leaky seams, or pass-through abstractions** — i.e. the architectural friction that compounds over months. Confirmed via Explore-agent scan of `skills/discovery/probes-*.md`.
- **No vocabulary contract for AI-navigable codebases:** `projects-baseline` ships 20 rule files (security, testing, MVP scope, …) but **none cover architecture, deep modules, or DDD ubiquitous language**. Each consumer repo invents its own terms (or none), so AI agents get stuck bouncing between shallow modules without a name for what they're seeing. Adopting LANGUAGE.md gives every consumer the same primitives.

The mattpocock skills are battle-tested (29k⭐, MIT-licensed, public release pattern documented in their README), grounded in *A Philosophy of Software Design* (Ousterhout) and DDD (Evans), and require minimal adaptation — they already follow the SKILL.md + sub-files progressive-disclosure pattern we use.

### Who
- **Primary users:** the plugin coordinator (us, in any session-orchestrator-equipped repo) and consumer-repo developers running `/discovery code` or invoking the new skills via the `Skill` tool.
- **Secondary users:** AI subagents (Explore, code-implementer) — the LANGUAGE.md vocabulary lets them describe what they find using stable terms instead of drifting between "component / service / module / boundary".
- **Out of audience:** non-technical stakeholders. These are engineering-discipline tools.

## 2. Solution & Scope

### In-Scope

- [ ] **S1.** Adapt `improve-codebase-architecture/SKILL.md` (76L) → `skills/architecture/SKILL.md` with attribution frontmatter (`derived-from: mattpocock/skills@90ea8ee — MIT`), description re-tuned for our trigger conventions, references corrected to neighbour skills (CONTEXT.md/ADR via `domain-model` skill).
- [ ] **S2.** Vendor `improve-codebase-architecture/LANGUAGE.md` (53L), `DEEPENING.md` (37L), `INTERFACE-DESIGN.md` (44L) verbatim into `skills/architecture/` as bundled assets. No edits — the vocabulary IS the contract.
- [ ] **S3.** Adapt `domain-model/SKILL.md` (81L) → `skills/domain-model/SKILL.md`. Same attribution + description re-tune. References point to bundled CONTEXT-FORMAT.md / ADR-FORMAT.md.
- [ ] **S4.** Vendor `domain-model/CONTEXT-FORMAT.md` (77L) and `ADR-FORMAT.md` (47L) into `skills/domain-model/` verbatim.
- [ ] **S5.** Adapt `ubiquitous-language/SKILL.md` (93L) → `skills/ubiquitous-language/SKILL.md`. `disable-model-invocation: true` preserved (matches mattpocock — explicit-invocation only).
- [ ] **S6.** Add `architectural-friction` Markdown probe to `skills/discovery/probes-arch.md`. Probe registers shallow-module, pass-through-adapter, and one-adapter-seam Grep heuristics; a finding's `recommended_fix` field references invoking the `architecture` skill on the cluster.
- [ ] **S7.** Vendor `architecture` rule to `projects-baseline/.claude/rules/architecture.md`. Sources the LANGUAGE.md vocabulary verbatim plus a "When to use which skill" matrix (`architecture` for refactoring; `domain-model` for plan-stress-test; `ubiquitous-language` for glossary extraction).
- [ ] **S8.** Extend `projects-baseline/docs/adr/000-template.md` with the 3-criteria gate from mattpocock's ADR-FORMAT.md (hard-to-reverse + surprising-without-context + real-trade-off). Existing 7 ADRs unchanged.
- [ ] **S9.** Update `CLAUDE.md` plugin description (`Structure` section: 22 → 25 skills) + add an "Architecture-DDD-Trio" subsection to "v2.0 Features" describing the new triplet + probe.
- [ ] **S10.** Vitest test pack: 8 tests covering (a) frontmatter validity for all 3 new skills, (b) attribution preserved in each skill's frontmatter, (c) sub-file references resolve to bundled assets, (d) `architectural-friction` probe surfaces in `probes-arch.md` and follows the FINDING-block contract, (e) baseline `architecture.md` rule is referenced in the bootstrap vendor manifest, (f) ADR template extension renders cleanly.

### Out-of-Scope

- **`.mjs` executable arch-friction probe** — Markdown probe is sufficient for v1; an import-graph-walking probe is a follow-up issue if the markdown variant proves too coarse.
- **Auto-creating `CONTEXT.md` / `UBIQUITOUS_LANGUAGE.md` in consumer repos** — the skills create these *lazily* (only when the user resolves a term). No bootstrap-time scaffolding.
- **vault-mirror integration for CONTEXT.md changes** — speculative; defer until skills are actually used in real consumer sessions.
- **Session-end drift detection between CONTEXT.md and code** — same reason; needs real corpus first.
- **Adapting `to-prd` / `to-issues` / `grill-me` / `tdd` / `git-guardrails` / `obsidian-vault`** — analysed in the source-repo discovery; we are richer in those areas already (`/plan feature`, `superpowers:tdd`, `pre-bash-destructive-guard.mjs`, `vault-mirror`/`vault-sync`). No adoption.
- **Renaming or restructuring our existing `architecture-analysis` baseline skill** — orthogonal; it can coexist (different framing: that one generates ADRs, ours surfaces deepening opportunities).
- **Conflict mediation with #237 (vault-docs-architecture.md)** — explicitly resolved via narrative-vs-tool framing during planning Q&A: #237 documents *vault-docs* architecture as narrative; our `architecture` skill is a *live tool* that finds deepening opportunities anywhere. PRD section 5 captures the delineation.

## 3. Acceptance Criteria

### S1–S5: Skill adaptation
```gherkin
Given a fresh checkout of session-orchestrator at this PRD's branch
When I list `skills/` and read each new SKILL.md frontmatter
Then `architecture`, `domain-model`, `ubiquitous-language` exist as sibling skill directories
And each SKILL.md contains a YAML field `derived-from: mattpocock/skills@90ea8ee` with `license: MIT`
And each SKILL.md description follows our convention (single-line, "Use when …" trigger sentence, max 1024 chars)
And `ubiquitous-language` and `domain-model` preserve `disable-model-invocation: true` as in upstream
```

```gherkin
Given the architecture skill is invoked via the Skill tool with no prior context
When the skill follows its 3-step process (Explore → Present candidates → Grilling loop)
Then it reads CONTEXT.md / docs/adr/ if present and proceeds silently if absent
And presents a numbered list of deepening opportunities using LANGUAGE.md vocabulary verbatim
And asks the user to pick one before proposing any interface
```

### S2 / S4: Sub-file vendoring
```gherkin
Given I read skills/architecture/LANGUAGE.md
Then the file is byte-identical to /tmp/mattpocock-skills/improve-codebase-architecture/LANGUAGE.md@90ea8ee
And the same equality holds for DEEPENING.md, INTERFACE-DESIGN.md, CONTEXT-FORMAT.md, ADR-FORMAT.md
```

### S6: Discovery probe
```gherkin
Given a consumer repo running `/discovery code`
When the arch category dispatches its probe agent
Then `probes-arch.md` includes the `architectural-friction` probe entry
And the probe surfaces FINDING blocks for shallow-module / pass-through / one-adapter-seam patterns
And each finding's `recommended_fix` says "invoke the `architecture` skill on this cluster"
And the FINDING block schema matches existing arch probes (probe / category / severity / file_path / title / description / recommended_fix)
```

### S7: Baseline rule vendor
```gherkin
Given projects-baseline is checked out at the PRD's adoption branch
When I list .claude/rules/
Then `architecture.md` exists as a new rule file
And its content sources LANGUAGE.md vocabulary verbatim
And it includes a "When to use which skill" matrix (architecture / domain-model / ubiquitous-language)
And the bootstrap vendor manifest references it so consumer-repo bootstrap copies it forward
```

### S8: ADR template extension
```gherkin
Given projects-baseline/docs/adr/000-template.md
When I open the extended template
Then the existing Nygard structure (Context / Decision / Consequences) is preserved unchanged
And a new "When to write an ADR" section codifies the 3-criteria gate (hard-to-reverse + surprising-without-context + real-trade-off)
And the existing 7 ADRs (001–007) are not mutated
```

### S10: Test coverage (edge cases + green-bar)
```gherkin
Given I run `npm test` after the adoption is merged
Then the new tests under tests/skills/architecture-ddd-trio.test.mjs pass
And total tests increases from 1871 to 1879+ (no test regression)
And coverage thresholds remain above 70 / 65 / 70 / 60
```

```gherkin
Given a SKILL.md with corrupt frontmatter (missing `name` or `description`)
When the validity test runs
Then it fails with a clear message identifying the offending file and field
```

## 4. Technical Notes

### Affected Files

**Plugin (session-orchestrator):**
- `skills/architecture/SKILL.md` — NEW (~80 lines after adaptation)
- `skills/architecture/LANGUAGE.md`, `DEEPENING.md`, `INTERFACE-DESIGN.md` — NEW (vendored verbatim)
- `skills/domain-model/SKILL.md` — NEW (~85 lines)
- `skills/domain-model/CONTEXT-FORMAT.md`, `ADR-FORMAT.md` — NEW (vendored verbatim)
- `skills/ubiquitous-language/SKILL.md` — NEW (~95 lines)
- `skills/discovery/probes-arch.md` — MODIFIED (+1 probe entry, ~30 lines)
- `CLAUDE.md` — MODIFIED (Structure section skill count + new "Architecture-DDD-Trio" subsection in v2.0 Features)
- `tests/skills/architecture-ddd-trio.test.mjs` — NEW (~120 lines, 8 tests)
- `LICENSE` or `NOTICE` — MODIFIED if needed to record the upstream MIT attribution (verify current state during impl)

**Baseline (projects-baseline):**
- `.claude/rules/architecture.md` — NEW (~80 lines)
- `docs/adr/000-template.md` — MODIFIED (extension only; no removal)
- vendor manifest / bootstrap config — MODIFIED so the new rule ships to consumers

### Architecture
Three pure-Markdown SKILL.md files, each in its own subdir with bundled assets, following our existing 22-skill SKILL.md convention. No `.mjs` runtime code in v1. Discovery integration is purely declarative (a Markdown probe entry); the skill invocation it points to is the user-facing interactive loop, not a background hook. Baseline rule is a static Markdown file copied into consumer repos by the existing bootstrap vendor mechanism — same path as `parallel-sessions.md`, `mvp-scope.md`, etc.

Attribution is YAML-frontmatter-driven, not buried in prose: `derived-from: mattpocock/skills@<sha>` + `license: MIT` + `upstream-url: https://github.com/mattpocock/skills/tree/main/<dir>` so any future audit (or skill-search) can trace lineage.

### Data Model Changes
None.

### API Changes
None at the runtime level. New "API surface" is the three Skill-tool invocations (`architecture`, `domain-model`, `ubiquitous-language`) and one new FINDING-block emission from the arch probe.

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| **#237 scope-overlap perceived as conflict** | Mid — could trigger duplicate-work concerns from #237 owner | PRD calls out narrative-vs-tool delineation explicitly. Issue created from this PRD will link #237 with a "complementary, not duplicate" note. |
| **LANGUAGE.md vocabulary clashes with our existing internal terms** ("module" used loosely in CLAUDE.md, "boundary" used in security rules) | Mid — could confuse contributors | Treat LANGUAGE.md as canonical going forward. Update `.claude/rules/architecture.md` to be the disambiguation source. Existing rule files left alone (low-friction path). |
| **mattpocock upstream evolves; our copies drift** | Low | Pin via `derived-from: …@<sha>` in frontmatter. Add a calendar reminder in CHANGELOG.md (not auto-sync — adoption is opinionated). |
| **Skills are too generic to fit our session-orchestrator coordinator pattern** | Low-Mid | The Explore-agent scan confirms the structure (3-step process, AskUserQuestion-compatible) maps cleanly onto our patterns. Adapt-during-impl rather than pre-design. |
| **Consumer-repo bootstrap-vendor mechanism doesn't pick up the new baseline rule automatically** | Low | Verify during S7 implementation. If vendor manifest needs a new entry, that's an in-scope edit. |
| **License compliance (MIT requires attribution)** | Low | Frontmatter `derived-from` + `license: MIT` + ensure an upstream LICENSE notice lives somewhere accessible. Confirm with first-impl test. |
| **Markdown probe signal-to-noise is bad in early use** | Mid | v1 ships markdown-only with conservative Grep heuristics. If false-positive rate is high, follow-up issue switches to .mjs probe with import-graph traversal. |

### Dependencies

- **#237** — *complementary, not blocking.* Narrative vs tool delineation captured in PRD §1, §2 Out-of-Scope, §5 Risks.
- **#287, #288** — orthogonal complexity-hotspot refactor and skill-doc splits; can run in parallel.
- **projects-baseline repo (separate)** — needs its own MR for S7+S8. Plugin work proceeds independently; baseline MR can land asynchronously.
- **Upstream `mattpocock/skills@90ea8ee`** — pinned SHA; cloned to `/tmp/mattpocock-skills/` during planning. Re-clone before implementation if SHA needs refresh (current SHA captured 2026-04-27 14:48 UTC).
- **No blocking GitLab issues found.** Glab scan returned zero `priority:critical` blockers.
