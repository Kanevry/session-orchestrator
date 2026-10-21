---
tier: coordinator-only
review-date: 2026-10-23
---

# Loop & Monitor Routing (Always-on)

## LM-001: Decision Tree — Pick the Primitive First
In order:
1. Finite objective whose done-condition Claude's surfaced output can demonstrate (state ≤4000 chars): `/goal`, bounded, paired with deterministic gates. External CI-green is not visible to its evaluator: use Monitor.
2. Otherwise one-shot independent fan-out too large for one conversation: dynamic `Workflow` tool (/en/workflows, v2.1.154+), rerunnable script, final result in main context.
3. Otherwise pushable external event: Channels (research preview, v2.1.80+), with Monitor/loop fallback.
4. Otherwise tail-able stream (logs/files/CI transitions/JSONL): Monitor; one notification per output or exit event (output may contain multiple lines), zero polling tokens.
5. Otherwise genuinely periodic and conversation-bound (≤7 days; resume restoration acceptable): `/loop`, dynamic unless fixed cadence is necessary.
6. Otherwise durable/offline/cross-repo work: cloud Routines or Desktop scheduled tasks.

## LM-002: Use Monitor When …
Tail streamable builds/tests, CI watch, logs, telemetry or filesystem events. Filters MUST cover progress AND EVERY terminal failure state; silence is not success. If failure signatures cannot be enumerated, broaden the filter rather than hide crashes. A watch defaults to 5 minutes and expires after at most 30 minutes interactively, 10 minutes in single-prompt `-p` runs (v2.1.271+); expiry produces one exit notice, never success: re-arm if still needed. In unattended `-p` workflows, wait in bounded foreground commands and read the actual exit; background tasks or Monitor watches do not keep the run alive after turn-end. Version v2.1.98+; Bedrock/Vertex/Foundry or DISABLE_TELEMETRY unavailability requires fallback; v2.1.195+ supports WebSocket sources. Vetted snippets: `skills/_shared/monitor-patterns.md`.

## LM-002a: Use Channels When …
Use push via an MCP channel plugin when the source can push, Monitor when only polling/tailing is possible. Research preview MUST NOT carry load-bearing automation without Monitor/loop fallback. Session-to-session text uses `cross-session-messaging.md`, not Channels. Auth/version/org gates: ADR reference below.

## LM-002b: Use Workflows When …
One-shot independent fan-out uses Workflow, NEVER loop (no native fan-out/cap/rerunnable artifact). Distinct from off-by-default in-run Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). Do NOT replace wave-executor with bare Workflow: 16/1000 agent caps do not provide ten kill-switches or `autopilot.jsonl` telemetry. Verdict Stay, Adapter fallback on non-Anthropic providers; full constraints in ADR-0010 § Native-Overlap Refresh.

## LM-003: Use `/loop` When …
Periodic, no stream, THIS conversation. Bodies: `.claude/loop.md` or `~/.claude/loop.md`. Tasks fire only while Claude Code runs; unexpired tasks restore on --resume/--continue; expiry 7 days. `/background` keeps a session alive without terminal. Prefer self-paced ScheduleWakeup unless cadence truly fixed.
Choose by observation rate: imminent transition 60–270s; steady polling 300–1200s; idle maintenance 1200–3600s. Runtime clamps [60s,3600s]. A 300s cache cliff only applies with 5-minute TTL (API keys/subscription overage); subscription main-conversation default TTL is 1 hour.
`CLAUDE_CODE_DISABLE_CRON=1` disables scheduler AND loop; cap 50 tasks/session. Both body files truncate past 25,000 bytes: keep lean or silently lose the tail. Non-Anthropic bare loop uses fixed 10-minute schedule and skips `.claude/loop.md`. Skill-Dispatch-Gate, task-prompt trust and off-minutes hygiene: ADR reference.

## LM-004: Use Routines / Desktop When …
Use for offline/overnight/weekly/monthly work, cross-repo checks, restart durability or daily rollover. Resume restoration is not unattended scheduling. Repo posture: teach Routines, do not operate any here (ADR-0003 superseded, #485 won't-do). Trigger types, account daily cap, claude/-branch push guard and availability: ADR reference.

## LM-004a: `/schedule` Gating
CLI Routines frontend: list/update/run. Requires claude.ai subscription login; invisible/disabled with Console API key, Bedrock/Vertex/Foundry or disabled telemetry. Full gates: ADR reference.

## LM-005: Never Reimplement These as `/loop`
NEVER wrap/replace autopilot (child-process driver, ten kill-switches, autopilot.jsonl); pair instead. Inter-wave checkpoints synchronous; npm test/typecheck/lint once, sequentially, blocking. No redundant polling of PostToolUse/Stop/SubagentStop. NEVER rebuild goal as custom Stop hook/loop: loses native evaluation, resume and clear lifecycle. Fan-out uses Workflow.

## LM-006: PSA-003 Applies
Each loop iteration is a coordinator action. No `git push`, `git reset`, rm, MR merge or issue close without explicit transcript authorization for that specific action. Track footprint, never delete others' untracked work; when uncertain observe/report read-only.

## LM-007: Anti-Patterns
Avoid wrong routing, success-only filters, unbounded goals, goal-as-gate or caps mistaken for kill-switches (LM-001–006/008).

## LM-008: Use `/goal` When …
Goal (v2.1.139+) continues finite multi-turn objectives using a session-scoped prompt-based Stop hook; default Haiku evaluator sees condition+conversation, NO tools; surface fresh test/worklist/state evidence. ALWAYS embed turn/time bound (e.g. stop after 20 turns/30 minutes). It provides continuation and model judgment, NEVER deterministic verification. Actual fresh npm test/typecheck/lint EXIT CODES decide; reference THIS turn's output and run gate each turn; never model votes. clear/stop/off/reset aliases, resume/continue restoration, disableAllHooks/allowManagedHooksOnly/workspace-trust availability and Auto pairing: ADR reference.

Version gates, constraint tables, crosswalk, cadence and Delta-Sync provenance: `docs/adr/0010-native-autonomy-commands.md` § Upstream Reference and Delta-Sync Provenance. Scoped implementation reminders: `monitor-mechanics.md`.

## See Also
parallel-sessions.md (§ PSA Scope Axes) · ask-via-tool.md · verification-before-completion.md · development.md · security.md · mvp-scope.md · cli-design.md · `.claude/loop.md` · `skills/_shared/monitor-patterns.md`
