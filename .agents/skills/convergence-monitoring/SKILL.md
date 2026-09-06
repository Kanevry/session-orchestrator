---
name: convergence-monitoring
description: "Monitor iterative improvement loops for convergence. Three signals — shrinking diff, pass-rate plateau, velocity — drive a Stop/Continue/Investigate decision at each inter-wave checkpoint. Distinct from /evolve (retrospective) and session-reviewer (wave output review): convergence-monitoring answers \"are we making progress?\" not \"was the last wave correct?\". Primary consumer: /autoresearch loops and wave-executor inter-wave checkpoints."
metadata:
  user-invocable: "true"
  tags: autoresearch, convergence, loop-control, wave-executor
  model: haiku
  model-preference: sonnet
  model-preference-codex: gpt-5.4-mini
  model-preference-cursor: claude-sonnet-4-6
  attribution: |
    Inspired by cavekit's documented convergence-monitoring concept (MIT, Julius Brussee). Implemented from spec since upstream skill not yet published as of 2026-04-30.
---

# convergence-monitoring

> **Portable mirror — generated, do not edit.** The canonical skill body lives at
> [`skills/convergence-monitoring/SKILL.md`](../../../skills/convergence-monitoring/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.
