---
description: Say the last answer again in plain words — same facts, in the order the operator needs them. Optional topic argument.
argument-hint: "[topic]"
---

# eli5

Invokes the `eli5` skill (`skills/eli5/SKILL.md`). Restates my last substantial output — or the named topic — for someone who knows this project but did not watch the last ten minutes of it.

## Argument Validation

The optional argument is a topic, in prose. If absent, the target is my own last substantial output in this conversation; if there is none yet, say so rather than picking a topic for him.

Examples:
- `/eli5` — restate what I just said
- `/eli5 warum ist der Regel-Korpus voll?` — explain that, grounded in what this session measured

## Behavior

1. **Resolve the target** — last output, or `$ARGUMENTS`.
2. **Ground it** — prefer what this session already measured over recall, and name where it came from. Never measured here → say so.
3. **Restate** — consequence first (*must I act, and what if I don't?*), then the facts in the order he needs them.
4. **Check before sending** — every greppable token from the original still present; every noun the system does not contain gone.

## The limit that outranks the command

**Simplifying removes words, never facts.** A dropped path, number, error code, identifier, or instruction to act is data loss, not simplification — `skills/session-start/soul.md` § "Never traded for brevity" outranks brevity here as everywhere. And no invented pictures: say what happens, never what it is "like".

## Related

- `skills/eli5/SKILL.md` — the skill, in full
- `.claude/rules/ask-via-tool.md` § AUQ-006 — plain words, real things
- `skills/session-start/soul.md` § Register — the canonical register statement
