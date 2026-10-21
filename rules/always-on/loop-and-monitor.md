<!-- source: session-orchestrator plugin (canonical: rules/always-on/loop-and-monitor.md) -->
# Loop & Monitor Routing (Always-on)

`/goal`, Workflow, Channels, Monitor, `/loop` and Routines share the "keep going / keep watching" slot but are not interchangeable. Check each primitive's availability in your harness before relying on it, and keep a fallback.

## LM-001: Decision Tree — Pick the Primitive First
In order, first match wins:
1. Finite objective whose done-condition the model's own surfaced output can demonstrate: `/goal` (LM-008). External CI-green is invisible to its evaluator: use Monitor.
2. One-shot fan-out over many independent units, too large for one conversation: Workflow (LM-002b).
3. Event the source can push (CI webhook, error tracker, chat): Channels (LM-002a).
4. Stream you can tail (logs, file changes, CI transitions, JSONL): Monitor (LM-002).
5. Periodic and bound to THIS conversation (days, resume acceptable): `/loop`, dynamic unless the cadence is truly fixed (LM-003).
6. Durable, offline, overnight or cross-repo: cloud Routines or desktop scheduled tasks (LM-004).

## LM-002: Use Monitor When …
Tailing builds, tests, CI, logs or file events. The filter MUST match progress AND every terminal failure state; silence is not success. If failure signatures cannot be enumerated, broaden the filter. A watch expires; expiry is an exit notice, never success, so re-arm if still needed. In unattended `-p` runs, wait in bounded foreground commands and read the real exit: background tasks and Monitor watches do not keep the run alive after the turn ends.

## LM-002a: Use Channels When …
The source can push. Research preview: never load-bearing without a Monitor or `/loop` fallback. Session-to-session text is messaging, not Channels.

## LM-002b: Use Workflows When …
One-shot independent fan-out. Never emulate fan-out with `/loop`; never replace an orchestrator that owns kill-switches and telemetry with a bare Workflow.

## LM-003: Use `/loop` When …
Periodic, no stream, this conversation. Pace by observation rate: imminent change 60–270 s, steady polling 300–1200 s, idle 1200–3600 s. Loop body files truncate past 25,000 bytes; keep them lean. `CLAUDE_CODE_DISABLE_CRON=1` disables `/loop` and the scheduler entirely.

## LM-004: Use Routines / Scheduled Tasks When …
Work must survive the session: nightly, weekly, cross-repo, restart-durable. Resume restoration is not unattended scheduling.

## LM-005: Never Reimplement These as `/loop`
Autonomous drivers with their own kill-switches, synchronous inter-step quality gates, hook events you already receive, and `/goal` itself (never rebuild it as a custom Stop hook). Pair with them instead.

## LM-006: Destructive-Action Safeguards Apply
Every loop iteration is an ordinary action: no push, reset, delete, merge or issue close without explicit authorization for that action. When unsure, observe and report read-only.

## LM-007: Anti-Patterns
Wrong routing, success-only filters, unbounded goals, a goal used as a gate, and caps mistaken for kill-switches.

## LM-008: Use `/goal` When …
Finite multi-turn objective. The evaluator runs no tools: surface fresh evidence (test summary, worklist, state) in the transcript, and always embed a bound ("or stop after 20 turns / 30 minutes"). `/goal` gives continuation and model judgment, never verification: fresh test/typecheck/lint exit codes decide, run each turn.

## See Also

parallel-sessions.md · ask-via-tool.md · verification-before-completion.md · npm-quality-gates.md
