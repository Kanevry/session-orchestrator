# ADR-0001: Orchestration is not solved by larger context windows

**Date:** 2026-05-06
**Status:** Accepted
**Issue:** #331

## Context

In May 2026, Subquadratic launched [SubQ](https://subq.ai) — an LLM with a 12M-token context window built on a sub-quadratic sparse-attention (SSA) architecture. Their flagship CLI product, *SubQ Code*, positions itself explicitly against multi-agent orchestration:

> "plan, execute, and review across a full repository in a single pass — without the coordination overhead of multi-agent systems."

The same narrative recurs every time a frontier model crosses an order-of-magnitude context threshold (1M Opus 4.7, 1M GPT-5.5, 12M SubQ). It conflates two distinct concerns: **how much a model can read at once** and **how engineering work is structured, audited, and reproduced over time**.

This ADR records the position so we stop re-litigating it on every model launch.

## Decision

The session-orchestrator's value proposition is **engineering discipline applied to agent execution**, not context aggregation. Larger context windows are useful inputs to our agents, but they do **not** replace any of the following primitives, which remain core to this plugin regardless of model context size:

| Primitive | What it does | Why context size doesn't replace it |
|---|---|---|
| **Wave Executor** (`skills/wave-executor`) | Decomposes work into ordered, parallel-where-possible waves with role-based agent dispatch | A 12M-token single pass cannot enforce sequencing of dependent work or run 4-6 specialised agents concurrently with disjoint file scopes |
| **Quality Gates** (`skills/quality-gates`) | Mandatory typecheck/test/lint at defined inter-wave checkpoints | A single-pass model cannot pause to validate intermediate state; failures surface only at the end, when rollback is expensive |
| **Hooks** (`hooks/*.mjs`) | Pre-bash destructive guard, scope enforcement, post-edit validate, banner-version-sync | Runtime safety policy is model-agnostic; a larger context cannot prevent a destructive `rm -rf` |
| **Audit Trail** (`sessions.jsonl`, `learnings.jsonl`, `vault-mirror`) | Every session leaves a typed, queryable record; learnings extracted via `/evolve` | Context lives only inside one model call; persistence + cross-session pattern extraction are filesystem concerns |
| **Parallel-Session Awareness** (`.claude/rules/parallel-sessions.md`) | PSA-001..004: detect, isolate, and avoid stomping on concurrent sessions sharing the workspace | A larger context inside *one* session does not coordinate across *multiple* sessions on the same repo |
| **Backlog Linkage** (`gitlab-ops`, `repo-audit`) | MR/issue traceability, label taxonomy, cross-repo issue propagation | VCS state lives outside any model call |
| **Reproducibility** | Same Session Config + same plan → same wave decomposition + same quality gates | Larger context buys *recall*, not *determinism* |

## Considered Alternatives

### Alternative A: Add SubQ as a model backend
**Rejected.** Adds a layer (auth, CI surface, fallback policy) for a Private Beta product with unvalidated benchmarks (VentureBeat May 2026: researchers demand independent proof of the 1000× efficiency claim; MRCR v2 underperforms Opus 4.6 at 65.9% vs. 78.3%). The current 1M-token capacity of Opus 4.7 and GPT-5.5 covers all realistic workloads against this repo (~300-500K tokens fully expanded). Revisit only if SubQ reaches GA + independent validation + the 1/5-cost claim is sustained.

### Alternative B: Introduce a `monolith` wave strategy
**Rejected.** Express Path (#320, shipped 2026-05-01) already provides the "skip waves for trivial tasks" path. A broader monolith mode would dilute the wave-based DNA without solving a real pain point — Express Path is the right granularity.

### Alternative C: Sharpen positioning via ADR (this document)
**Accepted.** Lasting value, zero runtime cost, model-agnostic. Reusable in README, Marketplace pitch (#213), public talks. Pairs with #332 (context-pressure signal in mode-selector) as the *one* targeted feature investment we extract from the SubQ launch.

## Consequences

### Positive
- README/Marketplace pitches can reference this ADR when challenged with "but bigger context"
- Future model launches with similar narratives have a documented response — no re-debate
- Mode-selector heuristic (#332) gets a clean conceptual anchor: context size is an *input signal*, not a replacement for orchestration

### Negative
- Risk of being seen as "not innovative" if SubQ-class models become dominant; mitigated by remaining model-agnostic at the agent layer
- Requires discipline to *not* add SubQ-specific glue when external pressure arises

### Neutral
- The orchestrator continues to consume whatever context window the host model provides; no tuning required when 1M → 2M → 12M happens at the model layer

## See Also

- `skills/wave-executor/SKILL.md` — wave decomposition rationale
- `skills/quality-gates/SKILL.md` — inter-wave gate definitions
- `.claude/rules/parallel-sessions.md` — PSA-001..004 (workspace coordination)
- Vault: `[[40-learnings/2026-05-06-subq-competitive-survey]]`
- Issue #331 (this ADR), #332 (context-pressure signal follow-up)
