---
description: Stress-test a plan, design, or PRD before any build — relentless one-question-at-a-time interrogation that hunts contradictions against the code and challenges assumptions. Composable; no HARD-GATE.
argument-hint: "[file-path-or-topic]"
---

# Grill

Invokes the `grill` skill (`skills/grill/SKILL.md`). Relentlessly interrogates a plan/design/PRD one decision at a time, grounds every question in the codebase, and surfaces contradictions before implementation. Optionally writes `docs/specs/YYYY-MM-DD-<slug>-grill.md`.

## Argument Validation

The optional argument is either a file path to grill (a PRD, spec, `STATE.md`) or a topic/slug. If absent, the skill grills the plan already present in the current conversation; if there is none, it asks the user to state it first.

Examples:
- `/grill` — grills the plan in the current conversation context
- `/grill docs/prd/2026-06-09-export.md` — grills a specific PRD file
- `/grill "partial order cancellation"` — grills the named idea, slug pre-set

## Behavior

1. **Phase 0 — Target Acquisition** — resolve what's being grilled, ground it against the codebase (`CONTEXT.md`, steering docs, ADRs, relevant source), state the target back.
2. **Phase 1 — Map the Decision Tree** — lay out the dependent decisions root-to-leaf; skip what the code already settles.
3. **Phase 2 — Grill Loop** — one question per turn via `AskUserQuestion`, applying the Six Tactics (glossary conflict, sharpen fuzzy language, code contradiction, edge-case scenario, assumption audit, pre-mortem); read the repo before asking.
4. **Phase 3 — Resolved-Decisions Recap** — decisions, contradictions surfaced, open questions, assumptions audited.
5. **Phase 4 — Hand-off** — AUQ: write grill summary + `/plan feature`, summary only, hand off without a file, or done.

## No HARD-GATE

Unlike `/brainstorm`, grill imposes no implementation gate — it is a composable thinking tool. It writes no code and never commits; the only write it performs is the optional summary file in Phase 4. What happens after the grill is the user's call.

## When to use vs. /brainstorm and /plan feature

| Situation | Use |
|-----------|-----|
| A settled-feeling plan needs stress-testing before build | `/grill` |
| The design is still ambiguous and needs narrowing | `/brainstorm` |
| Scope is clear, need a formal PRD + issues | `/plan feature` |
| Adversarial pass before formalizing | `/grill` → `/plan feature` |

## Related

- `skills/grill/SKILL.md` — full skill specification
- `skills/brainstorm/SKILL.md` — cooperative sibling for ambiguous designs
- `skills/plan/SKILL.md` — primary hand-off target
- `.claude/rules/ask-via-tool.md` — AUQ usage convention (AUQ-001..005)
