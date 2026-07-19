---
tier: coordinator-only
---

# Loop & Monitor Routing (Always-on)

`/goal`, `/loop`, `Monitor`, and `Routines` / Desktop scheduled tasks share
the "recurring, polling-style, or keep-going-until-done work" slot but are
**not interchangeable**. Picking the wrong primitive wastes tokens, masks
failures, or loses durability. This rule encodes the routing decision once so
future sessions do not re-derive it.

## LM-001: Decision Tree — Pick the Primitive First

```
Is the work a FINITE objective with a recognizable done-condition that
Claude's OWN surfaced output can demonstrate (refactor until the tests
referenced in the transcript pass, drain a worklist, reach a state you
can describe in ≤ 4000 chars)?
│
├─ Yes → /goal.
│        Continuation across turns until the condition is model-evaluated.
│        (Completion-condition axis — see LM-008.)
│        Pair with deterministic gates — /goal judges; it never verifies.
│        NOT: "until CI goes green" — that is an EXTERNAL stream the
│        evaluator cannot see → Monitor (next branch).
│
└─ No  → Is this a ONE-SHOT fan-out across many independent units (codebase-
         wide audit, 500-file migration, multi-angle cross-checked research)
         needing dozens-to-hundreds of subagents one conversation cannot
         coordinate?
         │
         ├─ Yes → dynamic Workflow (`Workflow` tool / /en/workflows, v2.1.154+).
         │        Codifies the plan as a rerunnable script; the main context
         │        holds only the final result, not the per-agent chatter.
         │        NOT a recurring primitive — for repeated polling stay on the
         │        axes below. (Fan-out axis — see LM-002b.)
         │
         └─ No  → Is the event PUSHABLE from an external system (CI webhook, error
                  tracker, chat)?
                  │
                  ├─ Yes → Channels (research preview, v2.1.80+).
                  │        The source pushes the event into the open session via an
                  │        MCP channel plugin — zero polling, reacts while you're away.
                  │        (Push-based sibling of Monitor — see LM-002a.)
                  │
                  └─ No  → Is the watched thing a STREAM I can tail (logs, file changes, CI
                           status transitions, autopilot.jsonl entries)?
                           │
                           ├─ Yes → Monitor.
                           │        Each stdout line = one notification. Zero polling tokens.
                           │
                           └─ No  → Is the watched thing PERIODIC and bounded by THIS conversation
                                    (≤ 7 days, resume/continue restoration acceptable)?
                                    │
                                    ├─ Yes → /loop.
                                    │        Use dynamic mode unless the cadence is genuinely fixed.
                                    │
                                    └─ No  → Routines (cloud) or Desktop scheduled tasks.
                                             Daily notes, weekly audits, cross-repo sweeps.
                                             /loop CANNOT cover these — it fires only while Claude Code runs.
```

### Crosswalk — Anthropic's four loop archetypes

Anthropic's "designing loops" framing describes four generic loop shapes.
This table maps each to the repo primitive that implements it and its
current deployment state (config-key-driven wherever a knob exists) — read
it as a cross-check on the Decision Tree above, not a replacement for it.

| Article loop type | Repo primitive | Deployment state |
|---|---|---|
| **Turn-based loop** | wave-executor inter-wave loop + `/goal` (LM-008) | wave-executor always-on; `/goal` opt-in via `goal-integration.enabled` (Session Config) |
| **Goal-based loop** | `/goal` (LM-008) | opt-in — `goal-integration.enabled` + `goal-integration.seams` (Session Config) |
| **Time-based loop** | `/loop` (LM-003) + Routines / `/schedule` (LM-004 / LM-004a) | `/loop` — `.claude/loop.md` present at repo root; Routines — off by design, "teach it, don't run it" (see LM-004 posture) |
| **Proactive / event loop** | Monitor (LM-002) + Channels (LM-002a) | Monitor — ad hoc, no persistent config; Channels — research preview, `--channels` opt-in per session |

## LM-002: Use Monitor When …

