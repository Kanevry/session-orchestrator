---
description: "Use when the operator wants to know which security mechanisms run in a repository, what the dependency advisories of its lockfiles mean, whether its install and publish settings are safe, or what steers the agent in this repo and on this host. Runs the read-only scripts/security.mjs in four modes (status, deps, posture, agent-setup) and routes \"review\" to the existing security-reviewer agent. Triggered by /security, \"security status\", \"dependency advisories\", \"npm audit is red\", \"check the agent setup\", \"Sicherheitsstatus\", \"Abhängigkeiten prüfen\". Not a vulnerability scanner or diff reviewer of its own, not for answering external advisory reports, and not for configuring the guards or hooks."
argument-hint: "[status|deps|posture|agent-setup|review] [--ref <commit>]"
---

# /security

Read `skills/security/SKILL.md` under the Session Orchestrator package root given in your system prompt and follow it exactly.

Arguments: $@

When the file references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
