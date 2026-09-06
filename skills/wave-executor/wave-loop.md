# Wave Execution Loop

> Sub-file of the wave-executor skill. Read by the coordinator during wave dispatch.
> For pre-execution setup, session type behavior, and error recovery, see `SKILL.md`.
> Project-instruction file resolution: `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see [skills/_shared/instruction-file-resolution.md](../_shared/instruction-file-resolution.md). Wherever this loop mentions a project's `CLAUDE.md`, the alias rule applies.
> Since #1157 this file is an INDEX. The loop body moved verbatim into `references/`; the three files below are the whole loop, in execution order. Nothing else was added or reworded.

## Read in this order

Per wave, in this order. The two steps marked **MANDATORY-BEFORE-DISPATCH** must not be skipped: skipping either dispatches the wave unguarded and the failure is SILENT — no error, no ledger entry, indistinguishable from a clean run.

| # | File | Governs | Read WHEN |
|---|---|---|---|
| 1 | [`references/wave-loop-scope-manifest.md`](references/wave-loop-scope-manifest.md) | The two-stage scope manifest — § 3.1 writes ONE `<state-dir>/filescopes/wave-<N>/<agent-id>.json` per agent (the array of path strings the `FILE-SCOPE` prompt injection, the Learnings-Index and `--assert-subset` read), § 3.2 writes the ONE per-wave aggregate of `{id, files}` records that `--assert-disjoint` / `--union` accept. Also `wave-scope.json`, the `blockedCommands` derivation, and the end-of-session teardown. | **MANDATORY-BEFORE-DISPATCH**, every wave — including the coordinator's own `coordinator.json`, which § 3.2 must fold into the aggregate or nothing reads it. Neither stage substitutes for the other. ONE exception: a wave-plan item marked `coordinator-direct: true` dispatches no agents and skips materialization entirely — see file 2. |
| 2 | [`references/wave-loop-dispatch.md`](references/wave-loop-dispatch.md) | Steps 0 → 1: wave-executor self-report, scope-baseline freeze (§ 0a), pre-dispatch resource gate (§ 0.5), dispatch + the small-batch rule, Started-Set Verification, every pre-dispatch injection (new-directory, path-cousin, fact-staleness, grounding, untracked-overlap, coordinator snapshot, frontmatter-guard, glob-scoped rules, learnings-index, file-scope), the `coordinator-direct: true` zero-agent wave exception, agent-type resolution incl. the `cursor:` and `ssh:` branches, platform-specific dispatch. | AT dispatch, after the Scope Manifest. Its § Started-Set Verification is the second **MANDATORY-BEFORE-DISPATCH-COMPLETES** step: run it immediately after the batch returns and before any review — an agent counts as started on its `meta.json` sidecar and completed on its task-notification, NEVER on the launch ack. |
| 3 | [`references/wave-loop-review.md`](references/wave-loop-review.md) | Steps 2 → 3b: restore coordinator CWD (§ 2.0), transcript tail and stagnation patterns, open-question collection (§ 3e), the inter-wave quality gate, the auto-fix protocol, the auto-commit checkpoint, persona-reviewer dispatch (§ 5a), adapt plan and dynamic scaling (§ 3), post-wave STATE.md (§ 3a), agent-status telemetry (§ 3a-bis), the persona-gate hook (§ 3b). | AFTER the wave's agents have completed and BEFORE § 4 below. Its § 3a. Post-Wave: Update STATE.md is mandatory before the next wave's Scope Manifest runs. |

Turn budget, `maxTurns`, and stagnation recovery are unmoved: `circuit-breaker.md`.

### 4. Progress Update

After each wave, provide a brief status:

```
## Wave [N] ([Role]) Complete ✓
- [Agent 1]: [done/partial/failed] — [1-line summary]
- [Agent 2]: [done/partial/failed] — [1-line summary]
- Duration: [Nm Ns] (wall-clock from dispatch to completion)
- Tests: [passing/failing] | TypeScript: [0 errors / N errors]
- Design: [aligned/drift/mismatch — or N/A if not Impl-Core/Impl-Polish or no pencil config]
- Scaling: [unchanged / reduced to N / increased to N] — [reason]
- Adaptations for Wave [N+1] ([NextRole]): [none / list changes]
```

**Shell variables used in this section:**
- `$PLUGIN_ROOT` — harness-supplied; `$CLAUDE_PLUGIN_ROOT`, `$CODEX_PLUGIN_ROOT`, or `$CURSOR_RULES_DIR` per platform — see `skills/_shared/config-reading.md`.
- `$WAVE` — the current wave number (the `<N>` in `<state-dir>/filescopes/wave-<N>/`).
- `$ROLE` — the wave's assigned role, resolved from the session plan's role-to-wave mapping (§ 0 above).
- `$STATE_DIR` — same value as the `<state-dir>` placeholder used elsewhere in this doc: `.claude` / `.codex` / `.cursor` per platform.