- A long-running build or test suite emits progress to stdout
  (e.g. `npm test` with ≥ 2700 tests).
- A CI pipeline transitions through states you can poll-then-stream
  (`glab ci status`, `gh pr checks --watch`).
- A log file accumulates errors you want to surface as they appear
  (`tail -f` + `grep --line-buffered`).
- A JSONL telemetry stream needs a live read-out
  (`tail -f .orchestrator/metrics/autopilot.jsonl | jq -r --line-buffered …`).
- A file system event drives downstream action (`inotifywait -m`).

**Coverage rule (load-bearing).** A Monitor filter must match every
terminal state, not just the happy path. *Silence is not success.*

```bash
# WRONG — silent on crash, hang, or any non-success exit
tail -f run.log | grep --line-buffered "elapsed_steps="

# RIGHT — alternation covers progress + every failure signature
tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"
```

If you cannot enumerate failure signatures, broaden the alternation
rather than narrow it. Some extra noise beats missing a crashloop.

Monitor requires v2.1.98+ and is unavailable on Bedrock/Vertex/Foundry and
when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set
— on those configs fall back to a bounded `/loop` poll
(code.claude.com/docs/en/tools-reference#monitor-tool).

**WebSocket source (v2.1.195+).** Monitor also accepts a `ws://`/`wss://`
source directly. Each complete text message is one event; a binary message
emits a placeholder event; a message larger than 1 MiB ends the watch. This
needs no polling script and avoids the `grep --line-buffered` pitfall. Prefer
it over a `command` source whenever the upstream already speaks WebSocket;
keep `command` (tail/grep) when messages still need shell-side filtering
before they're notification-worthy.

For vetted snippets, see `skills/_shared/monitor-patterns.md`.

## LM-002a: Use Channels When …

Channels (research preview, v2.1.80+) is the **push-based sibling of Monitor**:
instead of tailing a stream you control, an external system pushes the event
into your open session via an MCP channel plugin (CI webhook, error tracker,
chat). Zero polling, and it reacts while you are away from the keyboard.

Constraints (cite https://code.claude.com/docs/en/channels):

- **Auth:** claude.ai authentication or a Claude Console API key; unavailable
  on Bedrock, Google Cloud Agent Platform, or Microsoft Foundry.
- **Per-session opt-in** via the `--channels` flag.
- **Org-gated on Team/Enterprise** — the org owner must additionally turn on
  `channelsEnabled` (a master switch) before any member can use Channels; on
  Pro/Max without an org, Channels is directly available with no extra toggle.
- **Research-preview status** — the contract may change; do not wire a
  load-bearing automation onto it without a Monitor/`/loop` fallback.

Choose Channels over Monitor when the source can PUSH (you register a webhook
endpoint) rather than be TAILED (you run `tail -f`/`glab ci status`). When the
source can only be polled or tailed, stay on Monitor.

## LM-002b: Use Workflows When …

Dynamic **Workflows** (`Workflow` tool, v2.1.154+; full doc at
https://code.claude.com/docs/en/workflows) is the **one-shot fan-out**
primitive — distinct from every recurring/polling axis above. Reach for it when
a single objective decomposes into **many independent units** that one
conversation cannot coordinate without drowning its own context: a codebase-
wide audit, a 500-file migration, a multi-angle cross-checked research sweep.
Claude plans the work once, codifies it as a **rerunnable script**, fans out
**dozens-to-hundreds of subagents**, and returns only the final result to the
main context. The bundled `/deep-research` is the canonical example.

Constraints (cite https://code.claude.com/docs/en/workflows):

- **Caps:** **16 concurrent** / **1000 total** agents per run — agent-count bounds, not stop-conditions.
- **Kill-switch:** `disableWorkflows` (settings), `CLAUDE_CODE_DISABLE_WORKFLOWS=1` (env), or the `/config` toggle.
- **Provider availability:** runs on Bedrock/Vertex/Foundry as well as Anthropic-auth.
- **Save location:** `.claude/workflows/` (project) or `~/.claude/workflows/` (user; project wins). **Monorepo nuance (v2.1.178+):** a project-level save writes to the NEXT already-existing `.claude/workflows/` directory found walking up from CWD toward repo root, falling back to the repo root only if none exists yet along that path. Project workflows load from every `.claude/workflows/` on that path; if two define the same name, the one closest to the working directory runs (and if a project and a personal workflow share a name, the project one wins). Verify the actual write target before assuming root-level placement in a monorepo.
- **Creation/trigger:** ask Claude in natural language to create or run a Workflow; use the eligible human-origin literal `ultracode` (pre-v2.1.160 this keyword was `workflow`); select `/effort ultracode`; or launch with `claude --effort ultracode` (v2.1.203+). `/workflows` only lists and manages Workflow runs — it does not create one.
- **Keyword scope (v2.1.210+).** The inline `ultracode` keyword only opts in from human-typed input — the interactive prompt, an IDE panel, a Remote Control client, or an Agent SDK call stamped `origin: { kind: "human" }`. It does NOT trigger from a `-p` prompt, an unstamped Agent SDK call, **a scheduled task prompt** (relevant to `.claude/loop.md` fires — LM-003), or a webhook payload / relayed PR comment. Before v2.1.210 it fired from all of those routes too — do not assume a scheduled `/loop` body containing the literal word "ultracode" spawns a Workflow on current versions (code.claude.com/docs/en/workflows § Where the keyword works).
- **Dynamic workflow size (v2.1.202+):** a `/config` setting — `unrestricted` / `small` / `medium` / `large` — controls the agent count Claude targets when planning a run. Tune it down for a tighter/cheaper fan-out, up when the objective genuinely needs the full 16/1000 headroom.
- **`args` global:** a workflow script receives its parameters via the structured-data global `args` — `undefined` when the workflow is invoked without any parameters passed.
- **Usage view:** `/workflows` exposes a per-phase breakdown of agent counts and token totals, with per-run controls keyed `p` (pause/resume) / `x` (stop) / `r` (restart) / `s` (save); only the `f` status filter carries an explicit version gate (v2.1.186+) — use the view to see where a run spent its budget before re-tuning the script.
- **Per-stage model routing:** the `agent()` call in a workflow script accepts `model`/`effort` options, so different stages of the same run can route to different models/effort levels rather than one model for the whole workflow.
- **Resume (`resumeFromRunId`) is same-session only** — it cannot resume a run that was started in a different session.

**Workflows vs wave-executor + `autopilot-multi`:** the 16/1000 caps are agent-count bounds, not the repo's ten kill-switches (`scripts/lib/autopilot/kill-switches.mjs`). Since v2.1.202, workflow-spawned agents emit OTel attributes `workflow.run_id` + `workflow.name`, and since v2.1.203 the progress line surfaces an advisory `Large workflow` warning once a run exceeds 25 planned agents OR 1.5M projected tokens — but neither closes the #665 gap: there is still no `autopilot.jsonl`-equivalent telemetry sink, no ten kill-switches, and the warning is advisory/non-blocking, not a gate. **RESOLVED 2026-06-20 (#665) → Stay (with Adapter-fallback)** — see ADR-0010 § Native-Overlap Refresh; do not swap wave-executor for a bare Workflow on the assumption the caps (or the new OTel/warning signals) substitute for the kill-switches.

**Never reimplement a one-shot fan-out as `/loop`.** A `/loop` body re-runs a
single coordinator prompt on an interval; it has no native fan-out, no agent-
count cap, and no rerunnable-script artifact. If the work is genuinely one-shot
fan-out, use the `Workflow` tool; `/loop` is for the periodic, in-session axis below.

**Distinct from Agent Teams.** Workflows' one-shot fan-out is unrelated to the
experimental `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` flag (off-by-default,
in-run multi-agent coordination within a single live session) — see
`parallel-sessions.md` § PSA Scope Axes and ADR-0002 / #484 for that boundary.

## LM-003: Use `/loop` When … (requires v2.1.71+)

Scheduled tasks (the `/loop` and Cron family as a whole) need **v2.1.71+** —
cite this as the base gate before any of the finer-grained version gates below
(code.claude.com/docs/en/scheduled-tasks).

- The check is genuinely periodic (no streamable trigger): vault-staleness
  during a multi-hour deep session, top-priority backlog snapshot during
  long-running work, branch-tending while waiting on review.
- Scheduled tasks fire only while Claude Code is running. Unexpired tasks
  restore when the conversation is reopened with `claude --resume` or
  `claude --continue`; the 7-day expiry remains the outer bound. Backgrounding
  the session (`/background`) keeps it running without a terminal attached
  (code.claude.com/docs/en/scheduled-tasks#limitations).
- A custom maintenance loop is wanted at session-start — wire it into
  `.claude/loop.md` (project) or `~/.claude/loop.md` (user).

`/proactive` was historically documented as a `/loop` alias — upstream no
longer documents it as of this re-verify (2026-07-02); treat `/loop` as the
sole canonical form. Dynamic mode self-paces via the `ScheduleWakeup` tool
(1 min–1 h); the pending wakeup surfaces in `session_crons` in the Stop-hook
input (code.claude.com/docs/en/tools-reference#schedulewakeup). Since
v2.1.202, a self-paced `/loop` can cleanly end itself by calling
`ScheduleWakeup` with `stop: true`, which cancels the pending wakeup
immediately. If an iteration ends without either a reschedule or `stop: true`,
Claude Code plans one fallback wakeup ~20 minutes later and then ends the loop
(before v2.1.202, not rescheduling was the only self-termination path)
(code.claude.com/docs/en/scheduled-tasks#stop-a-loop).

**Scheduled-task prompt trust (v2.1.214).** When a scheduled task fires, its
configured prompt becomes Claude's assigned task. That trust applies to task
assignment only: it does not bypass the skill invocation controls below, and
it does not make the prompt human-origin for Workflows' literal `ultracode`
trigger (LM-002b).

**Skill-Dispatch-Gate (v2.1.196+).** A scheduled fire only EXECUTES skills
that Claude itself is permitted to invoke. References to built-in commands
(`/permissions`, `/model`, `/clear`), skills declared
`disable-model-invocation: true`, skills withheld via `skillOverrides` or a
`Skill` deny rule, and MCP prompts remain plain text and do not invoke those
commands or skills. Practical corollary: the `.claude/loop.md` body must only
INSTRUCT the fire to invoke model-invokable skills — a reference to a built-in
command or a non-invokable skill as something the run itself should execute
silently no-ops. Recommending such a command to the **operator** ("consider
running `/permissions`") is still fine — that is prose read by a human, not a
dispatch attempted by the run (code.claude.com/docs/en/scheduled-tasks).

**Cadence selection — pick by observation-rate; cache is secondary.** Choose the
interval from *how fast the watched thing changes*, then sanity-check against
the cache TTL. The runtime clamps a self-paced wakeup to **[60s, 3600s]**
(code.claude.com/docs/en/scheduled-tasks; /docs/en/tools-reference#schedulewakeup).

| Range | When (by observation-rate) |
|---|---|
| `60s` – `270s` | The watched thing is changing now or imminently — a build finishing, a PR actively churning, a state transition about to land. Catch it on the next tick. |
| `300s` – `~1200s` | Steady-state polling where a few-minutes-stale read is fine — mid-session backlog snapshot, inter-wave re-check. |
| `1200s` – `3600s` (20 – 60 min) | Idle ticks / maintenance loops — vault-staleness re-banner, branch-tending while waiting on review. Nothing is expected to change fast. |
| `> 3600s` | Out of range — `/loop` clamps self-paced wakeups to ≤ 1 h, and the 7-day expiry is the ceiling, not the design point. Use `/schedule` or Routines. |

**Cache TTL is a secondary factor, and no longer a `300s` cliff by default.** On
a Claude subscription, Claude Code's **main conversation** — where a `/loop`
body runs — requests the **1-hour** prompt-cache TTL automatically at no extra
cost. Delays below 3600s remain inside that nominal TTL; **3600s exactly is the
boundary and must not be assumed to produce a cache hit**
(code.claude.com/docs/en/prompt-caching § Cache lifetime). Two carve-outs
re-introduce the 5-minute TTL and with it the classic `300s` worst-of-both
trap: **(1)** usage overage (drawing on usage credits drops the TTL to five
minutes); **(2)** API-key / Bedrock / Vertex / Foundry / AWS auth (5 min unless
`ENABLE_PROMPT_CACHING_1H=1`). `FORCE_PROMPT_CACHING_5M=1` forces 5 min
regardless of auth. **Under a 5-minute TTL the old rule still holds:** stay
under ~270s to keep the cache warm, avoid ~300s (you pay the miss without
amortising it), or commit to 1200s+ so one miss buys a long wait. Upstream
itself prescribes no cadence numbers — the breakpoints above are repo-internal
best practice; the cache-driven ones bind only under a 5-minute-TTL config.
(The automatic 1-hour TTL is main-conversation-only; dispatched subagents
always use the 5-minute TTL — irrelevant to `/loop`, but do not carry this
reasoning into subagent fan-out.)

**Off-minutes hygiene.** Cron jitter penalises `:00` and `:30` for one-shots
(fire up to 90 s early). For recurring jobs, prefer minutes other than 0/30:
`3 9 * * *` not `0 9 * * *`. Honours the same fleet-spread argument as
`CronCreate`'s built-in guidance.

**Non-Anthropic providers (Bedrock/Vertex/Foundry).** Mirrors the Monitor
unavailability noted above (LM-002): a prompt-only `/loop <prompt>` (no
interval) runs on a fixed 10-minute schedule there instead of self-pacing via
`ScheduleWakeup`; a **truly bare `/loop` (no prompt) just prints the usage
message** — the maintenance prompt does not run and neither `.claude/loop.md`
nor `~/.claude/loop.md` is read. Always pass an explicit interval on these
providers — do not rely on the project loop body.

**Limits & kill-switches.** `CLAUDE_CODE_DISABLE_CRON=1` is the total
kill-switch — it disables the cron scheduler AND `/loop` entirely, not just
one task. Each session is capped at **50 scheduled tasks**. Both
`.claude/loop.md` (project) and `~/.claude/loop.md` (user) are TRUNCATED by
upstream past **25,000 bytes** — whichever file is actually loaded for the
fire, not the other. Keep the loop body lean; a bloated body silently loses
its tail rather than erroring.

## LM-004: Use Routines / Desktop When …

- The work must run when no session is open (overnight, weekly, monthly).
- The work spans repos in a way that no single session can witness
  (cross-repo readiness watcher, baseline-MR drift detection).
- The artefact must persist across machine restarts (`/daily` rollover).

`/loop` is the wrong tool here — it fires only while Claude Code is running.
Unexpired tasks can restore on `--resume`/`--continue`, but this is not durable
unattended scheduling.

**Routines (research preview)** run in Anthropic's cloud, not on the local
host — this requires a claude.ai account (Pro/Max/Team/Enterprise) and
Claude Code on the web; Console-API-key-only setups cannot use them. Three
trigger types: **(a) Scheduled** (cron-style, minimum 1h interval per run),
**(b) API-trigger** via `/fire` with beta header
`experimental-cc-routine-2026-04-01`, **(c) GitHub events**
(`pull_request.*`, `release.*`). A **daily run cap** applies per ACCOUNT, not
per Routine (one-off manual runs are exempt from the cap)
(code.claude.com/docs/en/routines § Usage and limits). Routines push, by
default, only to `claude/`-prefixed branches (branch-safety guard;
per-repository overridable via **Allow unrestricted branch pushes**) and can
be disabled org-wide via an org-level toggle.

**Repo posture: "teach it, don't run it."** ADR-0003 remains SUPERSEDED and
#485 remains won't-do — this repo documents Routines knowledge for when an
operator needs it elsewhere, but does not itself operate any Routine. See
LM-004a for the `/schedule` CLI gate.

## LM-004a: `/schedule` Gating

`/schedule` is the CLI front-end to Routines (list/update/run scheduled
cloud agents). It requires **CLI v2.1.81+** AND a claude.ai subscription
login — it is invisible/disabled on Console-API-key auth, on
Bedrock/Vertex/Foundry, or when any of these are set: `DISABLE_TELEMETRY`,
`DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
`DISABLE_GROWTHBOOK`. Subcommands: `/schedule list` · `/schedule update` ·
`/schedule run`.

## LM-005: Never Reimplement These as `/loop`

- **`/autopilot`.** It is already a child-process driver with ten
  kill-switches and `autopilot.jsonl` telemetry. Wrapping it in `/loop`
  loses both. Pair them — never replace.
- **Wave-executor inter-wave checkpoints.** Synchronous by design.
- **Quality gates** (`npm test`, `npm run typecheck`, `npm run lint`).
  These block the wave on purpose. Run them once, sequentially.
- **Hook-served events.** `PostToolUse`, `Stop`, `SubagentStop` already
  fire at the right moment. A `/loop` poll on top is redundant.
- **`/goal`.** Do not hand-roll a per-turn Stop-hook prompt evaluator to
  keep Claude working until a condition holds — `/goal` IS that mechanism,
  natively (a session-scoped prompt-based Stop hook). Re-implementing it as
  a custom Stop hook or a `/loop` body duplicates the machinery and loses
  the built-in `--resume` restoration and `/goal clear` lifecycle. See LM-008.
- **One-shot subagent fan-out.** A codebase-wide audit / large migration /
  multi-angle research sweep is a dynamic Workflow, not a `/loop` — `/loop`
  has no native fan-out, no agent-count cap, and no rerunnable-script artifact.
  See LM-002b.

## LM-006: PSA-003 Applies

A `/loop` body is a coordinator prompt that runs every iteration. Treat
it as you would any coordinator action:

- **No destructive operations** (`git push`, `git reset`, `rm`,
  `glab mr merge`, `glab issue close`) without explicit transcript
  authorisation for the specific action.
- **Track your footprint.** A loop that "tidies up" untracked files may
  delete another session's work-in-progress. See `parallel-sessions.md`.
- **Read-only first.** When in doubt, observe and report.

## LM-007: Anti-Patterns

- Fixed `/loop 5m …` to babysit a CI run — use Monitor on `glab ci status` or `gh pr checks --watch` instead (LM-002).
- `/loop 1d …` for a daily note — use Routines or Desktop tasks; `/loop` does not fire while Claude Code is stopped (LM-004).
- Monitor filter matching only the success marker — silence from a crash is indistinguishable from success (LM-002 coverage rule).
- `/loop` wrapping `/autopilot` — duplicates loop semantics and hides the kill-switches (LM-005).
- Cadence at `300s` **under a 5-minute cache TTL** (API-key auth, or a subscription in usage overage) — you pay the cache miss without amortising it; pick `270s` or `1200s+`. Moot under the 1-hour subscription default, where cadence follows the observation-rate, not the cache (LM-003).
- Using `/goal` as a quality gate — the evaluator reads the transcript only; pair `/goal` with a deterministic exit-code gate (LM-008).
- Unbounded `/goal` with no turn/time-bound clause — always embed "or stop after N turns / M minutes" (LM-008).
- Hand-rolling a one-shot fan-out as a `/loop` body — use the `Workflow` tool (LM-002b).
- Swapping wave-executor for a bare Workflow assuming its 16/1000 caps replace the ten kill-switches — they don't; verdict: Stay, RESOLVED 2026-06-20 #665 (LM-002b).

## LM-008: Use `/goal` When …

`/goal <condition>` (Claude Code v2.1.139+) keeps Claude working across turns
until a stated completion condition is confirmed. It is a wrapper around a
session-scoped, prompt-based Stop hook: after each turn the configured
small-fast evaluator model (default Haiku) reads the condition plus the
conversation and returns yes/no + reason. Cost is typically negligible. See
https://code.claude.com/docs/en/goal.

**Use `/goal` when:**
- The work is a **finite objective**, not an open-ended watch — "refactor
  `foo.ts` until the tests referenced in this transcript pass", "drain the
  worklist of 12 TODO items", "reach a state where every probe reports green".
- It needs **multiple turns** to converge but the operator should not have to
  re-prompt "keep going" after each one.
- The done-condition is **demonstrable from Claude's own surfaced output** —
  the evaluator runs NO tools, so it can only judge what already appears in
  the conversation. Make the work surface its evidence (paste the test
  summary, echo the worklist, print the state) so the evaluator can see it.

**How to write the condition:**
- Write conditions the transcript can demonstrate. "All referenced tests show
  as passing in the conversation output" works; "the production database is
  consistent" does not — the evaluator cannot inspect anything Claude has not
  already surfaced.
- **Always embed a bound.** Append "or stop after 20 turns" / "or stop after
  30 minutes" so a non-converging goal terminates. 4000-char condition limit;
  one goal per session; `/goal clear` removes it; restored on `--resume`;
  works headless (`claude -p "/goal …"`).
- **`/goal` with no arguments is introspection**, not a new goal — it prints
  the current goal's turns-elapsed and token-spend against the goal's
  baseline. `/goal stop`, `/goal off`, `/goal reset`, `/goal none`,
  `/goal cancel`, and a bare `/clear` are all aliases that remove the active
  goal (same effect as `/goal clear`). Restore is not limited to `--resume` —
  `--continue` restores the goal too, and doing so RESETS the turn/timer/token
  baseline the evaluator measures against.

**The load-bearing caveat — `/goal` provides CONTINUATION plus model-evaluated
JUDGMENT, never deterministic VERIFICATION.** The evaluator judges the
condition from the transcript; it does not run verification tools.
Deterministic quality gates remain the source of truth: `npm test`,
`npm run typecheck`, `npm run lint` and their **exit codes** decide whether
work is correct. Never replace an exit-code gate with a Haiku vote. The two
compose cleanly: `/goal` keeps the loop alive and judges surfaced evidence,
while the gate authoritatively verifies whether the work is done. The correct
pattern is a goal whose condition references freshly-run gate output ("…until
`npm test` prints 0 failures **in this turn's output**"), backed by an actual
gate run each turn — not a goal that asserts success on its own.

**Availability constraints:** requires Claude Code v2.1.139+; one active goal
per session; UNAVAILABLE when `disableAllHooks` or `allowManagedHooksOnly` is
set (the mechanism is a managed Stop hook). `/goal` is also gated by
workspace trust — an untrusted workspace makes `/goal` unavailable regardless
of the flags above. Surfaces: CLI, the Desktop app, and Remote Control
sessions all support `/goal` (not CLI-only). When unavailable, fall back to a
bounded `/loop` body that re-runs the deterministic gate and reports.

**Pairing with Auto mode (unattended runs).** For an unattended `/goal` that
must run each turn without per-tool approval prompts, pair it with Auto mode —
Auto mode removes per-tool prompts, `/goal` removes per-turn prompts; they
compose (https://code.claude.com/docs/en/goal).

See `docs/adr/0010-native-autonomy-commands.md` for the full verdict on how
`/goal` slots alongside `/loop`, Monitor, and Routines in the orchestrator.

## See Also

- `parallel-sessions.md` (PSA discipline that applies inside loop bodies; § PSA Scope Axes for the Agent Teams boundary — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, see LM-002b)
- `ask-via-tool.md` (loop bodies must still use AUQ for user decisions)
- `development.md` · `security.md` · `mvp-scope.md` · `cli-design.md`
- `verification-before-completion.md` (why `/goal` never replaces an exit-code gate)
- ADR: `docs/adr/0010-native-autonomy-commands.md` (full `/goal` vs `/loop` vs Monitor vs Routines verdict; Workflows watch-item FIRED 2026-06-12; RESOLVED → Stay 2026-06-20 (#665))
- Project file: `.claude/loop.md` (the orchestrator's bare-`/loop` body)
- Reference: `skills/_shared/monitor-patterns.md` (vetted Monitor filter snippets)
- Upstream: https://code.claude.com/docs/en/workflows (dynamic Workflows — LM-002b fan-out axis)

---

_Re-verified 2026-07-09 (Delta-Sync v2.1.197→v2.1.205: ScheduleWakeup stop:true, Workflows-OTel/Large-warning, workflow-size/effort-Flag, Channels-org-gate, /background-carryover; Routines-Seite re-verifiziert)._
_Re-verified 2026-07-10 (Delta-Sync v2.1.205→v2.1.206: zero functional delta — 2.1.206 touches /cd, /doctor, /commit-push-pr, gateway-login, EnterWorktree, MCP/model/agents-view fixes only; no /loop, scheduled-tasks, ScheduleWakeup, /goal, Workflows, Monitor, or Channels change)._

_Re-verified 2026-07-12 (Delta-Sync v2.1.206→v2.1.207: zero functional delta for the /loop family — 2.1.207 touches Auto-mode Bedrock/Vertex/Foundry opt-in default, terminal rendering, worktree config, agent-teams mailbox crash-loop, Remote-Control status sync, Deep-research chip labeling, Bedrock SSO refresh, plugin `${user_config.*}` shell-injection fix, `/usage-credits` validation only; no LM-001…LM-008 claim changed. Full doc re-verify surfaced 3 pre-existing gaps fixed this round: LM-003 Skill-Dispatch-Gate `Skill` deny rule, LM-002b monorepo-nuance load-order, LM-002b usage-view version-gate precision. Routines/`/schedule` not re-verified this round; last check 2026-07-09)._

_Re-verified 2026-07-12 (LM-003 cadence re-derivation: Claude Code subscription main-conversation uses the 1-hour prompt-cache TTL automatically — code.claude.com/docs/en/prompt-caching; the 300s trap now bites only under 5-min-TTL configs (usage overage / API-key / FORCE_PROMPT_CACHING_5M). Cadence = f(observation-rate), cache secondary. Subagents always 5-min TTL)._

_Re-verified 2026-07-16 (Delta-Sync v2.1.207→v2.1.211 via ref-MCP: 2 Deltas — LM-002b ultracode-keyword human-origin-only scope (v2.1.210, new bullet added); LM-004 Routines daily-cap corrected per-Routine→per-ACCOUNT + branch-push default framing (live-docs mismatch predating this window, drive-by fix). All other LM-001…LM-008 claims zero-delta incl. Monitor/WS, Channels, Workflows caps/kill-switches, ScheduleWakeup stop:true, Skill-Dispatch-Gate, 1h-TTL cadence, /goal clauses, /schedule gating)._

_Re-verified 2026-07-17 (Delta-Sync v2.1.211→v2.1.212 via WebFetch full-doc sweep: **zero functional delta** for the /loop family — 2.1.212 touches /fork background-session transformation, WebSearch limits, and subagent spawning limits only. All LM-001…LM-008 areas re-verified MATCH incl. Monitor/WS, Channels org-gate, Workflows 16/1000-caps + ultracode human-origin scope, ScheduleWakeup [60s,3600s] + stop:true, Skill-Dispatch-Gate, 1h-TTL cadence + 5-min carve-outs, /goal clauses + availability gates, Routines per-account cap + claude/-branch guard. LM-004a note: the /schedule v2.1.81+ version gate is no longer restated in current docs — historical claim, kept unchanged)._

_Re-verified 2026-07-18 (Delta-Sync v2.1.212→v2.1.214 via official release notes + scheduled-tasks/tools/goal/channels/workflows/prompt-caching docs: one relevant scheduled-task fix — a fired prompt becomes the assigned task — and **zero contract delta elsewhere**)._
