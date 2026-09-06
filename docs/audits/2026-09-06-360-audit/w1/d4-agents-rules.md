# d4 — Agents + Rules-Audit — 2026-09-06 @ e4674109
## Summary
- Agents: 16 files, 15 dispatchable + AGENTS.md; plugin.json has NO agents key → loader registers the whole dir. AGENTS.md was dispatched 5× fleet-wide as `session-orchestrator:AGENTS` (frontmatter containment only via tools: Read). 0 true retirements (no agent with 0 dispatches AND 0 consumers). 2 non-agents (AGENTS.md, memory-proposal-collector.md) must leave agents/ → −1,504 B.
- Description diet: 12,926 B / 1,619 words total; 8,010 B / 957 words (62 %) in <example> blocks → move to body: −8,010 B always-on across 14 agents.
- Dispatches 90d (subagents.jsonl `agent_type`, 46 ledgers): code-implementer 6,836; test-writer 1,407; security-reviewer 1,086; session-reviewer 913; architect-reviewer 889; qa-strategist 873; ui-developer 849; docs-writer 734; db-specialist 372; analyst 147; dialectic-deriver 17; ux-evaluator 13 (model opus pinned — check); eval-judge 0, skill-applied-judge 0 (judge: off, keep-dormant); memory-proposal-collector 0.
- events.jsonl agent.stopped `agent` field: 3,275/3,762 EMPTY (87 %) → subagents.jsonl is the reliable source.
- Rules: 61 = 15 always-on + 46 path-scoped, of which 43 generated (not 45; 3 hand-written scoped: testing.md, cli-design.md, bash-harness-pitfalls.md). Generated: 1,644 lines / 112,443 B, 46.2 % pure overhead (frontmatter 22,680 + provenance 29,267). All 43 carry both `globs:` and `paths:` (identical; loader says globs wins → 2,134 B dead). 0 dead globs among generated; 11 zero-match warnings all in the 3 hand-written scoped rules. All 43 have expires-at 2026-10-01..2026-12-01.
- Cost per dispatched agent (real 4-file scope): injection block 219,923 B, of which 67,953 (31 %) from 26 generated rules — PLUS native delivery of all 43 (112,443 B): generated rules are paid twice (instruction-delivery.md §5).
- instruction-budget-guard is blind to generated rules: 470/480 directives over 15 files = always-on set only; ceiling can never fire on generated growth.
- Plan: 43 → 8 thematic files (identity-and-locks 8, guard-design 7, measurement-discipline 5, test-hygiene 3, process-contracts 3, toolchain-and-build 4, git-and-worktrees 1, review-and-adapter-contracts 2) + 10 hard DROPs (insight already verbatim in a hand-written always-on rule: VBC-003, PSA-007, TV-002c, PSA-006 item 4, PSA-006 anti-pattern, RCR-009, bash-harness-pitfalls §6, AGENTS.md:70, RCR-007, CLAUDE.md gotcha #1020) → ~46,500 B / ~700 lines = −65,900 B (−59 %), ≈ −106 kB ≈ −26k tokens per dispatched agent, ≈ −3.1 MB per deep session (6 agents × 5 waves).
- Reconcile idempotency: engine reads 2 markers (frontmatter learning-key scalar + body `- learning-key:`/`- learning-id:` bullets). Merged files need a `## Provenance` block with one bullet pair per absorbed learning. The 10 drops need `.orchestrator/runtime/reconcile-candidates.jsonl` entries with processed_at — that file does NOT exist in this repo (exists in 5 other fleet repos). reconcile.enabled:false = safe window. Verify: dry-run alreadyMaterialized == 43.
- #1164 targets `rules/` (vendored deliverable library), not `.claude/rules/`; `.claude/rules/README.md` does not exist; 0/61 carry the vendored provenance header (correct).
## Recommendations
R1 move agents/AGENTS.md → docs/agent-authoring.md, memory-proposal-collector.md → docs/memory-proposal-flow.md; pointers in CLAUDE.md + consumers — S — check-agents.mjs green, agents/*.md = 14.
R2 <example> blocks into body; negative triggers in descriptions (#1157) — M — description bytes < 6,500; check-agents green; smoke dispatch routing correct.
R3 remove redundant paths: (or globs:) block from 43 generated rules — S — print-applicable-rules count unchanged (40); −2,134 B.
R4 delete the 10 drops AFTER stamping reconcile-candidates.jsonl — S — dry-run alreadyMaterialized == 43; checker errors [].
R5 merge 33 into 8 target files with full provenance bullets — L — checker errors [] and Check-9 warnings ≤ 11; injection block < 160,000 B.
R6 instruction-budget-guard second dimension for generated/path-scoped rules — M.
R7 document merge rule in docs/rule-authoring.md + skills/reconcile/SKILL.md — S.
Order: R1/R3/R4 → R2 → R6 → R5 → R7.
## Open questions
1 Check 8 generated-rule-staleness is inert here: learnings.jsonl does not exist in this repo → where does the learnings store live now (vault? lost?) — decides if the 43 learning-keys resolve. 2 Check-9 doc drift: SKILL.md:64 claims `paths:` is unrecognised/Error, loader reads it since #795, 0 errors today. 3 ux-evaluator model: opus pin justified? 4 expires-at policy for merged files (earliest? none?). 5 brief said 45 generated / measured 43.
STATUS: done
