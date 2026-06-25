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
│        Continuation across turns until the condition is confirmed.
│        (Completion-condition axis — see LM-008.)
│        Pair with deterministic gates — /goal continues, it never judges.
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
                           └─ No  → Is the watched thing PERIODIC and bounded by THIS session
                                    (≤ 7 days, in-memory acceptable)?
                                    │
                                    ├─ Yes → /loop.
                                    │        Use dynamic mode unless the cadence is genuinely fixed.
                                    │
                                    └─ No  → Routines (cloud) or Desktop scheduled tasks.
                                             Daily notes, weekly audits, cross-repo sweeps.
                                             /loop CANNOT cover these — it dies with the session.
```

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

For vetted snippets, see `skills/_shared/monitor-patterns.md`.

## LM-002a: Use Channels When …

Channels (research preview, v2.1.80+) is the **push-based sibling of Monitor**:
instead of tailing a stream you control, an external system pushes the event
into your open session via an MCP channel plugin (CI webhook, error tracker,
chat). Zero polling, and it reacts while you are away from the keyboard.

Constraints (cite https://code.claude.com/docs/en/channels):

- **Anthropic-auth only** — unavailable on Bedrock/Vertex/Foundry.
- **Per-session opt-in** via the `--channels` flag.
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
- **Kill-switch:** `disableWorkflows` (settings) or `CLAUDE_CODE_DISABLE_WORKFLOWS=1` (env).
- **Provider availability:** runs on Bedrock/Vertex/Foundry as well as Anthropic-auth.
- **Save location:** `.claude/workflows/` (project) or `~/.claude/workflows/` (user; project wins).
- **Trigger:** `/effort ultracode` is the on-ramp for dynamic Workflows.

**Workflows vs wave-executor + `autopilot-multi`:** the 16/1000 caps are agent-count bounds, not the repo's ten kill-switches (`scripts/lib/autopilot/kill-switches.mjs`), and Workflows ships no `autopilot.jsonl`-equivalent telemetry. The Adopt/Adapter/Stay verdict is an open follow-up in `docs/adr/0010-native-autonomy-commands.md` — do not swap wave-executor for a bare Workflow on the assumption the caps substitute for the kill-switches.

**Never reimplement a one-shot fan-out as `/loop`.** A `/loop` body re-runs a
single coordinator prompt on an interval; it has no native fan-out, no agent-
count cap, and no rerunnable-script artifact. If the work is genuinely one-shot
fan-out, use the `Workflow` tool; `/loop` is for the periodic, in-session axis below.

## LM-003: Use `/loop` When …

- The check is genuinely periodic (no streamable trigger): vault-staleness
  during a multi-hour deep session, top-priority backlog snapshot during
  long-running work, branch-tending while waiting on review.
- The work fits inside a single Claude session and the operator is at the
  keyboard (or will resume with `claude --resume` within 7 days).
- A custom maintenance loop is wanted at session-start — wire it into
  `.claude/loop.md` (project) or `~/.claude/loop.md` (user).

`/loop` is also exposed as `/proactive` (alias). Dynamic mode self-paces via
the `ScheduleWakeup` tool (1 min–1 h); the pending wakeup surfaces in
`session_crons` in the Stop-hook input
(code.claude.com/docs/en/tools-reference#schedulewakeup).

**Cadence selection** (matters for token cost — Anthropic prompt cache
TTL is ~5 min):

| Range | When |
|---|---|
| `60s` – `270s` | Cache stays warm. Use for active work — checking a build, polling state about to change. |
| `300s` | **Avoid.** Worst-of-both: pay the cache miss without amortising it. |
| `1200s` – `3600s` (20 – 60 min) | Idle ticks, maintenance loops, vault-staleness re-banner. One cache miss buys a long wait. |
| `> 3600s` | Use `/schedule` or Routines instead — `/loop`'s 7-day expiry is the ceiling, not the design point. |

**Off-minutes hygiene.** Cron jitter penalises `:00` and `:30` for one-shots
(fire up to 90 s early). For recurring jobs, prefer minutes other than 0/30:
`3 9 * * *` not `0 9 * * *`. Honours the same fleet-spread argument as
`CronCreate`'s built-in guidance.

## LM-004: Use Routines / Desktop When …

- The work must run when no session is open (overnight, weekly, monthly).
- The work spans repos in a way that no single session can witness
  (cross-repo readiness watcher, baseline-MR drift detection).
- The artefact must persist across machine restarts (`/daily` rollover).

`/loop` is the wrong tool here — its session-scoped lifetime guarantees
the work will eventually be missed.

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
- `/loop 1d …` for a daily note — use Routines or Desktop tasks; `/loop` dies with the session (LM-004).
- Monitor filter matching only the success marker — silence from a crash is indistinguishable from success (LM-002 coverage rule).
- `/loop` wrapping `/autopilot` — duplicates loop semantics and hides the kill-switches (LM-005).
- Cadence at `300s` — cache miss without buying a longer wait; pick `270s` or `1200s+` (LM-003).
- Using `/goal` as a quality gate — the evaluator reads the transcript only; pair `/goal` with a deterministic exit-code gate (LM-008).
- Unbounded `/goal` with no turn/time-bound clause — always embed "or stop after N turns / M minutes" (LM-008).
- Hand-rolling a one-shot fan-out as a `/loop` body — use the `Workflow` tool (LM-002b).
- Swapping wave-executor for a bare Workflow assuming its 16/1000 caps replace the ten kill-switches — they don't; verdict open in ADR-0010 (LM-002b).

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

**The load-bearing caveat — `/goal` provides CONTINUATION, never JUDGMENT.**
The evaluator is a transcript reader, not a verifier. Deterministic quality
gates remain the source of truth: `npm test`, `npm run typecheck`,
`npm run lint` and their **exit codes** decide whether work is correct. Never
replace an exit-code gate with a Haiku vote. The two compose cleanly: `/goal`
keeps the loop alive across turns, the gate decides whether the loop is done.
The correct pattern is a goal whose condition references freshly-run gate
output ("…until `npm test` prints 0 failures **in this turn's output**"),
backed by an actual gate run each turn — not a goal that asserts success on
its own.

**Availability constraints:** requires Claude Code v2.1.139+; one active goal
per session; UNAVAILABLE when `disableAllHooks` or `allowManagedHooksOnly` is
set (the mechanism is a managed Stop hook). When unavailable, fall back to a
bounded `/loop` body that re-runs the deterministic gate and reports.

**Pairing with Auto mode (unattended runs).** For an unattended `/goal` that
must run each turn without per-tool approval prompts, pair it with Auto mode —
Auto mode removes per-tool prompts, `/goal` removes per-turn prompts; they
compose (https://code.claude.com/docs/en/goal).

See `docs/adr/0010-native-autonomy-commands.md` for the full verdict on how
`/goal` slots alongside `/loop`, Monitor, and Routines in the orchestrator.

## See Also

- `parallel-sessions.md` (PSA discipline that applies inside loop bodies)
- `ask-via-tool.md` (loop bodies must still use AUQ for user decisions)
- `development.md` · `security.md` · `mvp-scope.md` · `cli-design.md`
- `verification-before-completion.md` (why `/goal` never replaces an exit-code gate)
- ADR: `docs/adr/0010-native-autonomy-commands.md` (full `/goal` vs `/loop` vs Monitor vs Routines verdict; Workflows watch-item FIRED 2026-06-12)
- Project file: `.claude/loop.md` (the orchestrator's bare-`/loop` body)
- Reference: `skills/_shared/monitor-patterns.md` (vetted Monitor filter snippets)
- Upstream: https://code.claude.com/docs/en/workflows (dynamic Workflows — LM-002b fan-out axis)
