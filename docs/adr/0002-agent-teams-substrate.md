# ADR 0002: Agent Teams as Wave Substrate

> Status: ACCEPTED · session main-2026-05-19-deep-2 · issue #437
> Source research: "Agent Teams Evaluation" (#437; archived in the private Meta-Vault) (W2 + W3 Empirical)
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

## Context

Anthropic shipped native multi-agent **Agent Teams** as an experimental, opt-in feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, Claude Code ≥ v2.1.32; this host runs **2.1.144**, env-var **RECOGNIZED** in the binary — per research note § Empirical/1). A fixed team lead spawns named teammates, each a full independent Claude Code session with its own context window, coordinating through a shared on-disk task list and a peer-to-peer mailbox.

This directly overlaps the plugin's central abstraction — "waves" of parallel subagents dispatched by a coordinator. The pivot pressure is concrete: `ruvnet/claude-flow` was renamed **Ruflo** under Anthropic trademark pressure (Jan 2026) and underwent a ~250k-line ground-up Rust/WASM rebuild; its maintainers concluded, with native Agent Teams shipped, *"stop competing on orchestration, start owning intelligence, trust, and memory"* (per research note § Context). Frameworks that did not pivot are now dead weight. The question this ADR resolves: is `wave-executor` differentiated value, or orchestration plumbing the platform now provides for free?

Two load-bearing facts reframe the issue #437 premise (per research note § Empirical):

- **The isolation premise is CONFIRMED FALSE.** Issue #437 framed Agent Teams as offering "automatic per-teammate worktree isolation." The official docs state verbatim: *"Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files."* Git worktrees are described as a *separate, manual* feature for parallel sessions *without* team coordination. There is no automatic isolation — file-scope deconfliction remains the operator's responsibility.
- **The gap is 11-vs-1.** Agent Teams supplies exactly one capability we lack (peer-to-peer teammate messaging via the `SendMessage` mailbox) and is missing eleven we have — every one of the 10 kill-switches (`scripts/lib/autopilot/kill-switches.mjs:18-32`), the spiral/stagnation taxonomy (`skills/wave-executor/circuit-breaker.md:119-162`), the inter-wave quality-gate ladder (`skills/wave-executor/wave-loop.md:402-438`), STATE.md resumable branch-scoped ownership (`skills/_shared/state-ownership.md:42-50`), the automated file-scope deconfliction algorithm (`skills/session-plan/SKILL.md:409-423`), and the per-repo session lock (`scripts/lib/session-lock.mjs:200-259`). This is the load-bearing safety surface the product does not provide.

The risked surface if we adopt: STATE.md's resumable, schema-versioned, human-auditable session state (Agent Teams' `~/.claude/teams/.../config.json` is machine-owned, hand-edit-forbidden, project-blind, and non-resumable — structurally incompatible), plus every autonomy guard the autopilot loop and inter-wave checkpoint depend on. Token cost also regresses: docs confirm verbatim *"~7x more tokens than standard sessions when teammates run in plan mode"* (per research note § Empirical/3).

## Decision

**Decision: Adapter.** Keep `wave-executor` as the orchestration brain and STATE.md as the single source of truth; do **not** migrate waves onto Agent Teams primitives. Add a Session-Config-flag-gated, default-off Agent Teams *backend spike* scoped narrowly to the one capability the gap matrix shows is genuinely net-new — peer-to-peer teammate messaging on the docs' explicit strongest-fit waves (parallel review and competing-hypothesis debug), never on dependency-ordered Impl-Core/Impl-Polish waves the docs themselves steer away from.

Rationale: **Adopt is refuted on evidence** — migrating would forfeit eleven verified, load-bearing capabilities (every kill-switch, the spiral taxonomy, the inter-wave gate ladder, STATE.md resumability, the deconfliction algorithm, the session lock) to gain exactly one, from an *explicitly experimental, disabled-by-default* feature with hard limitations (no teammate session resumption, lagging task status that silently blocks dependents, no nested teams, machine-owned non-auditable state). That is the inverse of Ruflo's correct conclusion: they kept intelligence/memory/trust and conceded only *basic* orchestration — our differentiation sits squarely in their "kept" column. **Stay is rejected as premature**: it forecloses the one real net-new capability (peer messaging on review/debate waves — the docs' documented strongest fit) before paying the cheap H3 probe to learn whether the `TaskCompleted`/`TeammateIdle` exit-2 hook seams can carry our gate ladder. **Adapter is the falsifiable middle**, inheriting the ADR `2026-05-10-364-remote-agent-substrate.md` graduated-adoption discipline (ship behind a flag, prove on telemetry, promote to blocking only after N≥3 quiet deep sessions). The Adapter's promotion is gated on a single falsifiable test (per research note § Empirical/5, H3): **if a `TaskCompleted` exit-2 hook cannot reliably enforce a quality gate without the coordinator across 3 repeat runs, the spike is closed won't-do and this ADR collapses to Stay with the gap matrix as the standing public rationale.** No default flip occurs without that empirical evidence plus telemetry.

## Consequences

**What changes:**
- A new opt-in Session Config key (default `false`) gates an Agent Teams execution backend, used only for review/competing-hypothesis waves to gain the mailbox-messaging capability. It is a spike, not a default path, until telemetry-promoted.
- The plugin documents (gap matrix as the canonical artifact) why Agent Teams is not a wave substitute — the public rationale against the "redundant plumbing" relevance risk.

