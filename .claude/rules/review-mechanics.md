---
paths: ["agents/*reviewer*.md", "agents/schemas/*reviewer*.json", "skills/wave-executor/**", "skills/session-end/**", "skills/persona-panel/**", "scripts/lib/config/wave-reviewers.mjs", "scripts/lib/quality-gate*.mjs", "scripts/lib/quality-gate/**", "tests/rules/receiving-review.test.mjs", "tests/lib/config/wave-reviewers.test.mjs"]
tier: always
review-date: 2026-10-23
---

# Review Mechanics
RCR-001–009 remain universal in receiving-review.md. Reviewer reports findings, SOUND surfaces, MEASURED-AWAY suspicions and measurement-backed refusals per agents/session-reviewer.md § Depth and Escalation Authority. Route follow-up through skills/session-end/SKILL.md disposition table. Enumerate callsites for sweep proofs, not files or payload-only grep. Record class and rationale before edits; local proof/classification closes before fix commits can stack or push.
## See Also
receiving-review.md · parallel-sessions.md · verification-before-completion.md
