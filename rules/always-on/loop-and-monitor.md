<!-- source: session-orchestrator plugin (canonical: rules/always-on/loop-and-monitor.md) -->
# Loop & Monitor Routing (Always-on)

`/goal`, `/loop`, `Monitor`, `Workflow`, Channels, and cloud Routines /
scheduled desktop tasks share the "recurring, polling-style, or keep-going-
until-done work" slot but are **not interchangeable**. Picking the wrong
primitive wastes tokens, masks failures, or loses durability. This rule
encodes the routing decision once so future sessions do not re-derive it.

Version gates move; the routing does not. Check the primitive's availability in
your harness before wiring anything load-bearing onto it, and keep a fallback.

## LM-001: Decision Tree — Pick the Primitive First

```
Is the work a FINITE objective with a recognizable done-condition that
the model's OWN surfaced output can demonstrate (refactor until the tests
referenced in the transcript pass, drain a worklist, reach a state you
can describe in a few thousand characters)?
│
├─ Yes → /goal.
│        Continuation across turns until the condition is model-evaluated.
│        (Completion-condition axis — see LM-008.)
│        Pair with deterministic gates — /goal judges; it never verifies.
│        NOT: "until CI goes green" — that is an EXTERNAL stream the
│        evaluator cannot see → Monitor (next branch).
│
└─ No  → Is this a ONE-SHOT fan-out across many independent units (codebase-
         wide audit, large migration, multi-angle cross-checked research)
         needing dozens-to-hundreds of subagents one conversation cannot
         coordinate?
         │
         ├─ Yes → dynamic Workflow.
         │        Codifies the plan as a rerunnable script; the main context
         │        holds only the final result, not the per-agent chatter.
         │        NOT a recurring primitive — for repeated polling stay on the
         │        axes below. (Fan-out axis — see LM-002b.)
         │
         └─ No  → Is the event PUSHABLE from an external system (CI webhook,
                  error tracker, chat)?
                  │
                  ├─ Yes → Channels.
                  │        The source pushes the event into the open session via
                  │        a channel plugin — zero polling, reacts while you're
                  │        away. (Push-based sibling of Monitor — see LM-002a.)
                  │
                  └─ No  → Is the watched thing a STREAM I can tail (logs, file
                           changes, CI status transitions, a JSONL telemetry
                           file)?
                           │
                           ├─ Yes → Monitor.
                           │        Each stdout line = one notification. Zero
                           │        polling tokens.
                           │
                           └─ No  → Is the watched thing PERIODIC and bounded by
                                    THIS conversation (days, not weeks;
                                    resume/continue restoration acceptable)?
                                    │
                                    ├─ Yes → /loop.
                                    │        Use dynamic mode unless the cadence
                                    │        is genuinely fixed.
                                    │
                                    └─ No  → Cloud Routines or desktop scheduled
                                             tasks. Daily notes, weekly audits,
                                             cross-repo sweeps. /loop CANNOT
                                             cover these — it fires only while
                                             the agent runtime is running.
```

## LM-002: Use Monitor When …

Use Monitor when the watched thing is a STREAM you can tail — a long-running
build/test suite emitting progress to stdout, a CI pipeline you poll-then-stream
(`glab ci status`, `gh pr checks --watch`), an accumulating error log
(`tail -f` + `grep --line-buffered`), a JSONL telemetry stream, or a filesystem
event (`inotifywait -m`). Each stdout line is one notification; zero polling
tokens.

**Coverage rule (load-bearing).** A Monitor filter must match every terminal
state, not just the happy path. *Silence is not success.*

```bash
# WRONG — silent on crash, hang, or any non-success exit
tail -f run.log | grep --line-buffered "elapsed_steps="

# RIGHT — alternation covers progress + every failure signature
tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"
```

If you cannot enumerate failure signatures, broaden the alternation rather than
narrow it. Some extra noise beats missing a crashloop.

## LM-002a: Use Channels When …

Channels is the **push-based sibling of Monitor**: an external system pushes the
event into your open session via a channel plugin (CI webhook, error tracker,
chat) — zero polling, reacts while you are away. Choose Channels over Monitor
when the source can PUSH (you register a webhook endpoint) rather than be TAILED
(`tail -f` / `glab ci status`); when it can only be polled or tailed, stay on
Monitor. Treat it as preview-grade — do not wire a load-bearing automation onto
it without a Monitor or `/loop` fallback.

## LM-002b: Use Workflows When …

Dynamic **Workflows** is the **one-shot fan-out** primitive — distinct from every
recurring/polling axis. Reach for it when a single objective decomposes into many
independent units one conversation cannot coordinate: a codebase-wide audit, a
large migration, a multi-angle research sweep. The model plans once, codifies a
rerunnable script, fans out subagents, and returns only the final result.

**Never reimplement a one-shot fan-out as `/loop`.** A `/loop` body re-runs a
single coordinator prompt on an interval; it has no native fan-out, no
agent-count cap, and no rerunnable-script artifact.

**Distinct from in-run agent teams.** Workflows' one-shot fan-out is unrelated to
experimental in-run multi-agent coordination within a single live session — see
`parallel-sessions.md` § PSA Scope Axes for that boundary.

**Do not swap a purpose-built wave orchestrator for a bare Workflow.** A
Workflow's agent-count caps are bounds, not kill-switches, and it ships no
per-run telemetry artifact. If your orchestration has stop conditions and an
audit trail, a Workflow does not replace them.

## LM-003: Use `/loop` When …

