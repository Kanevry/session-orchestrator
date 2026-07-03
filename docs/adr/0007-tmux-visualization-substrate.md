# ADR 0007: tmux as Optional Visualization Substrate

> Status: PROPOSED · session main-2026-05-25 · issue TBD (parent)
> Source research: in-session web survey 2026-05-25 (Anthropic Agent Teams Feb 2026, native worktree Nov-Dec 2025, claude-squad/workmux/Tmux-Orchestrator community tools) + codebase scan (autopilot-multi, wave-executor in-process dispatch, monitor-patterns) + telemetry review (`.orchestrator/metrics/sessions.jsonl`, `learnings.jsonl`, `autopilot.jsonl`).
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

## Context

Two adjacent Anthropic shipments in Q4 2025 / Q1 2026 created a strong community pull toward tmux as the de-facto visual layer for parallel Claude Code work:

1. **Native git-worktree support** in Claude Code CLI (Nov-Dec 2025; Boris Cherny, Anthropic: *"Single biggest productivity unlock"*).
2. **Agent Teams** as experimental opt-in (Feb 2026; `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, see ADR 0002).

Anthropic ships the orchestration engine but **no visual surface** for N parallel sessions. The community filled the gap with terminal-multiplexer wrappers: `smtg-ai/claude-squad` (TUI over tmux managing N agents in isolated workspaces), `raine/workmux` (git worktree + tmux window minimalism), `absmartly/Tmux-Orchestrator` (tmux + role templates), the `oh-my-codex` pattern (worktree-per-worker + 30 role-specialized agents). Common pattern: **1 tmux-pane = 1 Claude Code session = 1 worktree.**

This ADR asks whether session-orchestrator should adopt a tmux integration — and if so, at which layer.

Three load-bearing facts from the in-repo evidence (telemetry + learnings, surveyed 2026-05-25):

- **Wave-agents are in-process, not separately observable.** `wave-executor` dispatches 6–18 agents per wave via the harness's `Agent()` tool in a single message block (`skills/wave-executor/wave-loop.md`, learning `parallel-subagent-dispatch-5w6a` conf 0.95, 14-consecutive sessions green). These agents are not spawned as CLI subprocesses, have no TTY, and cannot be hosted in a tmux pane. Any "pane-per-wave-agent" concept is structurally impossible without a fundamental harness change Anthropic has not announced.
  > **Note (2026-07-03, refs #724):** the "single message block" dispatch mechanics cited here are superseded — `wave-loop.md § Dispatch Agents` now mandates **small batches of 3–4 Agent() calls per message** (fleet evidence conf 1.0 shows large single-message fan-outs drop calls silently). This ADR's load-bearing conclusion is unaffected: wave agents remain in-process `Agent()` calls with no PID/TTY/pane, so pane-per-wave-agent stays structurally impossible regardless of batch size.
- **Autopilot-Multi (N parallel issue pipelines, the only feature that *could* be pane-decomposed) is barely used in practice.** `autopilot.jsonl` contains 11 entries as of 2026-05-25 — eight are dry-runs or confidence-fallback aborts. The hypothetical "pane-per-story" win addresses a feature whose adoption signal is below the noise floor.
- **The recurring operator-side pain points are visualization-of-side-channels.** Sessions repeatedly bottleneck on (a) inter-wave Quality-Gate output (5000+ tests, multiple minutes; learning `parallel-bash-for-mechanical-quality-gates` conf 0.7), (b) CI status post-push (sessions consistently end with `Pipeline NNNN GREEN` / `5 CI iterations on !10` polling overhead), (c) STATE.md visibility during long sessions, and (d) the `/debug` skill's 4-phase parallel hypothesis-test pattern. None of these are "wave-agent visibility" — they are coordinator-side observability of asynchronous side-channels the coordinator itself produced.

The risked surface if we adopt naively: the single-coordinator-chat-as-decision-point invariant (AUQ-001 in `.claude/rules/ask-via-tool.md`), the in-process wave dispatch model, and the operator's attention budget. The coordinator chat is *deliberately* the single point of decision — distributing it across panes is a regression, not an upgrade.

## Decision

**Decision: Adapter.** Adopt tmux as an **optional visualization skill** for the operator-side side-channels — never as a replacement for the wave-executor dispatch model, the coordinator chat as decision point, or STATE.md as session SSOT.

Concretely: ship a default-off, opt-in `/tmux-layout` skill that renders two prepared layouts (`default` and `debug`) tailored to the *evidenced* pain points — STATE.md tail, CI-watch, `events.jsonl`/test-output tail in the default layout; hypothesis-test, log-tail, STATE-tail, diff-watch in the debug layout. The skill never auto-spawns, never replaces the coordinator-chat surface, and degrades gracefully when tmux is absent (clear stderr message, exit 1, no side effects). No wiring into wave-executor, autopilot-multi, or session lifecycle hooks at this stage.

Rationale: **Adopt-as-canonical-surface is refuted on evidence** — adopting `claude-squad` or `workmux` as the canonical surface would forfeit our hooks discipline, our STATE.md ownership contract, our Session Config wiring, and our coordinator-chat decision-point invariant for a UX gain that the in-process wave dispatch model cannot deliver. **Stay is rejected as a missed leverage**: the four evidenced operator-side pain points (Quality-Gate output, CI-watch, STATE-tail, `/debug` parallelism) compound across every session type and are exactly the side-channels a terminal multiplexer is designed to surface in parallel. **Pane-per-wave-agent is rejected as structurally impossible** — wave agents are in-process Agent() calls inside the harness; there is no PID, no TTY, no pane to attach. **Pane-per-story for autopilot-multi is rejected on telemetry** — 11 entries, 8 dry-runs; building a UI for an unused feature is premature.

Adapter is the falsifiable middle, inheriting the ADR 0002 (Agent Teams) and ADR 0003 (Routines) graduated-adoption discipline: ship behind a flag (here: the skill is itself opt-in — no Session Config key needed at this stage), prove value on telemetry (skill-invocation count, layout-completion rate, user survey signal), promote from "opt-in skill" to "default-recommended in deep-session banner" only after N≥3 quiet deep sessions show operator-reported time-to-CI-result reduction without coordinator-chat regressions.

## Consequences

**What changes:**

- A new opt-in skill `/tmux-layout [default|debug]` is added under `skills/tmux-layout/`. It spawns a prepared tmux layout when invoked, attaches the user, and is otherwise inert. Default and debug variants both target the **evidenced operator-side side-channels**, not the in-process wave agents.
- A doc-row is added to the `tmux-layout` section of `skills/_shared/monitor-patterns.md` describing the relationship to Monitor and `/loop` (tmux for *persistent visualization of side-channels the operator wants peripherally*, Monitor for *event-driven streaming the coordinator needs to react to*, `/loop` for *periodic coordinator-side polling within a single session*).
- The `/debug` skill gains a single optional line referencing `/tmux-layout debug` as a recommended companion for Phase 2 hypothesis-test parallelism. No behavioral change.

**What we keep unchanged (non-negotiable):**

- **The coordinator chat as the single point of decision** (AUQ-001, `.claude/rules/ask-via-tool.md`). The skill never moves AUQ questions, plan approvals, or PSA pauses into a side pane. The user answers everything in the coordinator pane, period.
- **`wave-executor`'s in-process dispatch model** (`skills/wave-executor/wave-loop.md`, learning `parallel-subagent-dispatch-5w6a` conf 0.95 — batch-size mechanics updated 2026-07-03 per #724, see the Context note above; the in-process property is unchanged). The skill does not attempt to host wave agents in panes — they remain harness-managed Agent() calls.
- **STATE.md as session SSOT** (`skills/_shared/state-ownership.md`). The skill *reads* STATE.md (via `tail -F`) but never writes it.
- **PSA-003 destructive-action safeguards** (`.claude/rules/parallel-sessions.md`). The skill never kills, resets, or modifies foreign tmux sessions; it only creates a new named session and refuses to overwrite an existing one without explicit `--force`.
- **The `/loop` and `Monitor` tools and their routing rule** (`.claude/rules/loop-and-monitor.md`). tmux does not replace either — it visualizes their *outputs* peripherally so the coordinator pane can stay focused on decisions.

**Ecosystem interaction:**

- **With ADR 0002 (Agent Teams Adapter, #484)** — orthogonal. Agent Teams is a *messaging* backend behind a flag; tmux-layout is a *visualization* skill behind opt-in invocation. They compose: an Agent-Teams-backed review wave could eventually be visualized in a tmux layout, but only after both spikes have telemetry-promoted independently. No coupling at this ADR.
- **With ADR 0003 (Routines Adapter, #485)** — orthogonal. Routines run laptop-closed; tmux-layout requires an attached terminal. No interaction.
- **With ADR 0004 (Context-Mode Tool Output Sandbox)** — orthogonal. Context-mode is a coordinator-internal isolation mechanism; tmux-layout is operator-external visualization.
- **With `claude-squad` / `workmux` / `Tmux-Orchestrator` (external tools)** — coexistence permitted; users who already run claude-squad as their canonical surface can ignore `/tmux-layout`. Documentation will note the trade-off (claude-squad gives a broader TUI, our skill stays inside the session-orchestrator instruction-file-resolution path and respects all hooks).

**Token / resource cost:** zero at idle (skill not invoked). When invoked, the skill writes a bash command and exits — no LLM token spend beyond the invocation itself. Operating cost is shell-side `tail -F` and `glab ci status --live` polling, which is amortized across the whole session.

## Follow-ups

- **Parent issue — `/tmux-layout` skill scaffold + default 4-pane layout.** Default layout: pane 1 coordinator (current `claude` process attached read-only or new session — TBD in implementation Q&A), pane 2 `tail -F .claude/STATE.md`, pane 3 `glab ci status --live` (or `gh pr checks --watch` based on `vcs:` config key), pane 4 `tail -F .orchestrator/metrics/events.jsonl | jq …` test/event filter. Graceful degradation when tmux missing. Labels: `best-practice-2026, type:feature, area:skills, priority:medium, status:ready`. Appetite: `appetite:1w`.
- **Child issue — `/tmux-layout debug` variant.** Second layout for the `/debug` 4-phase skill: pane 1 coordinator, pane 2 hypothesis-test runner (`npm test -- --watch` or equivalent), pane 3 `tail -F .orchestrator/debug/*.md`, pane 4 `git diff --stat | watch`. `depends-on:` parent. Labels: `best-practice-2026, type:feature, area:skills, priority:low, status:ready`.
- **Child issue — telemetry + promotion gate.** Define metrics (skill-invocation count via `events.jsonl` event-type `tmux-layout.invoked`, layout-completion rate, user-survey signal after 3 deep sessions) + N≥3-quiet-deep-session threshold before promoting to default-recommended in the session-start banner. Mirrors ADR 0002 / ADR 0003 / ADR-364 graduated-adoption precedent. Labels: `best-practice-2026, type:chore, area:metrics, priority:low, status:ready`.
- **Promotion criteria (codified at parent issue close-out):** invocation count ≥ 5 across ≥ 3 distinct deep sessions over ≥ 2 calendar weeks, layout-completion rate ≥ 80%, zero coordinator-chat regressions reported, operator-reported time-to-CI-result reduction confirmed in survey. Fail any → stays opt-in indefinitely or rolls back.
