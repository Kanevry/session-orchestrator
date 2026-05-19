# Anthropic Routines as /autopilot Cloud Path — Evaluation

> Research note — session main-2026-05-19-deep-2 · issue #438 · status: COMPLETE (W2)

## Context

Our `/autopilot` skill (Phase C-1.b, issues #295 + #300; STALL_TIMEOUT added Phase
C-2 / ADR-364) is **local-only by construction**. The PRD `docs/prd/2026-04-25-autopilot-loop.md:31-39`
states explicitly: "This Phase C does NOT ship … Phase C runs locally only, dispatched
by the user". `runLoop` (`scripts/lib/autopilot/loop.mjs:66-287`) is a pure in-process
controller driven by Claude *inside an open chat session* — `skills/autopilot/SKILL.md:211-220`
calls this out as a `Con: not truly autonomous — Claude must stay in the chat. Doesn't
deliver walk-away UX.` When the laptop closes, the loop dies.

On 14 Apr 2026 Anthropic shipped **Routines** (research preview): a saved
Claude Code configuration — prompt + repositories + connectors + ≥1 trigger — that
"execute on Anthropic-managed cloud infrastructure, so they keep working when your
laptop is closed" (https://code.claude.com/docs/en/routines). This is a direct
candidate for the exact gap `skills/autopilot/SKILL.md:218` names. The decision
factor from issue #438: **if Routines lack our kill-switches we cannot recommend
them for autonomy; if they expose a stop-condition we could feed spiral-detection
into, they become attractive.** This note resolves the trade-off matrix against
verified evidence.

`.claude/rules/loop-and-monitor.md` LM-004 already routes "work that must run when
no session is open … cross-repo … persist across machine restarts" to Routines/Desktop,
and LM-005 explicitly forbids reimplementing `/autopilot` as `/loop` because that
"loses both [kill-switches and telemetry]". The open question is whether Routines
**preserve** them where `/loop` does not.

## Question

**Adopt** Routines as the cloud-execution backend for `/autopilot` (replace the
local loop), **Add-as-Option** (keep the local `runLoop` controller; offer a thin
Routine-packaging path as an opt-in cloud lane), or **Skip** (document why the
local loop stays the only autonomy substrate)?

Sub-questions from the issue, each resolved in the Gap Matrix:
kill-switches · spiral detection · cost transparency/billing · continues-when-laptop-closed
· repo access model · debug-ability · session-end compatibility.

## External Findings (cited)

All facts below cite the canonical Anthropic docs unless marked as third-party.

1. **Composition & execution.** "A routine is a saved Claude Code configuration: a
   prompt, one or more repositories, and a set of connectors … Routines execute on
   Anthropic-managed cloud infrastructure, so they keep working when your laptop is
   closed." (https://code.claude.com/docs/en/routines). Status: **research preview**
   — "Behavior, limits, and the API surface may change."