Use `/loop` when the check is genuinely periodic (no streamable trigger) and
bounded by THIS conversation — a staleness check during a multi-hour session, a
backlog snapshot during long-running work, branch-tending while waiting on
review. Wire a custom maintenance loop into `.claude/loop.md` (project) or
`~/.claude/loop.md` (user). Scheduled tasks fire only while the agent runtime is
running; unexpired tasks restore on `--resume`/`--continue`.

**Cadence — pick by observation-rate, not by the cache.** Choose the interval
from how fast the watched thing changes: about a minute to a few minutes when a
state transition is imminent, five to twenty minutes for steady-state polling,
twenty minutes to an hour for idle maintenance. The runtime clamps a self-paced
wakeup to roughly [60s, 3600s]. Under a short (5-minute) prompt-cache TTL, avoid
a cadence that lands exactly on the cache cliff — you pay the miss without
amortising it.

**Limits & kill-switches (load-bearing).** A single environment variable
(`CLAUDE_CODE_DISABLE_CRON=1`) disables the cron scheduler AND `/loop` entirely —
not just one task. Each session is capped at a few dozen scheduled tasks. Both
`.claude/loop.md` and `~/.claude/loop.md` are TRUNCATED past **25,000 bytes** —
keep the loop body lean; a bloated body silently loses its tail rather than
erroring.

## LM-004: Use Routines / Scheduled Tasks When …

Use cloud Routines or desktop scheduled tasks when the work must run when no
session is open (overnight, weekly, monthly), spans repos no single session can
witness, or must persist across machine restarts. `/loop` is the wrong tool here
— it fires only while the agent runtime is running; `--resume`/`--continue`
restoration is not durable unattended scheduling.

## LM-005: Never Reimplement These as `/loop`

- **A driver that already has its own kill-switches and telemetry.** Wrapping it
  in `/loop` loses both. Pair them — never replace.
- **Synchronous inter-wave checkpoints.** They are synchronous by design.
- **Quality gates** (typecheck, test, lint). These block on purpose. Run them
  once, sequentially.
- **Hook-served events.** `PostToolUse`, `Stop`, `SubagentStop` already fire at
  the right moment. A `/loop` poll on top is redundant.
- **`/goal`.** Do not hand-roll a per-turn Stop-hook prompt evaluator to keep
  working until a condition holds — `/goal` IS that mechanism, natively.
  Re-implementing it as a custom Stop hook or a `/loop` body duplicates the
  machinery and loses the built-in restore and clear lifecycle. See LM-008.
- **One-shot subagent fan-out.** A codebase-wide audit / large migration /
  multi-angle research sweep is a dynamic Workflow, not a `/loop`. See LM-002b.

## LM-006: Destructive-Action Safeguards Apply

A `/loop` body is a coordinator prompt that runs every iteration. Treat it as you
would any coordinator action:

- **No destructive operations** (`git push`, `git reset`, `rm`, merging an MR,
  closing an issue) without explicit transcript authorisation for the specific
  action.
- **Track your footprint.** A loop that "tidies up" untracked files may delete
  another session's work-in-progress. See `parallel-sessions.md`.
- **Read-only first.** When in doubt, observe and report.

## LM-007: Anti-Patterns

- Fixed `/loop 5m …` to babysit a CI run — use Monitor on `glab ci status` or `gh pr checks --watch` instead (LM-002).
- `/loop 1d …` for a daily note — use Routines or desktop tasks; `/loop` does not fire while the agent runtime is stopped (LM-004).
- A Monitor filter matching only the success marker — silence from a crash is indistinguishable from success (LM-002 coverage rule).
- `/loop` wrapping an autonomous driver — duplicates loop semantics and hides its kill-switches (LM-005).
- A cadence sitting exactly on a short prompt-cache TTL boundary — you pay the cache miss without amortising it (LM-003).
- Using `/goal` as a quality gate — the evaluator reads the transcript only; pair `/goal` with a deterministic exit-code gate (LM-008).
- Unbounded `/goal` with no turn/time-bound clause — always embed "or stop after N turns / M minutes" (LM-008).
- Hand-rolling a one-shot fan-out as a `/loop` body — use a Workflow (LM-002b).

## LM-008: Use `/goal` When …

`/goal <condition>` keeps the model working across turns until a stated
completion condition is confirmed — a session-scoped, prompt-based Stop hook
where a small, fast evaluator reads the condition plus the conversation each turn
and returns yes/no with a reason. Cost is typically negligible. Use it for a
**finite objective** that needs multiple turns to converge and whose
done-condition is **demonstrable from the model's own surfaced output** — the
evaluator runs NO tools, so surface the evidence (paste the test summary, echo
the worklist, print the state). Write conditions the transcript can demonstrate
("all referenced tests show as passing in the output" works; "the production
database is consistent" does not). **Always embed a bound** ("or stop after 20
turns / 30 minutes") so a non-converging goal terminates.

**The load-bearing caveat — `/goal` provides CONTINUATION plus model-evaluated
JUDGMENT, never deterministic VERIFICATION.** The evaluator judges the condition
from the transcript; it does not run verification tools. Deterministic quality
gates remain the source of truth: the project's test, typecheck, and lint
commands and their **exit codes** decide whether work is correct. Never replace
an exit-code gate with a model vote. The correct pattern is a goal whose
condition references freshly-run gate output ("…until the test command prints 0
failures **in this turn's output**"), backed by an actual gate run each turn —
not a goal that asserts success on its own.

## See Also

parallel-sessions.md · ask-via-tool.md · verification-before-completion.md · npm-quality-gates.md