**What we keep unchanged (the load-bearing surface — non-negotiable):**
- All **10 kill-switches** (`kill-switches.mjs:18-32`) and their pure pre/post-iteration evaluators — Agent Teams has only 3 exit-2 hook seams and no kill-switch concept.
- STATE.md single-writer, branch-scoped, resumable ownership (`state-ownership.md:42-50`) — the teams config is explicitly machine-owned and non-resumable; it cannot serve this role.
- The **mode-selector** (`skills/mode-selector/SKILL.md`) as the deterministic pre-team planner with persisted rationale/confidence — Agent Teams' lead picks team size heuristically with no persisted rationale.
- The spiral/stagnation taxonomy + MaxTurns circuit-breaker + carryover auto-create (`circuit-breaker.md`).
- **File-scope deconfliction Step 3.5 stays mandatory** (`session-plan/SKILL.md:409-423`). Agent Teams has **no auto worktree isolation** (isolation premise CONFIRMED FALSE, per research note § Empirical/2) and pushes partitioning back onto the operator — our automated pre-spawn task-partitioner becomes *more* essential under any Agent Teams backend, not less, and is the precondition for ever spawning teammates safely.
- The per-repo session lock (`session-lock.mjs:200-259`) — Agent Teams' "one team per session" is per-process, not per-repo.

**Ecosystem interaction:**
- **With Routines / ADR 0003 (#438):** the two Anthropic-native-substrate decisions are coherent and mutually reinforcing. Both reach **Adapter** for the same structural reason: the native primitive supplies raw capability (Agent Teams: parallelism + messaging; Routines: laptop-closed durability) but **zero** of the autonomy-safety surface. Both keep our loop/wave brain as SSOT and add a flag-gated, telemetry-promoted thin lane. Composition is **permitted but bounded** (aligned with ADR 0003's controlling rule): an Agent-Teams-backed review wave *may* run inside a single Routine fire, but it must remain one bounded session — it must not iterate into a cloud loop. They are otherwise orthogonal lanes off the same `wave-executor`/`runLoop` core, never stacked into a multi-iteration loop. See ADR 0003 § Consequences for the authoritative one-bounded-session-per-fire constraint. Consistent with `docs/adr/0001-context-vs-orchestration.md`: orchestration *safety* is the product's value; the platform supplies raw parallelism, not the safety surface.
- **File-scope-deconfliction need:** unchanged and reinforced — see "What we keep."

## Follow-ups

- **#484 — Flag-gated Agent Teams messaging-backend spike (review/debate waves only).** Add default-off Session Config key; spawn wave agents as teammates *only* for parallel-review and competing-hypothesis-debug waves; measure the mailbox-messaging benefit vs current report-back-to-coordinator subagents. No Impl-Core/Polish wiring. Behind the ADR-364 graduated-adoption gate (telemetry, N≥3 quiet sessions before any promotion). **`depends-on:` the H3 hook-seam feasibility test (next item) — this spike MUST NOT start until H3 passes; the Adapter verdict collapses to Stay if H3 fails.**
- **#484 — H3: `TaskCompleted`/`TeammateIdle` exit-2 hook-seam feasibility test (hard precondition).** Enable the env var, create a team with a `TaskCompleted` exit-2 hook running `npm run typecheck`; verify it reliably blocks task completion and feeds back across 3 repeat runs (checking for the docs-noted lagging-task-status race). Gating result: pass → Adapter spike proceeds; fail → spike closed won't-do, ADR collapses to Stay.
- **#484 — H4: `~/.claude/teams/.../config.json` overwrite-on-state-update verification.** Start a team, hand-edit `config.json`, observe whether the edit survives the next teammate state update (docs assert it is overwritten). Confirms the structural-incompatibility-with-STATE.md claim empirically.
- **#484 — Telemetry-gated promotion criteria for the Agent Teams backend.** Define the metric set (token delta vs subagent baseline, messaging-benefit signal on review-wave quality, hook-gate reliability rate) and the N≥3-quiet-deep-session threshold that would promote the flag from spike to default-eligible — mirroring the ADR-364 precedent.

## Implementation Status — deep-3 (2026-05-19)

Adapter verdict stands. H3 hard-precondition test scaffolded but **PENDING-EMPIRICAL** (manual operator step — interactive Agent Teams spawn cannot be automated):

- **H3 harness shipped**: `hooks/agent-teams-h3-test.sh` (DRY-RUN scaffold: precondition_check / scaffold_team_dir / generate_log_template / print_manual_procedure; exit 0/1/2 contract; shellcheck-clean).
- **H3 + H4 procedure documented**: "Deep-3 Agent Teams H3" (#484; archived in the private Meta-Vault) (9 sections + appended H4 config-overwrite verification procedure).
- **Preconditions verified (W1 D2/D6)**: claude-code 2.1.144 (≥ 2.1.32 min), `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` present in binary, no pre-existing `~/.claude/teams/`. TaskCompleted exit-2 hook contract + ~7× plan-mode token cost + isolation-premise-false all re-confirmed against live docs 2026-05-19.
- **Session Config key NOT wired**: the default-off `agent-teams:` key (ADR 0002:69) is intentionally deferred — wiring is gated on `H3 PASS`, which requires the manual empirical run. If H3 fails across 3 runs, ADR collapses to Stay per the existing contract.

W4 architect-reviewer verdict: PASS (no premature Session Config wiring; empirical status correctly preserved).