2. **Triggers.** Three types, combinable on one routine: **Scheduled** (recurring
   cadence or one-off; "minimum interval is one hour; expressions that run more
   frequently are rejected"), **API** (per-routine `/fire` HTTPS endpoint with a
   bearer token, optional freeform `text` payload), **GitHub** (`pull_request.*`
   / `release.*` events, filterable). (https://code.claude.com/docs/en/routines).

3. **No permission prompts / no approval gates.** "Routines run autonomously as
   full Claude Code cloud sessions: there is no permission-mode picker and no
   approval prompts during a run." Connectors: "Claude can use every tool from an
   included connector, including writes, without asking for permission during a
   run." (https://code.claude.com/docs/en/routines). **There is no documented
   stop-condition expression, max-iteration cap, max-turn cap, or budget kill-switch
   on a routine run.** The only documented bound is the per-account daily run cap.

4. **Repo access = fresh clone, no local FS.** The scheduling comparison matrix
   (https://code.claude.com/docs/en/scheduled-tasks) states Cloud "Access to local
   files: **No (fresh clone)**". Routines doc: "Each repository is cloned at the
   start of a run, starting from the default branch. Claude creates `claude/`-prefixed
   branches for its changes." Pushing to non-`claude/` branches requires opting into
   "Allow unrestricted branch pushes" per repo. Commits/PRs "carry your GitHub user".

5. **Cost / billing.** "Routines draw down subscription usage the same way
   interactive sessions do. In addition … routines have a daily cap on how many runs
   can start per account." Consumption visible at `claude.ai/code/routines` /
   `claude.ai/settings/usage`. Third-party reporting (InfoQ, 9to5Mac, AI Magicx —
   https://www.infoq.com/news/2026/05/anthropic-routines-claude/) puts the default
   daily cap at **15 runs/account**; the docs do not state a fixed number ("See your
   current limits"). One-off runs are exempt from the daily cap but still bill
   subscription usage. Overage requires "usage credits".

6. **Observability ≠ success signal (critical).** "A green status in the run list
   means the session started and exited without an infrastructure error. **It does
   not mean the task in your prompt succeeded.** Open the run to read the transcript
   and confirm what Claude actually did. Blocked network requests, missing connector
   tools, and task-level failures all surface there rather than in the status
   indicator." Each run = a full session with a transcript URL; the session can read
   `CLAUDE_CODE_REMOTE_SESSION_ID` for traceable links.
   (https://code.claude.com/docs/en/routines, /claude-code-on-the-web).

7. **Hooks DO run in cloud sessions — if committed to the repo.** The cloud-config
   carry-over table (https://code.claude.com/docs/en/claude-code-on-the-web) lists:
   "Your repo's `.claude/settings.json` hooks → **Yes** → Part of the clone" and
   "Plugins declared in `.claude/settings.json` → **Yes** → Installed at session
   start from the marketplace". Constraint: "In the cloud, only hooks committed to
   the repo run" — user-level `~/.claude/settings.json` hooks/plugins do NOT carry
   over. Memory-managed terminations: "Tasks requiring significantly more memory …
   may fail or be terminated"; "Cloud sessions stop after a period of inactivity
   and the underlying environment is reclaimed."

8. **Network is default-deny.** "Default" environment = "Trusted" network access
   (package registries + cloud APIs + dev domains allow-listed); other hosts return
   `403 x-deny-reason: host_not_allowed`. MCP connector traffic is proxied through
   Anthropic's servers.

9. **`/loop` contrast (in-session cron).** "A session can hold up to 50 scheduled
   tasks at once." "Recurring tasks automatically expire 7 days after creation"
   (the doc says seven days, not three). `/loop` "Requires open session: Yes",
   minimum interval 1 minute, inherits the session's MCP servers and permission
   prompts. Routines minimum interval is 1 hour and require **no** open session.
   (https://code.claude.com/docs/en/scheduled-tasks).

## Our Code-State (verified)

**Kill-switches — the issue says "9"; the live constant table has 10.** This is a
versioning artifact, resolved here. `scripts/lib/autopilot/kill-switches.mjs:18-32`
`Object.freeze` enumerates **ten** identifiers:

| # | Constant | Value | Phase / Issue | Class |
|---|---|---|---|---|
| 1 | `MAX_SESSIONS_REACHED` | `max-sessions-reached` | C-1 #295 | pre-iteration |
| 2 | `MAX_HOURS_EXCEEDED` | `max-hours-exceeded` | C-1 #295 | pre-iteration |
| 3 | `RESOURCE_OVERLOAD` | `resource-overload` | C-1 #295 | pre-iteration |
| 4 | `LOW_CONFIDENCE_FALLBACK` | `low-confidence-fallback` | C-1 #295 | pre-iteration |
| 5 | `USER_ABORT` | `user-abort` | C-1 #295 | pre-iteration |
| 6 | `TOKEN_BUDGET_EXCEEDED` | `token-budget-exceeded` | #355 | pre-iteration |
| 7 | `STALL_TIMEOUT` | `stall-timeout` | C-2 / ADR-364 #371 | post-iteration |
| 8 | `SPIRAL` | `spiral` | C-1.b #300 | post-session |
| 9 | `FAILED_WAVE` | `failed-wave` | C-1.b #300 | post-session |
| 10 | `CARRYOVER_TOO_HIGH` | `carryover-too-high` | C-1.b #300 | post-session |

The "9" in issue #438 and `ADR-364:7,69` ("existing 9-switch convention") counts the
six pre-iteration + spiral + failed-wave + carryover **before** `STALL_TIMEOUT` was
promoted from scaffold to live (ADR-364 thin-slice item 3, `…remote-agent-substrate.md:69`,
shipped #371). `skills/autopilot/SKILL.md:20-25` still narrates "all 8 kill-switches"
(pre-TOKEN_BUDGET, pre-STALL) — that doc is stale vs. the code; the **runtime is the
SSOT** and enforces 10. Either count refutes "Routines have equivalent autonomy
guards" (see Gap Matrix).

- **Evaluators (pure functions).** `preIterationKillSwitch` (`kill-switches.mjs:54-94`)
  and `postSessionKillSwitch` (`kill-switches.mjs:118-174`) — no I/O; all inputs are
  state values. Driven by `runLoop` at `loop.mjs:176-193` (pre) and `loop.mjs:261-274`
  (post). STALL_TIMEOUT samples `autopilot.jsonl` mtime via `sampleProgress`
  (`kill-switches.mjs:127-137`); missing file → no kill (documented contract).
- **Spiral signal source.** `postSessionKillSwitch` reads `agent_summary.spiral`
  off the `sessionRunner` return shape (`kill-switches.mjs:141-147`). Spiral
  *detection itself* is wave-executor's (`skills/autopilot/SKILL.md:96,114`); autopilot
  only *consumes the count*. Convergence-monitoring (`skills/convergence-monitoring/SKILL.md`)
  is the prospective "are we making progress?" gate (3 signals → STOP/CONTINUE/
  INVESTIGATE, Phase 2 table lines 143-153) — distinct from the kill-switches and
  also local (reads `.orchestrator/metrics/events.jsonl`).
- **Telemetry.** `writeAutopilotJsonl` (`telemetry.mjs:74-86`) writes ONE atomic
  tmp+rename record per invocation to `.orchestrator/metrics/autopilot.jsonl`
  (schema_version 1; `kill_switch`, `kill_switch_detail`, `iterations_completed`,
  `sessions[]`, `host_class`, `stall_recovery_count`, `parent_run_id`,
  `worktree_path`; PRD schema `2026-04-25-autopilot-loop.md:97-115`). The file does
  **not yet exist** locally (verified: no `.orchestrator/metrics/autopilot.jsonl`) —
  autopilot has never run a real production loop here; it is a validated controller
  awaiting a driver.
- **Hooks (`hooks/hooks.json`).** PreToolUse (`enforce-scope`, `pre-bash-destructive-guard`,
  `enforce-commands`), PostToolUse (`post-edit-validate`), Stop/SubagentStop
  (`on-stop`, `subagent-telemetry`), PostToolBatch (`post-tool-batch-wave-signal`,
  `operator-steer`), SubagentStart, CwdChanged. These are the safety substrate the
  autonomy story leans on (destructive-guard = CLAUDE.md / AGENTS.md "Critical
  Gotchas"). Per External Finding 7 they **do** run in cloud sessions *iff* the
  plugin is declared in the cloned repo's `.claude/settings.json`.
- **session-end integration.** `skills/session-end/SKILL.md:344-358` Phase 3.7 writes
  `sessions.jsonl`; Phase 3.7a writes the 5 STATE.md Recommendation fields read by
  the next session-start. `skills/autopilot/SKILL.md:221-227`: each iteration's
  `sessions.jsonl` record MUST carry `autopilot_run_id`. This inter-session memory
  chain (STATE.md → sessions.jsonl → learnings) is what makes successive autopilot
  iterations coherent (`skills/autopilot/SKILL.md:217-219`).

## Feature Parity / Gap Matrix

| Capability (issue #438 row) | Our `/autopilot` (verified) | Routines (cited) | Verdict |
|---|---|---|---|
| Kill-switches | 10 enforced in `kill-switches.mjs:18-32` (issue's "9" = pre-STALL count) | **None documented.** "no permission-mode picker and no approval prompts during a run"; only bound = per-account daily run cap | **GAP — blocking for autonomy** |
| Spiral detection | `postSessionKillSwitch` consumes `agent_summary.spiral` (`kill-switches.mjs:141-147`); wave-executor detects | No equivalent. No stop-condition expression to feed a spiral signal into | **GAP — blocking** |
| Stop-condition we could feed spiral into (issue's "attractive if…") | n/a (ours is code) | **Not present** — searched routines + cloud-on-web docs; no halt-on-condition / max-turn / budget-expr surface | **GAP — the attractive case does not exist** |
| Cost transparency / billing | Local: free (own Claude session); `total_tokens_used` in JSONL; TOKEN_BUDGET_EXCEEDED switch | Draws subscription usage + daily run cap (~15/acct per 3rd-party); visible post-hoc at usage page; **no per-run pre-execution budget gate** | **PARTIAL — billed + visible, but no in-run cap** |
| Continues when laptop closed | **No** — `runLoop` dies with the chat session (`SKILL.md:218`) | **Yes** — "keep working when your laptop is closed" (the entire value prop) | **Routines WIN — the one decisive advantage** |
| Repo access | Local FS, full working tree, worktree isolation (`worktree.mjs`), unpushed commits visible | Fresh clone from default branch every run; `claude/`-prefixed branches; opt-in for other branches; no local uncommitted state | **GAP — loses unpushed/worktree state; acceptable for clean-branch work** |
| Debug-ability | `autopilot.jsonl` + `events.jsonl` + STATE.md + full local transcript | Per-run session + transcript URL; **green ≠ success** (must read transcript); no structured kill telemetry | **PARTIAL — transcript yes, structured telemetry no** |
| Compatibility with session-end | Native: Phase 3.7/3.7a wired; `autopilot_run_id` chain intact | Cloud session can run committed skills/hooks (Finding 7) → session-end *could* run, but `autopilot.jsonl` is local-FS-only and is lost on the ephemeral clone unless committed/pushed | **PARTIAL — runnable, telemetry persistence unsolved** |
| Hooks (destructive-guard etc.) | All `hooks/hooks.json` entries active | Repo-committed `.claude/settings.json` hooks + repo-declared plugins **run in cloud** (`claude-code-on-the-web` carry-over table) | **PARITY — if plugin declared in repo settings** |
| Concurrency / scale | `agents-per-wave` resource-adaptive cap; peer-count RESOURCE_OVERLOAD | Per-account daily run cap; GitHub webhook per-routine/per-account hourly caps | **DIFFERENT model — not directly comparable** |

**Net:** Routines win exactly one row — the laptop-closed durability that is
literally the gap `/autopilot` names. They **lose or only partially match every
autonomy-safety row**, and the single most attractive hypothetical from the issue
(a stop-condition expression to inject spiral-detection into) **does not exist** in
the documented surface (UNVERIFIED only in the sense that research-preview behavior
"may change" — but absent today).

## Empirical

N/A — docs-only per session-start AUQ. An empirical Routine spin-up (package this
repo as a cloud routine, observe whether `hooks/hooks.json` destructive-guard fires,
whether session-end writes survive the ephemeral clone, measure the daily-run-cap
ceiling against a multi-iteration loop) is deferred to a follow-up issue. The
research-preview disclaimer ("Behavior, limits, and the API surface may change")
makes any empirical numbers perishable; the W4 ADR should record the doc-state
snapshot date (2026-05-19) and gate adoption on a future empirical spike.

## Preliminary Recommendation

**Lean: Add-as-Option (Adapter)** — *not* Adopt, *not* a hard Skip.

Rationale: Routines solve the one problem our local loop cannot (laptop-closed
durability) but provide **zero** of the ten kill-switches, no spiral consumption,
and — decisively — **no stop-condition expression to feed spiral-detection into**,
which the issue named as the precondition for an attractive Adopt. Per
`.claude/rules/loop-and-monitor.md` LM-005, replacing `/autopilot` with an
unguarded scheduler "loses [the kill-switches]" — Routines are that unguarded
scheduler at the loop level. **Adopt is refuted.**

But a thin **Adapter** is viable and aligns with the existing LM-004 routing and
ADR-364's "adapt, don't replace" posture: keep `runLoop` + all 10 kill-switches as
the loop brain; add an opt-in path that packages a *single bounded session* (not a
multi-iteration loop) as a Routine — the kill-switch logic moves *inside the prompt
and the repo-committed hooks* (Finding 7 confirms our `hooks/hooks.json` runs in
cloud), and `autopilot.jsonl`/session-end writes are made durable by committing them
on a `claude/`-branch before the ephemeral clone is reclaimed. This gives walk-away
UX for the *routine-housekeeping* class (the exact LM-004 "overnight / cross-repo /
survives restart" cases) without surrendering the safety model for the autonomous
*loop*. The W4 ADR (`docs/adr/0003-routines-cloud-execution.md`) should formalize
this as **Decision: Adapter**, scope the adapter to one-session-per-fire (no
in-cloud iteration loop until a stop-condition primitive ships), and file the
empirical spin-up follow-up as a hard precondition before any production wiring.

STATUS: done — 232 lines, 4 sources, preliminary: Add-as-Option
