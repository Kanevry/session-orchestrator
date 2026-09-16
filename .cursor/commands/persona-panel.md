---
description: "Use this skill when you need multi-persona parallel content review — domain experts, buyer personas, compliance reviewers, or custom catalog entries reviewing a target file or output. Dispatches N persona agents in parallel, consolidates verdicts via a configurable mode (voting-quorum, hard-gate-threshold, or coordinator-summary), and writes a timestamped sidecar to .orchestrator/persona-panel/. Invoked via /persona-panel <target-path>."
argument-hint: "<target> [--personas <names,...>] [--mode <voting|hard-gate|summary>] [--threshold <M-of-N|all|any>] [--grounding <off|re-derive>] [--dry-run]"
---

# /persona-panel

Use the Session Orchestrator skill definition at `skills/persona-panel/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
