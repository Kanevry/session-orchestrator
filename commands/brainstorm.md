---
description: Run a lightweight Socratic design dialogue (3-5 AUQ rounds) and write a spec markdown file before any implementation work. Use BEFORE /plan feature when scope/UX is ambiguous.
argument-hint: "[topic-or-feature-slug]"
---

# Brainstorm

Invokes the `brainstorm` skill. Produces `docs/specs/YYYY-MM-DD-<slug>-design.md` after the user approves a design approach. HARD-GATE prevents any code or implementation work until the design is user-approved.

## Argument Validation

The optional argument is a topic or feature slug used in the spec filename (lowercase, hyphens, no special characters). If absent, the skill derives a slug from the user's Phase 1 answer.

Examples:
- `/brainstorm` — no slug; skill prompts for the problem in Phase 1
- `/brainstorm export-to-csv` — slug pre-set to `export-to-csv`
- `/brainstorm "user notification system"` — skill normalizes to `user-notification-system`

## Behavior

1. **Bootstrap gate** — reads `skills/_shared/bootstrap-gate.md`; halts if GATE_CLOSED until bootstrap completes.
2. **Phase 1** — single AUQ to characterize the problem and capture the source of ambiguity.
3. **Phase 2** — 3-5 Socratic AUQ rounds (user surface, data shape, integration points, risk, success criteria).
4. **Phase 3** — synthesize 2-3 approaches via AUQ with explicit trade-offs; user selects one.
5. **Phase 4** — write spec to `docs/specs/YYYY-MM-DD-<slug>-design.md`.
6. **Phase 5** — self-review pass (no placeholders, consistent with answers, explicit out-of-scope).
7. **Phase 6** — hand-off AUQ: proceed to `/plan feature`, `/write-executable-plan`, revise, or done.

## HARD-GATE

The skill enforces a HARD-GATE in Phase 0 that prevents any Edit, Write (code), or Bash (implementation) tool calls until the user approves the design via AskUserQuestion in Phase 6. The only Write call permitted before approval is writing the spec file itself in Phase 4. See `skills/brainstorm/SKILL.md` Phase 0 for the verbatim gate text.

## When to use vs. /plan feature

| Situation | Use |
|-----------|-----|
| Scope or UX is ambiguous | `/brainstorm` |
| Scope is clear, need a formal PRD | `/plan feature` |
| Full project kickoff | `/plan new` |
| Spec already written, ready to formalize | `/plan feature` |

## Related

- `skills/brainstorm/SKILL.md` — full skill specification (GH #36, umbrella #35)
- `skills/plan/SKILL.md` — primary hand-off target after design approval
- `skills/write-executable-plan/SKILL.md` — alternative hand-off for direct execution (issue #39)
- `.claude/rules/ask-via-tool.md` — AUQ tool usage convention (AUQ-001..005)
