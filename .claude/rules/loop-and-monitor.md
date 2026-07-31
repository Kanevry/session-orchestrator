---
tier: coordinator-only
review-date: 2026-10-23
---

# Loop & Monitor Routing (Always-on)

`/goal`, `/loop`, `Monitor`, and `Routines` / Desktop scheduled tasks share
the "recurring, polling-style, or keep-going-until-done work" slot but are
**not interchangeable**. Picking the wrong primitive wastes tokens, masks
failures, or loses durability. This rule encodes the routing decision once so
future sessions do not re-derive it.

The load-bearing routing substance is LM-001..LM-008 below. The upstream
version-gate detail, the per-primitive constraint tables, the Crosswalk,
the full cadence table, and the 8 Delta-Sync re-verify footers live in
[`docs/adr/0010-native-autonomy-commands.md` § Upstream Reference and Delta-Sync Provenance](../../docs/adr/0010-native-autonomy-commands.md#upstream-reference-and-delta-sync-provenance).
Pull them up only when you need the exact version gate or constraint — the
routing decision itself never requires them.

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

> The Crosswalk mapping Anthropic's four generic loop archetypes to the repo
> primitive that implements each (with deployment states) is a cross-check on
> this tree, not a routing rule — it lives in the ADR reference section linked
> above.

## LM-002: Use Monitor When …

Use Monitor when the watched thing is a STREAM you can tail — a long-running
build/test suite emitting progress to stdout, a CI pipeline you poll-then-stream
(`glab ci status`, `gh pr checks --watch`), an accumulating error log
(`tail -f` + `grep --line-buffered`), a JSONL telemetry stream
(`tail -f .orchestrator/metrics/autopilot.jsonl | jq -r --line-buffered …`), or
a filesystem event (`inotifywait -m`). Each stdout line is one notification;
zero polling tokens.

**Coverage rule (load-bearing).** A Monitor filter must match every
terminal state, not just the happy path. *Silence is not success.*

```bash
# WRONG — silent on crash, hang, or any non-success exit
tail -f run.log | grep --line-buffered "elapsed_steps="

# RIGHT — alternation covers progress + every failure signature
tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"
```

If you cannot enumerate failure signatures, broaden the alternation rather than
narrow it. Some extra noise beats missing a crashloop.

Monitor's version gate (v2.1.98+), the Bedrock/Vertex/Foundry +
`DISABLE_TELEMETRY` unavailability fallback, and the v2.1.195+ WebSocket source
are in the ADR reference section. For vetted filter snippets, see
`skills/_shared/monitor-patterns.md`.

## LM-002a: Use Channels When …

Channels (research preview) is the **push-based sibling of Monitor**: an
external system pushes the event into your open session via an MCP channel
plugin (CI webhook, error tracker, chat) — zero polling, reacts while you are
away. Choose Channels over Monitor when the source can PUSH (you register a
webhook endpoint) rather than be TAILED (`tail -f` / `glab ci status`); when it
can only be polled or tailed, stay on Monitor. It is research-preview — do not
wire a load-bearing automation onto it without a Monitor/`/loop` fallback. Auth,
version, and org-gating constraints are in the ADR reference section.

## LM-002b: Use Workflows When …

Dynamic **Workflows** (`Workflow` tool) is the **one-shot fan-out** primitive —
distinct from every recurring/polling axis. Reach for it when a single objective
decomposes into many independent units one conversation cannot coordinate: a
codebase-wide audit, a large migration, a multi-angle research sweep. Claude
plans once, codifies a rerunnable script, fans out dozens-to-hundreds of
subagents, and returns only the final result. The bundled `/deep-research` is
the canonical example.

**Never reimplement a one-shot fan-out as `/loop`.** A `/loop` body re-runs a
single coordinator prompt on an interval; it has no native fan-out, no
agent-count cap, and no rerunnable-script artifact. If the work is genuinely
one-shot fan-out, use the `Workflow` tool.

**Distinct from Agent Teams.** Workflows' one-shot fan-out is unrelated to the
experimental `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` flag (off-by-default, in-run
multi-agent coordination within a single live session) — see
`parallel-sessions.md` § PSA Scope Axes and ADR-0002 / #484 for that boundary.

**Do not swap wave-executor for a bare Workflow.** The 16/1000 caps are
agent-count bounds, not the repo's ten kill-switches, and Workflows ship no
`autopilot.jsonl`-equivalent telemetry — verdict **Stay** (with Adapter-fallback
on non-Anthropic providers), RESOLVED 2026-06-20 (#665). The full caps list,
kill-switch/save-location/trigger constraints, and the reasoning live in
[ADR-0010 § Native-Overlap Refresh](../../docs/adr/0010-native-autonomy-commands.md#native-overlap-refresh--2026-06-20-665)
and the ADR reference section.

## LM-003: Use `/loop` When …

Use `/loop` when the check is genuinely periodic (no streamable trigger) and
bounded by THIS conversation — vault-staleness during a multi-hour deep session,
a top-priority backlog snapshot during long-running work, branch-tending while
waiting on review. Wire a custom maintenance loop into `.claude/loop.md`
(project) or `~/.claude/loop.md` (user). Scheduled tasks fire only while Claude
Code is running; unexpired tasks restore on `--resume`/`--continue`, and the
7-day expiry is the outer bound (`/background` keeps a session running without a
terminal). Use dynamic mode (self-paced via `ScheduleWakeup`) unless the cadence
is genuinely fixed.

**Cadence — pick by observation-rate, not by the cache.** Choose the interval
from how fast the watched thing changes: `60s`–`270s` when a state transition is
imminent, `300s`–`1200s` for steady-state polling, `1200s`–`3600s` for idle
maintenance. The runtime clamps a self-paced wakeup to **[60s, 3600s]**. The old
`300s`-cache-cliff trap now bites only under a 5-minute prompt-cache TTL
(API-key auth or subscription usage overage); the subscription main-conversation
defaults to a 1-hour TTL. The full cadence table + cache-TTL carve-outs are in
the ADR reference section.

**Limits & kill-switches (load-bearing).** `CLAUDE_CODE_DISABLE_CRON=1` disables
the cron scheduler AND `/loop` entirely — not just one task. Each session is
capped at **50 scheduled tasks**. Both `.claude/loop.md` and `~/.claude/loop.md`
are TRUNCATED past **25,000 bytes** — keep the loop body lean; a bloated body
silently loses its tail rather than erroring. The Skill-Dispatch-Gate,
scheduled-task prompt trust, off-minutes hygiene, and non-Anthropic provider
behaviour (bare `/loop` on a fixed 10-min schedule, skips `.claude/loop.md`) are
in the ADR reference section.

## LM-004: Use Routines / Desktop When …

Use Routines (cloud) or Desktop scheduled tasks when the work must run when no
session is open (overnight, weekly, monthly), spans repos no single session can
witness (cross-repo readiness watcher, baseline-MR drift), or must persist
across machine restarts (`/daily` rollover). `/loop` is the wrong tool here — it
fires only while Claude Code is running; `--resume`/`--continue` restoration is
not durable unattended scheduling.

**Repo posture: "teach it, don't run it."** This repo documents Routines
knowledge for when an operator needs it elsewhere but does not itself operate any
Routine (ADR-0003 SUPERSEDED, #485 won't-do). Routines' trigger types,
per-account daily cap, `claude/`-branch push guard, and availability constraints
are in the ADR reference section. See LM-004a for the `/schedule` CLI gate.

## LM-004a: `/schedule` Gating

`/schedule` is the CLI front-end to Routines (list/update/run scheduled cloud
agents). It requires a claude.ai subscription login and is invisible/disabled on
Console-API-key auth, Bedrock/Vertex/Foundry, or when telemetry is disabled — the
full gate list is in the ADR reference section. Subcommands: `/schedule list` ·
`/schedule update` · `/schedule run`.

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
until a stated completion condition is confirmed — a session-scoped,
prompt-based Stop hook where a small-fast evaluator (default Haiku) reads the
condition + conversation each turn and returns yes/no + reason. Cost is
typically negligible. Use it for a **finite objective** that needs multiple
turns to converge and whose done-condition is **demonstrable from Claude's own
surfaced output** — the evaluator runs NO tools, so surface the evidence (paste
the test summary, echo the worklist, print the state). Write conditions the
transcript can demonstrate ("all referenced tests show as passing in the output"
works; "the production database is consistent" does not). **Always embed a
bound** ("or stop after 20 turns / 30 minutes") so a non-converging goal
terminates.

**The load-bearing caveat — `/goal` provides CONTINUATION plus model-evaluated
JUDGMENT, never deterministic VERIFICATION.** The evaluator judges the condition
from the transcript; it does not run verification tools. Deterministic quality
gates remain the source of truth: `npm test`, `npm run typecheck`,
`npm run lint` and their **exit codes** decide whether work is correct. Never
replace an exit-code gate with a Haiku vote. The correct pattern is a goal whose
condition references freshly-run gate output ("…until `npm test` prints 0
failures **in this turn's output**"), backed by an actual gate run each turn —
not a goal that asserts success on its own.

The `/goal` aliases (`clear`/`stop`/`off`/`reset`), the `--resume`/`--continue`
restore semantics, the availability gates (`disableAllHooks` /
`allowManagedHooksOnly` / workspace trust), and Auto-mode pairing are in the ADR
reference section. See `docs/adr/0010-native-autonomy-commands.md` for the full
verdict on how `/goal` slots alongside `/loop`, Monitor, and Routines.

## See Also

- `parallel-sessions.md` (PSA discipline inside loop bodies; § PSA Scope Axes for the Agent Teams boundary — see LM-002b)
- `ask-via-tool.md` (loop bodies must still use AUQ for user decisions)
- `verification-before-completion.md` (why `/goal` never replaces an exit-code gate)
- `development.md` · `security.md` · `mvp-scope.md` · `cli-design.md`
- ADR: `docs/adr/0010-native-autonomy-commands.md` (full verdict + [§ Upstream Reference and Delta-Sync Provenance](../../docs/adr/0010-native-autonomy-commands.md#upstream-reference-and-delta-sync-provenance) — version gates, constraint tables, 8 Delta-Sync footers)
- Project file: `.claude/loop.md` (the orchestrator's bare-`/loop` body)
- Reference: `skills/_shared/monitor-patterns.md` (vetted Monitor filter snippets)
