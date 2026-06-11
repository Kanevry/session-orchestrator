# Spike #484-H3 — Agent-Teams Hook-Seam Operator Runbook

**Date:** 2026-06-11 · **Session:** main-2026-06-11-session-2 · **Status:** operator package **prepared**; 3 interactive runs **deferred to operator** · **Decides:** ADR-0002 Adapter gate (H3 PASS → Adapter spike proceeds; H3 FAIL → ADR-0002 collapses to **Stay**).

## Why this is a runbook, not an automated test

Discovery (D6) verified the H3 test **cannot be automated headlessly**. Agent Teams are interactive-only, and this host (Ghostty terminal, no tmux) does not support the split-pane swarm view — so `claude --teammate-mode in-process` is mandatory. The hook seam itself (a `TaskCompleted` command-hook exiting 2) is mechanically testable without claude, and that part **is** automated here (`preflight.sh`). The remaining question — *does the teammate's task-completion actually get blocked by the exit-2, or lost to the documented "lagging task status" race?* — needs a human watching the TUI. This package automates everything that can be, and scripts the operator's hands for the rest.

Upstream references: <https://code.claude.com/docs/en/agent-teams> · <https://code.claude.com/docs/en/hooks>

## Context — the ADR-0002 gate

ADR-0002 (`docs/adr/0002-agent-teams-substrate.md`, issue #484) resolved "should `wave-executor` migrate onto Agent Teams primitives?" with verdict **Adapter** — keep `wave-executor` as the orchestration brain, add a thin flag-gated Agent Teams backend only where peer-to-peer teammate messaging helps. That verdict is conditioned on **one** falsifiable test, **H3**:

> "If a `TaskCompleted` exit-2 hook cannot reliably enforce a quality gate without the coordinator across 3 repeat runs, the spike is closed won't-do and this ADR collapses to **Stay** with the gap matrix as the standing public rationale."

The specific failure mode under test: the official docs note verbatim that *"Task status can lag — teammates sometimes fail to mark tasks complete, silently blocking dependents."* H3 tests the **inverse**: that a deliberate exit-2 from the hook **reliably blocks** a task that should complete, and delivers the failure feedback to the teammate — rather than the block being lost to a lagging-status race.

## Pass / fail criteria

**H3 PASS** (Adapter spike proceeds) requires **all** of:

- **Run 1 (pass-state)** completes **unblocked** — `hook_exit_code: 0`, `blocked: false`, `task_status: "completed"`. (Guards against a spurious block of a clean task.)
- **Runs 2 and 3 (fail-state)** each show: `hook_exit_code: 2` **and** `blocked: true` **and** `feedback_delivered: true` **and** `teammate_retried: true`, then `task_status: "completed"` after the teammate corrects the error.

**H3 FAIL** (ADR-0002 collapses to **Stay**) on **any** of:

- A spurious block in run 1 (`blocked: true` when the source is in pass-state), **or**
- Any of runs 2-3 showing `blocked: false` **or** `feedback_delivered: false`.

A single failure invalidates the seam as a quality-gate carrier — the gate must be deterministic to be trustworthy. This is the **lagging-task-status race**: a teammate observing the exit-2 feedback but still racing to mark the task complete.

## The package

Location: `scripts/spikes/h3-agent-teams/` (this repo). All four scripts spawn **no** claude session except `run-h3.sh`, which only *prints* the launch command for the operator to run by hand.

| Script | Spawns claude? | What it does |
|---|---|---|
| `setup.sh` | no | Idempotent fixture builder → `/tmp/h3-agent-teams-test` (package.json, self-contained `typecheck.mjs`, `src/h3.ts`, `.claude/settings.json`, git init + commit, results log + template). |
| `toggle.sh pass\|fail` | no | Rewrites `src/h3.ts` to the PASS (`= 42`) or FAIL (`= "FAIL_MARKER"`) state. |
| `preflight.sh` | no | Smoke-tests the seam's command contract: runs `npm run --silent typecheck` in both states, asserts exit 0 (pass) and exit 2 (fail). Validates the hook command **without** any team. |
| `run-h3.sh [1\|2\|3\|cleanup]` | **no** (prints only) | Operator harness — prints per-run toggle state, exact launch command, the lead prompt, observation keys, the evidence to record, and the between-runs reset. `cleanup` removes the fixture + team/task state. |

### Fixture shape (`/tmp/h3-agent-teams-test`)

> ⚠ **Parallel-session caveat (Q4):** the fixture path is fixed and shared — do NOT run two H3 spikes concurrently on the same host; a second session toggling `src/h3.ts` mid-run produces non-deterministic preflight/run results.

- **`package.json`** — `"typecheck": "node ./typecheck.mjs"` (no deps).
- **`typecheck.mjs`** — self-contained: exits **2** with `typecheck FAILED: type error in src/h3.ts (...)` when the file contains `FAIL_MARKER` or matches `/:\s*number\s*=\s*["']/`; exits **0** with `typecheck PASSED: 0 errors` otherwise; exits **2** with `typecheck: src/h3.ts missing` if absent.
- **`src/h3.ts`** — initial PASS state `export const x: number = 42;`.
- **`.claude/settings.json`** — `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + a `TaskCompleted` hook running `npm run --silent typecheck` (timeout 60). **Committed** so the hook loads cleanly.
- **`h3-results.jsonl`** (empty, operator appends) + **`RESULTS-TEMPLATE.jsonl`** (the record shape).

## How to run

```bash
cd scripts/spikes/h3-agent-teams

# 0. Build the fixture and prove the seam's command contract (no claude session).
./setup.sh
./preflight.sh        # must print PASS for both pass-state (exit 0) and fail-state (exit 2)

# 1. Print the full 3-run procedure (or pass 1|2|3 for a single run).
./run-h3.sh

# 2. Follow the printed steps per run: toggle → launch in-process → paste the
#    lead prompt → observe (Shift+Down teammate pane, Ctrl+T task list) →
#    record one JSONL line into /tmp/h3-agent-teams-test/h3-results.jsonl →
#    reset (cleanup + setup) before the next run.

# 3. Cleanup after all 3 runs.
./run-h3.sh cleanup
# == rm -rf /tmp/h3-agent-teams-test ~/.claude/teams/h3-test-484 ~/.claude/tasks/h3-test-484
```

### Preflight is already proven green (build verification, 2026-06-11)

```
=== H3 preflight — hook-seam command contract (no claude session) ===
PASS: pass-state → exit 0 (expected 0)  | typecheck PASSED: 0 errors
PASS: fail-state → exit 2 (expected 2)  | typecheck FAILED: type error in src/h3.ts (string assigned to number / FAIL_MARKER present)
=== preflight result ===
ALL ASSERTIONS PASSED — hook command contract verified (exit 0 pass / exit 2 fail)
```

The command contract the hook depends on is therefore confirmed. What remains is purely the interactive teammate-behaviour question.

## The lead prompt (paste verbatim per run)

> Create an agent team named **h3-test-484** with one teammate called **impl-agent**. Assign impl-agent a single task: *'Make npm run typecheck pass for src/h3.ts, then mark the task complete.'* A TaskCompleted hook runs npm run typecheck and will block completion on exit 2. Do not fix the file yourself — let the teammate do it.

## 3-run matrix

| Run | `src/h3.ts` state | Hook exit | Expected outcome | What it proves |
|---|---|---|---|---|
| 1 | pass (`= 42`) | 0 | task **completed**, `blocked: false` | No spurious block of a clean task. |
| 2 | fail (`= "FAIL_MARKER"`) | 2 | **blocked**, feedback delivered, teammate retries → completed | Exit-2 reliably gates (run A). |
| 3 | fail (`= "FAIL_MARKER"`) | 2 | **blocked**, feedback delivered, teammate retries → completed | Exit-2 reliably gates (run B — reproducibility). |

Fresh team per run (the harness's reset step removes `~/.claude/teams/h3-test-484` + `~/.claude/tasks/h3-test-484` and rebuilds the fixture).

## Observation keys (inside the claude TUI)

- **Shift+Down** — focus/scroll the teammate pane; read its actions and the hook feedback it received.
- **Ctrl+T** — toggle the task list; watch the task status transition (and whether it lags).

## Evidence schema (one line per run → `h3-results.jsonl`)

```json
{"timestamp":"<ISO>","run_n":1,"src_state":"pass|fail","hook_exit_code":0,"task_status":"completed|blocked|stuck","blocked":false,"feedback_delivered":false,"teammate_retried":false,"transcript_excerpt":"...","notes":"..."}
```

## Known staleness notes (from D6 — fold into the issue when filing results)

1. **Token-cost wording.** Upstream docs no longer claim the old "~7×" token cost for teams; they now say "significantly more tokens." Treat any "~7×" figure in our older notes as stale; cite the current "significantly more tokens" phrasing.
2. **Typecheck command mismatch.** `docs/research/2026-05-19-deep-3-agent-teams-h3.md:46` claims our typecheck is `tsgo --noEmit`. That is wrong for this fixture: the fixture's typecheck is `node scripts/typecheck.mjs` (here, `node ./typecheck.mjs`), which is **why the fixture is deliberately self-contained and needs no install step**. Do not "correct" the fixture to `tsgo` — the zero-dependency node gate is intentional so the seam test has no toolchain prerequisite.

## Terminal constraint

Split-pane swarm view is unsupported in Ghostty → `--teammate-mode in-process` is mandatory on this host. Observation is via in-pane keys (Shift+Down / Ctrl+T) rather than a side-by-side swarm layout.
