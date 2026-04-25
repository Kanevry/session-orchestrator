# PRD — /autopilot Loop Command (Phase C)

**Epic:** [#271 v3.2 Autopilot — Autonomous Session Orchestration](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/271)
**Phase:** C (/autopilot Loop Command)
**Issue:** [#277 [Phase C] v3.2 /autopilot Loop Command — eigene PRD required](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/277)
**Appetite:** 6w
**Visibility:** internal
**Status:** scaffold 2026-04-25
**Dependencies:** Phase A shipped (#272–#275) · Phase B shipped (#276 + #291–#294)

## Problem

Manual session orchestration scales to one session at a time. Each session-start requires user attention for ~10–60 seconds (Mode-Selector AUQ, scope confirmation, plan approval). For a single user shipping 5–8 sessions per day, this is 5–8 attention switches that interrupt deeper work.

Phase A established `recommended-mode` handoff. Phase B made Mode-Selector deterministic with a `confidence` signal. Both phases were prerequisites — the missing piece is a controller that **reads the Mode-Selector recommendation, decides whether to auto-execute, and chains session-start → session-plan → wave-executor → session-end into a loop with kill-switches**.

**Concrete symptom:** even when Mode-Selector emits `confidence ≥ 0.85` for a clearly-routine session (e.g. mechanical refactor cluster, post-merge housekeeping), the user must still click through 3–5 AUQ prompts before any work happens. The cost-per-decision should scale with the actual decision complexity — high-confidence routine sessions should require zero clicks.

**Goal:** ship `/autopilot [--max-sessions=N] [--max-hours=H] [--confidence-threshold=0.X]` that runs N session cycles autonomously, hard-stopping on SPIRAL detection, FAILED waves, carryover-ratio > threshold, max-hours timeout, or sub-threshold confidence (fallback to manual AskUserQuestion). Telemetry is captured separately so manual-vs-autopilot effectiveness can be compared.

## Non-Goals

This Phase C ships **only**:

- This PRD (`docs/prd/2026-04-25-autopilot-loop.md`)
- `skills/autopilot/SKILL.md` — full skill specifying loop semantics, kill-switches, telemetry contract, resource-adaptive cap logic
- `commands/autopilot.md` — `/autopilot [--max-sessions=N] [--max-hours=H] [--confidence-threshold=0.X]` argument parsing entry point
- `scripts/lib/autopilot.mjs` — loop iteration runner with kill-switch enforcement and `autopilot.jsonl` writer
- Tests for skill contract (W3) and `autopilot.mjs` unit tests (W3)

This Phase C does NOT ship:

- A new VCS/CI integration — Phase C runs locally only, dispatched by the user
- Multi-host coordination (the SSH `--remote` path is Phase D speculation)
- Cross-repo orchestration (`/autopilot` operates on the current repo only)
- Auto-merge / auto-PR — `/close` semantics unchanged; `/autopilot` invokes `/close` per iteration but does NOT push or merge
- Mode-Selector heuristic tuning — Phase C consumes whatever `selectMode` returns; v1.x quirk fixes ship as separate Phase B-1.x sub-issues
- Modifications to `selectMode`, `recordAccuracy`, or any other Phase A/B contract
- A web UI or dashboard for autopilot.jsonl — log analysis is CLI-only initially

Each follow-up below ships as a separate sub-issue.

## Contract

### Command Surface

```
/autopilot [--max-sessions=N] [--max-hours=H] [--confidence-threshold=0.X] [--dry-run]
```

| Flag | Type | Default | Range / Semantics |
|------|------|---------|-------------------|
| `--max-sessions` | int | `5` | Hard cap on session iterations. Loop exits when reached even if no kill-switch fires. Bounds: `1..50` (silent clamp). |
| `--max-hours` | float | `4.0` | Wall-clock budget for the entire loop. Monotonic — does not reset between iterations. Bounds: `0.5..24.0` (silent clamp). |
| `--confidence-threshold` | float | `0.85` | Minimum `selectMode` confidence required for auto-execute. Below threshold → fallback to manual AUQ. Bounds: `0.0..1.0` (silent clamp). `0.0` = always-manual fallback (debug only). |
| `--dry-run` | flag | `false` | Emits the planned iterations + Mode-Selector decisions to stdout without executing. Useful for cron-mode preview. |

### Loop Semantics

```
state := { iterations_completed: 0, started_at: <ISO>, kill_switch: null, sessions: [] }

WHILE state.iterations_completed < max-sessions:
  IF (now() - state.started_at) > max-hours: kill_switch := 'max-hours-exceeded'; break
  IF resource_verdict() == 'critical' AND peer_count() > resource_thresholds.autopilot-peer-abort (default 6):
    kill_switch := 'resource-overload'; break

  recommendation := mode-selector.selectMode(<live signals from session-start Phase 7.5>)

  IF recommendation.confidence < confidence-threshold:
    fallback_to_manual()  # invoke session-start as if /session was run manually; user sees AUQ
    break  # autopilot exits — manual takes over from here
  ELSE:
    cap := resource_adaptive_cap()  # see "Resource-Adaptive Concurrency" below
    session_result := run_session(mode=recommendation.mode, agents_per_wave_cap=cap)
    state.sessions.append(session_result.session_id)

    IF session_result.spiral_detected: kill_switch := 'spiral'; break
    IF session_result.failed_waves > 0: kill_switch := 'failed-wave'; break
    IF session_result.carryover_ratio > 0.50: kill_switch := 'carryover-too-high'; break

    state.iterations_completed += 1

write_telemetry(state, kill_switch)
```

**Key invariants:**
- Each iteration runs the FULL session lifecycle: session-start → session-plan → wave-executor → session-end.
- Iteration boundaries are atomic — a session must complete (`/close`) before the next starts. No mid-session aborts mid-loop.
- The loop never runs if `confidence < threshold` on iteration 1 — autopilot is opt-in even for the first run; sub-threshold confidence triggers manual fallback immediately.
- Kill-switches are checked AFTER each session completes, BEFORE deciding to continue. The current iteration always finishes cleanly even if a kill-switch will fire after.

### Output: `state` object → `autopilot.jsonl`

Each `/autopilot` invocation writes ONE record to `.orchestrator/metrics/autopilot.jsonl`:

```json
{
  "schema_version": 1,
  "autopilot_run_id": "<branch>-<YYYY-MM-DD>-<HHmm>-autopilot",
  "started_at": "<ISO>",
  "completed_at": "<ISO>",
  "duration_seconds": 7234,
  "max_sessions": 5,
  "max_hours": 4.0,
  "confidence_threshold": 0.85,
  "iterations_completed": 3,
  "kill_switch": "carryover-too-high",
  "kill_switch_detail": "iteration 4: carryover_ratio=0.62 > 0.50",
  "sessions": ["main-2026-04-25-0900", "main-2026-04-25-1015", "main-2026-04-25-1133"],
  "host_class": "<from .orchestrator/host.json>",
  "resource_verdict_at_start": "<verdict snapshot>",
  "fallback_to_manual": false
}
```

`fallback_to_manual: true` is set when iteration 1 sub-threshold confidence triggers immediate manual fallback. In that case `iterations_completed: 0`, `sessions: []`, `kill_switch: null`.

## Resource-Adaptive Concurrency

`/autopilot` does NOT hard-block on peer Claude processes. Instead, it reads `resource-probe.evaluate()` (v3.1.0) before each iteration and adapts `agents-per-wave` accordingly. This avoids hours-long blocking when other sessions are merely idle.

### Cap-Decision Table

| Tier | RAM free | Swap used | Peer Claude procs | macOS memory_pressure | `agents-per-wave` cap |
|------|----------|-----------|-------------------|------------------------|------------------------|
| **green** | ≥ 6 GB | < 1 GB | ≤ 2 | ≥ 30% free | Session Config default (typically 6) |
| **warn** | 4–6 GB | 1–2 GB | 3–4 | 15–30% free | 4 |
| **degraded** | 2–4 GB | 2–3 GB | 5–6 | 5–15% free | 2 |
| **critical** | < 2 GB | > 3 GB | > 6 | < 5% free | 0 (coordinator-direct) |

**Tier-determination rule:** the **most-restrictive matching signal wins**. Example: RAM 5 GB (green) but peer count 7 (critical) → tier = critical.

### Existing vs. New Signals

| Signal | Status | Source |
|--------|--------|--------|
| RAM free (GB) | **Existing** | `scripts/lib/resource-probe.mjs` |
| CPU load 1m | **Existing** | `scripts/lib/resource-probe.mjs` |
| Claude peer count | **Existing** | `scripts/lib/resource-probe.mjs` |
| Swap used (MB) | **NEW (Phase C)** | `vm.swapusage` on macOS, `/proc/meminfo` on Linux |
| macOS `memory_pressure` | **NEW (Phase C)** | `memory_pressure` command output parsing |

The two new signals ship as additions to `resource-probe.mjs` so non-autopilot consumers (manual session-start, wave-executor) benefit too. Defaults are conservative; calibration to real Macbook data is a follow-up sub-issue.

### Calibration Note

The cap-decision thresholds above are **initial estimates based on observed coord-direct success at RAM < 2 GB across 8 consecutive sessions**. They have NOT been calibrated against autopilot-loop multi-iteration data (none exists yet). A Phase C-1 discovery sub-issue will collect 10+ autopilot runs and tune the thresholds via swap/memory_pressure correlation with session-end success metrics.

## Kill-Switches

| Kill-switch | Trigger | When checked |
|-------------|---------|--------------|
| `spiral` | wave-executor's spiral detection fires (any wave) | After each session |
| `failed-wave` | At least one wave reports `agent_summary.failed > 0` | After each session |
| `carryover-too-high` | `effectiveness.carryover / planned_issues > 0.50` | After each session |
| `max-hours-exceeded` | Wall-clock since loop start > `max-hours` | Before each iteration |
| `max-sessions-reached` | `iterations_completed >= max-sessions` | Before each iteration (graceful, not error) |
| `resource-overload` | `verdict == 'critical' AND peer_count > 6` | Before each iteration |
| `low-confidence-fallback` | `selectMode().confidence < confidence-threshold` (iteration 1 only) | Before iteration 1 |
| `user-abort` | User Ctrl+C / Esc | Continuous |

After ANY kill-switch fires, the loop exits, writes the autopilot.jsonl record, and emits a final summary banner. The user can re-run `/autopilot` after addressing the cause.

**Mid-loop low-confidence behavior:** if iteration 2+ produces sub-threshold confidence, the loop **does NOT fall back to manual** — it exits with kill_switch `low-confidence-fallback` and lets the user decide whether to continue manually. Only iteration 1 sub-threshold triggers seamless manual fallback (the user typed `/autopilot` once; the system shouldn't silently start a manual flow without acknowledgment beyond the first iteration).

## Ownership Matrix

| Component | Role | Writes? |
|-----------|------|---------|
| `selectMode()` (Phase B) | Consumer | No side effects |
| `scripts/lib/resource-probe.mjs::evaluate()` (Phase v3.1.0 + new signals) | Read-only | No |
| `scripts/lib/autopilot.mjs::runLoop()` | Loop runner; orchestrates session lifecycle | Writes `autopilot.jsonl` only |
| session-start / session-plan / wave-executor / session-end | Standard skills | Existing write paths unchanged |
| `.orchestrator/metrics/autopilot.jsonl` | New telemetry log | autopilot.mjs is sole writer |
| `.orchestrator/metrics/sessions.jsonl` | Existing | Each iteration writes ONE entry as today (manual or autopilot indistinguishable) |

**Cross-cutting:** the autopilot run_id is also written into each iteration's `sessions.jsonl` entry as `autopilot_run_id` (optional field — `null` for manual sessions). This lets retros correlate manual vs. autopilot effectiveness without joining tables.

## Q-Decisions

- **Q1 — Why a separate `autopilot.jsonl` instead of folding into `sessions.jsonl`?** Loop metadata (kill-switch reason, run_id, threshold, max-hours) is per-loop, not per-session. Folding would denormalize and require null-padding ~10 fields on every manual entry. The `autopilot_run_id` cross-reference field on session entries is the join key; no data is lost.
- **Q2 — Why `0.85` as the default confidence threshold?** It maps to the `≥ 0.85 = autonomous-execute` band already documented in `skills/mode-selector/SKILL.md` Fallback Behavior. The current heuristic v1 rarely emits ≥ 0.85 — only SPIRAL (0.80) + bonuses or strong CARRYOVER paths. This forces explicit user-override-via-flag for early dogfooding while feedback data accumulates. Lowering happens via flag, not config drift.
- **Q3 — Why iterate session-by-session instead of pre-planning N sessions upfront?** Each session's outcome (carryover, failed waves, learnings written) directly affects the NEXT session's signals. Pre-planning would require either re-running selectMode after each iteration anyway (no savings) or committing to a multi-session plan that can't adapt to in-flight failures. Per-iteration decisions are the correct atomicity.
- **Q4 — Why hard-stop on FAILED waves instead of trying to recover?** Wave-executor already has spiral detection + recovery within a single session. If a wave still reports `failed > 0` after that, the failure is structural (test contract drift, environment issue) and re-trying autonomously will compound damage. The user must triage.
- **Q5 — Why `0.50` carryover threshold and not, say, `0.30`?** Carryover < 30% is normal for moderate-complexity sessions (Phase A Phase B both shipped at 0% but earlier vault-docs sessions had 20–40% carryover and were healthy). 50% is the inflection where the loop is treading water — half the planned work didn't finish. Below that, carryover is signal; above, it's a brake.
- **Q6 — Why is `max-sessions: 5` the default?** Most observed productive workdays ship 3–7 sessions. 5 is the median. Below 5 is too restrictive for autopilot to provide value; above 5 increases the chance of a low-quality late-loop session diluting metrics. Easy to override via flag.
- **Q7 — Why no auto-PR / auto-merge?** PSA-001/002/003 (parallel-session safeguards) explicitly warn against destructive actions without user awareness. `git push --force` and PR creation are user-attention-required actions. `/close` already commits and pushes to origin; merging is manual.
- **Q8 — Why does iteration 1 sub-threshold fall back to manual but iteration 2+ does not?** The user invoked `/autopilot` expecting at least one iteration. Iteration 1 fallback respects that intent (manual flow runs to completion). Iteration 2+ fallback would mean autopilot ran a session, then silently switched the user back to manual — confusing and surprising. Better to exit cleanly.

## Validation

Tests (W3) must cover:

### `scripts/lib/autopilot.mjs` unit tests

- Loop exits on each kill-switch path (8 tests, one per kill-switch enum)
- `--max-sessions=1` runs exactly one iteration
- `--max-hours=0` triggers `max-hours-exceeded` before iteration 1 (edge case)
- `--dry-run` produces output without invoking session lifecycle
- `--confidence-threshold=0.0` makes every iteration auto-execute regardless of confidence (debug mode)
- Out-of-range flags clamp to bounds without erroring
- `autopilot.jsonl` record written even on kill-switch exit (atomic via tmp+rename)
- `autopilot_run_id` propagates into each iteration's session record

### Resource-probe extension tests

- Swap > 3 GB → tier `critical` regardless of RAM
- macOS memory_pressure < 5% → tier `critical` regardless of swap
- Most-restrictive-signal-wins rule: `[ram=8GB, swap=0, peers=7]` → critical (peer rule wins)
- Linux fallback path produces equivalent verdict (no macOS-specific paths required)

### Skill contract tests

- `commands/autopilot.md` references the skill correctly
- `skills/autopilot/SKILL.md` declares `user-invocable: true`
- Skill loop pseudocode matches `autopilot.mjs::runLoop` step order

## Phase C Follow-Up Sub-Issues (to be filed at /close)

- `[Phase C-1] autopilot.mjs implementation — runLoop + autopilot.jsonl writer + kill-switch enforcement` (the meat of the work)
- `[Phase C-2] resource-probe.mjs swap + memory_pressure signals — extend probe() output, evaluate() tier-decision`
- `[Phase C-3] Cap-decision threshold calibration — collect 10+ autopilot runs, tune swap / memory_pressure / peer-count thresholds against session success metrics`
- `[Phase C-4] /evolve type 8 — autopilot-effectiveness learnings (compare manual vs. autopilot completion rates)`
- `[Mode-Selector v1.x quirk] alt-confidence > primary fix — pick global-max-confidence mode as primary, not just passthrough branch` (separate Phase B-1.x scope, NOT a Phase C blocker)

## Phase C Forward-Reference

After Phase C ships:

- **Phase D speculation (NOT in any current epic):** SSH-attached autopilot for unattended remote dev hosts. Would require multi-host registry coordination + remote git push gating.
- **Phase E speculation:** cross-repo `/autopilot --epic=#NNN` that walks an epic's child issues across multiple repos. Currently out of scope — would require substantial bootstrap-lock + ecosystem-wizard rework.

## Risks

- **R1 — Mode-Selector accuracy is unproven** at the time of writing. The first `mode-selector-accuracy` learning was just written this morning (session main-2026-04-25-0833). Phase C SHOULD NOT ship to production users until at least 20 manual sessions have written accuracy learnings (~2 weeks dogfooding). The `confidence-threshold` default of 0.85 is the primary mitigation.
- **R2 — Resource-probe new signals (swap, memory_pressure) ship without calibration data.** The thresholds in the cap-decision table are estimates. Phase C-3 follow-up will tune them. Until tuned, autopilot may be either overcautious (frequently dropping to coord-direct unnecessarily) or undercautious (running 4-agent waves on a thrashing system).
- **R3 — Wave-executor's spiral detection is the only spiral safeguard.** If spiral detection has false negatives, autopilot can amplify them by running multiple bad sessions before the carryover-ratio kill-switch fires. Mitigation: kill-switch order checks `spiral` first per iteration; carryover is a backstop.
- **R4 — `/autopilot` increases concurrent-Claude-process count by 1.** When `peer_count > 4` at autopilot start, the loop already runs in `degraded` or `critical` tier. The user is warned via banner before iteration 1.
- **R5 — Telemetry pollution if autopilot crashes mid-iteration.** `autopilot.jsonl` write is atomic (tmp + rename) but if the process is killed before the final write, the loop's progress is lost. STATE.md still reflects per-session state, so manual recovery is possible via `/session [type]` resume flow.

## Open Questions (deferred to Phase C-1 implementation)

- Should `--confidence-threshold` accept `auto` to let autopilot self-tune from `mode-selector-accuracy` learnings? (Probably yes, but requires Phase B-4 data accumulation first.)
- Should `/autopilot` write to STATE.md a special `autopilot-active: true` flag that other Claude sessions detect via the session-registry to refuse to start? (Maybe — depends on how disruptive concurrent autopilot + manual sessions actually are. Let dogfooding inform.)
- Should kill-switch `failed-wave` distinguish between "agent failed and was retried successfully" vs. "wave ended with un-recovered failures"? wave-executor's current schema doesn't differentiate; clarification is a separate audit.
