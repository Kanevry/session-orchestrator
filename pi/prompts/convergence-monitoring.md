---
description: "Monitor iterative improvement loops for convergence. Three signals — shrinking diff, pass-rate plateau, velocity — drive a Stop/Continue/Investigate decision at each inter-wave checkpoint. Distinct from /evolve (retrospective) and session-reviewer (wave output review): convergence-monitoring answers \"are we making progress?\" not \"was the last wave correct?\". Primary consumer: /autoresearch loops and wave-executor inter-wave checkpoints."
---

# /convergence-monitoring

Use the Session Orchestrator skill definition at `skills/convergence-monitoring/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
