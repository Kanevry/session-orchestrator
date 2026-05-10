# Cross-Spike Connection Map — 2026-05-10 Cluster

- **Date:** 2026-05-10
- **Spikes:** #364 (architecture) · #365 (devex) · #366 (autopilot stop-hook)
- **Author:** session main-2026-05-10-deep-1 W2 B4
- **Status:** informational (informs ADR/PRD reviews)

## Cluster-level open question

- **events.jsonl retention policy.** Hoisted from sibling docs as a single cluster-wide question, not owned by any one spike. **Recommendation: defer to a separate housekeeping issue** (out of scope for #364 / #365 / #366). Owner: TBD on creation of that issue. Rationale: retention touches all three spikes' downstream consumers but is not on any spike's critical path; resolving it here would inflate three documents with the same debate.

## Why this map exists

The three spikes look orthogonal at the issue-title level (architecture vs. devex vs. autopilot), but they all reach into the same five plugin surfaces: **Session Config schema, hook handlers (`hooks/on-stop.mjs` + `hooks.json` timeouts), autopilot kill-switch registry (`scripts/lib/autopilot/kill-switches.mjs`), the `.orchestrator/metrics/*.jsonl` ledgers, and the not-yet-existing `scripts/lib/tool-adapter.mjs` abstraction**. Without an explicit connection map, the three sibling ADRs/PRDs (ADR-364, ADR-365, PRD-366) risk recommending overlapping or contradictory schema changes — e.g. two spikes both bumping `sessions.jsonl` to v2 with incompatible field shapes, or two spikes registering kill-switches with colliding NAME constants. This map fixes the integration contract once so the three documents can be authored and reviewed independently without a final-stage merge surprise.

## Dependency graph (textual)

```
                 ┌─────────────────────┐
                 │ #364 architecture   │
                 │ remote substrate    │
                 └────┬────────┬───────┘
                      │        │
            ┌─────────┘        └─────────┐
            ▼                            ▼
   ┌────────────────┐         ┌──────────────────┐
   │ #341 Phase D   │         │ #305 cross-repo  │
   │ multi-story    │         │ vault watcher    │
   └────────────────┘         └──────────────────┘

                 ┌─────────────────────┐
                 │ #365 devex          │
                 │ MCP debug + tool-   │
                 │ adapter             │
                 └────┬────────────────┘
                      │
                      ▼
            (no upstream blockers)

                 ┌─────────────────────┐
                 │ #366 autopilot      │
                 │ stop-hook verify    │
                 └────┬────────────────┘
                      │
            ┌─────────┴────────────────┐
            ▼                          ▼
   ┌────────────────┐         ┌─────────────────┐
   │ #355 token-    │         │ #297 calibration │
   │ budget killsw. │         │ (data-gated)    │
   └────────────────┘         └─────────────────┘
```

The three spikes are **mutually non-blocking** — each can ship in isolation — but inter-spike awareness and downstream-issue awareness (#341, #305, #355, #297) materially reduces rework. The graph above shows what reads what; it deliberately does **not** show ordering (see §Recommended sequencing below).

## Inter-spike dependencies

### #366 ↔ #355 (TOKEN_BUDGET kill-switch)

PRD-366 will introduce a new kill-switch — most likely `VERIFICATION_BUDGET_EXCEEDED` — to bound the stop-hook verification loop's token spend. This MUST compose with #355's existing `TOKEN_BUDGET_EXCEEDED` rather than racing it:

- **Precedence:** `TOKEN_BUDGET_EXCEEDED` (cumulative, autopilot-wide) fires first if its threshold is hit during a verification iteration. `VERIFICATION_BUDGET_EXCEEDED` is a strictly tighter ceiling that only counts tokens spent inside a verification loop.
- **Config shape:** `verification.token-budget-extra: <int>` adds to the autopilot-wide budget for verification iterations only; once exhausted, `VERIFICATION_BUDGET_EXCEEDED` fires while `TOKEN_BUDGET_EXCEEDED` remains green.
- **Implementation site:** `scripts/lib/autopilot/kill-switches.mjs` already exports the 9 existing NAME constants (see A6 audit). #366 adds one more, exported the same way; #355 is unchanged.

**Forward-compat note:** the `stop_hook_active` flip (Anthropic's built-in 1-iteration safety gate, A5) is independent of both kill-switches and ALWAYS exits 0 — it is the floor, not the ceiling.

### #366 ↔ #365 (tool-adapter)

#366's `verification-command` field is initially shell-only (`pnpm test`, `npm run typecheck`). But once verification expands beyond shell — e.g. "verify by calling MCP tool X" or "screenshot via headless browser adapter" — it will need #365's tool-adapter abstraction. **Recommendation:** PRD-366 Phase 1 ships shell-only; Phase 2 (post-#365) adds `verification-command-adapter: <mcp-tool-id>` once `scripts/lib/tool-adapter.mjs` exists. This avoids #366 having to invent its own ad-hoc adapter and then refactor when #365 lands.

### #364 ↔ #365 (managed-agent invokes MCP)

If #364's thin-slice produces a managed-agent registry (per A6, "managed-agents dispatcher with fallback to local"), those agents will almost certainly invoke MCP tools — both for their own work and for verification. They need the same inspect/restart/raw-JSON debug surface from #365. **Implication:** ADR-364's thin-slice MUST cite ADR-365 as a peer document and adopt the same tool-adapter standard for any remote-agent → MCP-tool calls. Without this, two parallel debug paths emerge (local-MCP via #365, remote-MCP ad-hoc via #364) and the standardisation goal of #365 is silently violated.

### #364 ↔ #341 (multi-story Phase D)

#341 is the immediate downstream consumer of #364's patterns. The Symphony adoption table (A3) maps directly:

| Symphony pattern | #364 thin-slice deliverable | #341 consumer site |
|------------------|------------------------------|---------------------|
| Per-issue isolated workspace | Extend `worktree.mjs` with `validateWorkspacePath(computed, root)` | `autopilot-multi.mjs` (NEW in #341) |
| Single-authority `claimed` map | New in-memory map in coordinator | Wave dispatch in #341 |
| Stall-timeout reconciliation (2-strikes-then-kill) | Add `STALL_TIMEOUT` kill-switch | Multi-story wave loop |
| Worktree path + parent-run-id in proof artifact | Extend `sessions.jsonl` schema (see Shared Design Surfaces) | #341 telemetry |

#341 is currently `appetite:6w priority:low status:draft` — it is the right scope-budget for consuming #364's output without back-pressuring the spike.

### #364 ↔ #305 (vault strict watcher)

#305's `vault-integration warn → strict watcher` is cross-repo coordination work. If #364 produces an `agent-identity` block in Session Config + a remote-agent dispatcher, #305's strict-watcher can piggyback on the same agent-identity registry to attribute cross-repo vault writes to the right agent (instead of falling back to "whichever shell wrote the file"). Loose coupling: #305 ships independently if #364 slips, but if both ship, they should share one registry, not two.

## Shared design surfaces

| File / Module | #364 | #365 | #366 |
|---------------|------|------|------|
| Session Config schema (CLAUDE.md) | adds `agent-identity` block | adds `mcp-debug` block | adds `verification` block |
| `hooks/on-stop.mjs` | — | — | EXTEND (add verification logic; preserve `stop_hook_active` exit-0 guard) |
| `hooks/hooks.json` | — | EXTEND (deferred per-matcher timeout schema, additive) | EXTEND (Stop+SubagentStop timeout 5→65) |
| `.orchestrator/metrics/sessions.jsonl` schema | EXTEND (add `agent_identity`, `worktree_path`, `parent_run_id`) | — | — |
| `.orchestrator/metrics/events.jsonl` | — | EXTEND (`tool_invocations` event type) | — |
| `.orchestrator/metrics/failures.jsonl` | — | — | NEW (verification failure evidence) |
| `scripts/lib/autopilot/kill-switches.mjs` | adds `STALL_TIMEOUT` (Symphony pattern) | — | adds `VERIFICATION_BUDGET_EXCEEDED` |
| `scripts/lib/tool-adapter.mjs` | — | NEW | — (consumes if Phase 2) |
| `scripts/lib/worktree.mjs` | EXTEND (`validateWorkspacePath`) | — | — |
| New skill `mcp-debug` | — | NEW | — |
| `skills/mcp-builder/SKILL.md` | — | EXTEND (recommend `npx reloaderoo`) | — |
| `docs/session-config-reference.md` | EXTEND | EXTEND | EXTEND |

Verbs: **NEW** = file does not exist today, spike creates it; **EXTEND** = file exists, spike modifies; **—** = spike does not touch.

## Recommended sequencing

The three spikes are technically order-independent, but ordering them reduces total rework:

1. **#365 first** — small, isolated, no schema changes (only docs + a new `mcp-debug` skill + the `scripts/lib/tool-adapter.mjs` scaffold). Estimate ~3–5 days. **Unblocks** the tool-adapter standard that both #364 (managed-agent → MCP) and #366 Phase 2 (verification-by-tool) want to consume.
2. **#366 next, Phase 1 only** — shell-only verification command + `hooks/on-stop.mjs` extension + `failures.jsonl` ledger + one new `VERIFICATION_BUDGET_EXCEEDED` kill-switch. Estimate ~5–7 days. Adopts #365's tool-adapter standard if available, else stays shell-only and defers Phase 2.
3. **#364 last** — medium-granularity (per A6): `agent_identity` field + thin-slice managed-agent substrate. Estimate ~7–10 days. **Depends** on #366's `failures.jsonl` pattern as the forward-compat reference for proof-bundle artefacts (cost / lease / proof-of-work artefacts in A2/A3 map onto the same JSONL ledger discipline).

If only one spike ships this cycle, **#365 has the highest leverage-per-day** because it standardises a surface the other two will need eventually.

**Sequencing of `hooks.json` changes:** PRD-366's `hooks.json` timeout bump (uniform 5→65) lands AS-IS in Phase 1; ADR-365's deferred per-matcher timeout schema extension layers on top in a separate follow-up. The two edits are non-overlapping and additive — #366 changes existing values uniformly, #365 introduces a new per-matcher field shape later.

## Conflict-avoidance rules

These rules are mechanical contracts that the three sibling ADR/PRD authors MUST follow to prevent silent integration breakage:

1. **Distinguish Session Config keys from JSONL schema fields.** Spike-introduced **Session Config keys** MUST nest under spike-named blocks (e.g. `verification.*`); spike-introduced **schema fields** on existing JSONL records may use unprefixed names (e.g. `agent_identity`, `worktree_path`) where they describe the record itself, not a configurable knob. Cross-connections does NOT mandate that every spike introduce a Session Config block — **ADR-365 introduces none** (docs-only standards), **ADR-364 introduces none** (only a `sessions.jsonl` schema-field addition), **PRD-366 introduces `verification.*`** (the only Session Config block in this cluster). The current owner inventory is therefore: `verification.*` → #366. That is the entire list.
2. **Additive-only schema changes first; defer the version bump.** Additive-only fields land in the v1 schema; a v2 bump is deferred until a field becomes required. #364 adds `agent_identity` + `worktree_path` + `parent_run_id` to `sessions.jsonl` as optional fields readable by both old and new validators. #365 and #366 add fields strictly inside their own NEW ledgers (`events.jsonl` for #365, `failures.jsonl` for #366) and do NOT touch `sessions.jsonl`. If a spike thinks it needs a required field on an existing record, it routes the change — and the version bump — through a follow-up coordinated across all consumers.
3. **New kill-switches MUST land in `scripts/lib/autopilot/kill-switches.mjs` with NAME constants exported.** #364 adds `STALL_TIMEOUT`; #366 adds `VERIFICATION_BUDGET_EXCEEDED`. Both as exported NAME constants (matching the existing 9 — see A6). No inline string literals; no ad-hoc throw-with-message. This keeps the kill-switch registry the single source of truth.
4. **`failures.jsonl` is owned exclusively by #366.** #364 and #365 use `events.jsonl` for their non-failure observability (lease lifecycle, MCP tool-invocations). Failure-evidence persistence is the unique gap A5 identifies, and conflating "operational events" with "verification failures" in one stream kills downstream filtering.
5. **`hooks.json` matcher edits MUST be additive only.** #365 extends the per-matcher timeout schema (currently uniform 5s — see A6 cross-cutting gap #2) to support debug-heavy MCP tool-adapter invocations. It does NOT remove or rename existing matchers. #366 does NOT modify `hooks.json` at all — it modifies the body of `hooks/on-stop.mjs` only, preserving the existing matcher entry.
6. **`stop_hook_active` exit-0 guard is sacrosanct.** Whichever spike modifies `hooks/on-stop.mjs` (only #366 in this cluster) MUST keep the `stop_hook_active === true ⇒ exit 0` guard at line 1 of the handler body. This is Anthropic's contract (A5) and the only thing preventing infinite hook-driven continuation loops.

## Sources

- W1 research context: `docs/spike-probes/2026-05-10-w1-research-context.md` — sections A1 (VibeTunnel), A2 (Crabbox + CodexBar), A3 (Symphony), A4 (reloaderoo), A5 (Stop-Hook Patterns), A6 (Internal Codebase Audit).
- glab issues: #364 (architecture), #365 (devex), #366 (autopilot stop-hook). Tracking-only neighbours: #341 (Phase D multi-story), #305 (vault strict watcher), #355 (token-budget kill-switch), #297 (autopilot calibration, data-gated).
- Sibling spike documents authored in parallel in this session: see ADR-364, ADR-365, PRD-366 (paths under `docs/adr/` and `docs/prd/` for the 2026-05-10 cluster).
- CLAUDE.md "Current State" section — backlog snapshot 2026-05-09 (6 open issues, zero `priority:high|medium` code work remaining).
