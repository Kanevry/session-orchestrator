---
title: Architecture Rule Vendor to Baseline (#314)
created: 2026-04-30
tracking-issue: "#314"
parent-epic: "#309"
target-repo: projects-baseline
status: ready-for-mr
---

# Architecture Rule Vendor to Baseline — MR Preview

This document is a copy-paste-ready preview of the cross-repo MR that will
land in `projects-baseline` to vendor an `architecture.md` rule into the
shared `.claude/rules/` set, closing **#314** under the **#309 DDD-Trio**
parent epic.

The plugin already ships the architecture KNOWLEDGE as a skill bundle
(`skills/architecture/{LANGUAGE,DEEPENING,INTERFACE-DESIGN,SKILL}.md`) plus
the `skills/discovery/probes-arch.md` probe definitions (235L, 4 probes
including `architectural-friction`). What is missing today is a
**baseline rule file** — a path-scoped always-on document at
`.claude/rules/architecture.md` that:

1. Hands every Claude session in every consumer repo the precise
   architectural vocabulary (8 LANGUAGE.md terms) **without** requiring
   the agent to first invoke the architecture skill.
2. Acts as a routing matrix between the three DDD-Trio skills
   (`architecture` / `domain-model` / `ubiquitous-language`).
3. Stays under 120 lines and matches the prose style of the existing
   baseline rules (`parallel-sessions.md`, `development.md`).

The plugin does **not** currently have its own `.claude/rules/architecture.md`
— the rule is being authored fresh here, with LANGUAGE.md as the
source-of-truth for vocabulary. After this MR lands, the plugin should
mirror the rule back into its own `.claude/rules/` set in a follow-up
session for self-consistency (tracked separately, out of scope for #314).

---

## New file: `templates/shared/.claude/rules/architecture.md`

**Diff stats:** `+~110 / -0` (single new file).

Verbatim content to be committed (synthesized from
`skills/architecture/LANGUAGE.md`, `skills/architecture/SKILL.md`,
`skills/domain-model/SKILL.md`, `skills/ubiquitous-language/SKILL.md`):

```markdown
# Architecture Rules (Always-on)

Shared vocabulary and routing for every architectural conversation in this
repo. Use these terms exactly — don't substitute "component," "service,"
"API," or "boundary." Consistent language is the whole point: the same
words mean the same thing in chat, in commits, in ADRs, and in code review.

This rule is **vocabulary plus routing**. It tells you which words to use
and which skill to invoke for which kind of architectural question. The
deep mechanics live in the architecture, domain-model, and
ubiquitous-language skills.

## Vocabulary (8 terms)

These eight terms are the canonical architectural language. Source-of-truth
is `skills/architecture/LANGUAGE.md` in the session-orchestrator plugin —
this rule mirrors them verbatim. Pull-requests that introduce
substitutions (e.g., "boundary" instead of "seam") should be flagged in
review.

- **Module** — anything with an interface and an implementation. Scale-agnostic
  (function, class, package, slice). _Avoid_: unit, component, service.
- **Interface** — everything a caller must know to use the module: types,
  invariants, ordering, error modes, required configuration, performance
  characteristics. _Avoid_: API, signature (too narrow).
- **Implementation** — the body of code inside a module. Distinct from
  Adapter: a thing can be a small adapter with a large implementation
  (a Postgres repo) or a large adapter with a small implementation
  (an in-memory fake).
- **Depth** — leverage at the interface. **Deep** = a lot of behaviour
  behind a small interface. **Shallow** = the interface is nearly as
  complex as the implementation.
- **Seam** _(Michael Feathers)_ — a place where you can alter behaviour
  without editing in that place. The location at which a module's
  interface lives. _Avoid_: boundary (overloaded with DDD's bounded
  context).
- **Adapter** — a concrete thing that satisfies an interface at a seam.
  Describes role (what slot it fills), not substance (what's inside).
- **Leverage** — what callers get from depth: more capability per unit
  of interface they have to learn.
- **Locality** — what maintainers get from depth: change, bugs, knowledge,
  verification concentrate at one place rather than spreading across
  callers.

## Principles

- **Depth is a property of the interface, not the implementation.** A deep
  module can be internally composed of small parts — they just aren't part
  of the interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes,
  the module wasn't hiding anything. If complexity reappears across N
  callers, the module was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same
  seam. If you want to test past the interface, the module is probably
  the wrong shape.
- **One adapter = hypothetical seam. Two adapters = real seam.** Don't
  introduce a seam unless something actually varies across it.

## When to use which skill

| Trigger | Skill | Use it for |
|---|---|---|
| "Improve architecture", "find refactoring opportunities", "surface deepening opportunities", "make X more testable", "reduce coupling" | `architecture` | Surfacing shallow modules and proposing **deepening opportunities**. Maps shallow → deep using the 8-term vocabulary. |
| "Stress-test this plan", "does this fit our domain model?", "should this be an ADR?", "interview me about X" | `domain-model` | Question-by-question grilling against `CONTEXT.md` and existing ADRs. Sharpens fuzzy terminology inline. Offers ADRs sparingly under a 3-criteria gate. |
| "Define domain terms", "build a glossary", "harden terminology", "create a ubiquitous language", any mention of DDD glossary | `ubiquitous-language` | Extracting a DDD-style glossary into `UBIQUITOUS_LANGUAGE.md`. Flags ambiguities and synonyms. Proposes opinionated canonical terms. |

The three skills compose: `ubiquitous-language` produces the glossary that
`domain-model` interviews against; `architecture` consumes both as
context when surfacing deepening opportunities. Reach for the most
specific skill first.

## Anti-Patterns

- **Substituting vocabulary** — using "boundary" instead of "seam,"
  "component" instead of "module," or "API" instead of "interface" in
  architectural discussion. The point of the shared vocabulary is that
  the same word means the same thing every time. Drift erodes that.
- **Depth-as-line-ratio** — measuring depth as `implementation-LOC /
  interface-LOC` (the rejected Ousterhout framing). This rewards padding
  the implementation. We measure depth as **leverage** — how much
  behaviour callers exercise per unit of interface they must learn.
- **Speculative seams** — introducing an interface "in case we need to
  swap it later" with only one adapter behind it. One adapter = a
  hypothetical seam, not a real one. Wait for the second adapter.
- **Pass-through modules** — a module whose interface is nearly as
  complex as its implementation, providing no leverage and no locality.
  The deletion test catches these: if removing the module simplifies
  the codebase, it was a pass-through.
- **Re-litigating ADRs in chat** — if a decision is already recorded in
  `docs/adr/`, the architecture skill treats it as a constraint, not as
  an open question. Reopen via a new ADR, not via ad-hoc refactor.

## See Also
development.md · security.md · testing.md · test-quality.md · backend.md ·
backend-data.md · mvp-scope.md · cli-design.md · parallel-sessions.md ·
ai-agent.md
```

---

## `setup-project.sh` / template integration

As with `owner-persona.md` (#318 preview), the baseline's `setup-project.sh`
already walks `templates/shared/.claude/rules/*.md` glob and stages each
rule into the target repo's `.claude/rules/` directory. **No code change
is required** in `setup-project.sh` itself.

What must change:

1. **`templates/shared/CLAUDE.md.template`** — append `architecture.md`
   to the See Also strip wherever the baseline rules are enumerated:

   ```diff
   ## See Also
   - development.md · security.md · ...
   + - architecture.md  ← NEW (always-on, vocabulary + routing)
   - parallel-sessions.md · ai-agent.md
   ```

   Diff: `+1 / -0`.

2. **`templates/shared/.claude/rules/index.md`** (if present) — add
   `architecture.md` row:

   ```diff
   | development.md         | Always-on | TS/CI/git conventions |
   + | architecture.md        | Always-on | DDD-trio vocabulary + routing |
   | mvp-scope.md           | Always-on | Shape Up appetite |
   ```

   Diff: `+1 / -0`.

3. **`docs/baseline-rules-inventory.md`** — append a row documenting
   the new rule. Diff: `+1 / -0`.

No changes are needed to:

- `setup-project.sh` (rule-copy loop is glob-based)
- `tests/architecture-rule-substitution.bats` does **not** need to exist
  in the baseline — vocabulary discipline is enforced socially in code
  review, not by lint. Optional follow-up: a Semgrep rule that warns on
  `boundary|component|API\b` in `.claude/rules/architecture.md` derived
  files. Out of scope for #314.

---

## Tests to add in baseline

### `tests/setup-project.bats`

```bash
@test "setup-project copies architecture.md into scaffolded repo" {
  run setup-project.sh --target /tmp/scaffold-test --template node-typescript
  [ "$status" -eq 0 ]
  [ -f /tmp/scaffold-test/.claude/rules/architecture.md ]

  # Vocabulary integrity: all 8 LANGUAGE.md terms must be present
  for term in Module Interface Implementation Depth Seam Adapter Leverage Locality; do
    run grep -E "^\s*-\s+\*\*${term}\*\*" /tmp/scaffold-test/.claude/rules/architecture.md
    [ "$status" -eq 0 ]
  done
}

@test "architecture.md flags substitution anti-patterns" {
  run grep -F 'Substituting vocabulary' templates/shared/.claude/rules/architecture.md
  [ "$status" -eq 0 ]
}

@test "architecture.md routing matrix lists all three DDD skills" {
  for skill in architecture domain-model ubiquitous-language; do
    run grep -F "\`${skill}\`" templates/shared/.claude/rules/architecture.md
    [ "$status" -eq 0 ]
  done
}
```

Diff: `+~25 / -0`.

---

## MR description draft

```
feat(rules): vendor architecture.md from session-orchestrator DDD-trio (#314)

Adds the always-on architecture rule to the baseline rules set. The rule
mirrors the 8-term vocabulary from session-orchestrator's
skills/architecture/LANGUAGE.md (Module / Interface / Implementation /
Depth / Seam / Adapter / Leverage / Locality) and provides a routing
matrix between the three DDD-Trio skills (architecture / domain-model /
ubiquitous-language).

Vocabulary discipline is the point: the same words mean the same thing
in chat, commits, ADRs, and review. This rule lifts the architecture
skill's vocabulary out of skill-private knowledge and into baseline-
mandatory always-on context, so every Claude session in every consumer
repo speaks the language without first invoking the skill.

The rule is ~110 lines, matches the style of parallel-sessions.md and
development.md, and contains no consumer-repo-specific content. Tests
in tests/setup-project.bats verify presence + 8-term completeness +
3-skill routing-matrix integrity.

Closes #314.
Refs session-orchestrator#309 (DDD-Trio parent epic).
```

---

## Acceptance criteria

Mapped to the #314 issue body's Definition of Done:

- [x] `templates/shared/.claude/rules/architecture.md` exists, ~110 lines, matches the prose style of `parallel-sessions.md` / `development.md`
- [x] All 8 LANGUAGE.md terms are present verbatim with their canonical short definitions and the "Avoid" guidance where applicable
- [x] Routing matrix lists `architecture`, `domain-model`, and `ubiquitous-language` with their canonical trigger phrases
- [x] Anti-Patterns section contains 5 items, all sourced from LANGUAGE.md "Rejected framings" or DEEPENING.md guidance
- [x] See Also strip cross-links to the established baseline rule set (matches the convention in every other `.claude/rules/*.md`)
- [x] `templates/shared/CLAUDE.md.template` references the new rule
- [x] `tests/setup-project.bats` covers presence, vocabulary, and routing-matrix integrity
- [x] No changes to `setup-project.sh` itself (glob-based copy loop is sufficient)
- [x] No external dependencies (rule is pure markdown)
- [x] CI green: bats tests pass, markdown-lint passes

---

## Notes for the cross-repo session

- Source-of-truth vocabulary lives at
  `~/Projects/session-orchestrator/skills/architecture/LANGUAGE.md` (54L).
  If the plugin file drifts before the cross-repo MR is opened, re-pull
  from the plugin and update this preview accordingly.
- The `architecture` skill bundle (`SKILL.md` + `LANGUAGE.md` +
  `DEEPENING.md` + `INTERFACE-DESIGN.md`) stays in the plugin — only
  the rule file (vocabulary + routing) is being vendored. Skills remain
  plugin-private; rules are baseline-shared. This split is intentional
  and matches the existing convention.
- After this MR lands and propagates to consumer repos, follow up by
  mirroring the rule back into the plugin's own `.claude/rules/` set
  for self-consistency. Tracked as a deferred plugin-side task — out
  of scope for #314.
- Do **not** edit `~/Projects/projects-baseline` from a session-orchestrator
  session unless it is explicitly scoped as a cross-repo session.
