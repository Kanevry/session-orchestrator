---
name: go
description: Approve session plan and begin wave execution
user-invocable: true
disable-model-invocation: true
argument-hint: "[optional instructions]"
model: inherit
---
# Execute Session Plan

The user has approved the session plan. Begin execution immediately.

## No plan to execute

Before executing either path below, check for a plan. A plan exists when either holds:

- the conversation — including a context-compaction summary — contains a session-plan result that offers `Use /go to begin.` (wave plan or Express Path plan);
- `<state-dir>/STATE.md` has `status: active` or `status: paused` and its frontmatter `session-id` (the raw harness id) equals this process's own raw id — `readProcessLocalSessionIds()` in `scripts/lib/session-identity/own-session.mjs` (Claude Code: `$CLAUDE_CODE_SESSION_ID`; `readInvocationSessionId()` there is the ancestor-process proof). That is an interrupted wave execution of this session; the raw id survives a context compaction.

Never decide this by the labels STATE.md `session`, `semantic_session_id` or `.orchestrator/current-session.json`: they are repo-wide, and a peer session started later in the same repo owns them (`skills/_shared/state-ownership.md` § Session Identity and Lock Ownership). A STATE.md without `session-id`, without a measurable own id, or not `active`/`paused` proves nothing: session-plan does not write it, and the wave-executor sets `status: active` only when execution starts. If neither holds, print the line `/go: kein Plan vorhanden – nichts ausgeführt` and end the answer with the wait sentence `Ich warte auf den nächsten Auftrag.` (or `Bereit zum Schließen.` when the fleet handover applies) — the status line alone is not recognised as a waiting answer (`skills/_shared/fleet-protocol.md` § Rücklauf an den Navigator, Wartesatz). Do not re-plan or start a new session.

In this no-plan case apply `skills/_shared/fleet-protocol.md` § Rücklauf an den Navigator (Pflicht) with the wait case `go-ohne-plan`: measure fleet and lease read-only (no check-in) and send exactly ONE report in this turn, even if an earlier turn already reported the same case (`SendMessage` with an active, reachable lease; on failure or otherwise a Lead-Todo; if that fails too, `Meldung gescheitert: <Grund>` in the last paragraph) — the session, `/go ohne Plan`, the time from `date`, and what the session needs next. Never wait for a reply (CSM-004). Return without executing work.

## Invocation

Invoked as `/go [optional instructions]` with arguments: **$ARGUMENTS**. The user has approved the session plan; begin execution immediately.

`$ARGUMENTS` is optional priority guidance, forwarded verbatim to `skills/wave-executor/SKILL.md` for agent prompts (see "Standard Execution" below). It never re-opens the plan: do NOT re-plan, do NOT re-analyze — execute the agreed plan NOW with maximum efficiency.

## Express Path Detection

Before invoking the wave-executor, check the conversation context for the Express Path activation banner — printed by `node scripts/express-path.mjs` in session-start Phase 8.5, and carried through session-plan's Short-Circuit (#1146):

```
Express path activated — <N> tasks, coordinator-direct, no inter-wave checks.
```

If the banner is present (and the session-plan output emitted a 1-wave Express Path plan per `skills/session-plan/SKILL.md` § "Express Path Short-Circuit"):

**The express 1-wave plan IS the housekeeping shape.** `node scripts/session-shape.mjs --repo-root "$PWD" --session-type housekeeping --no-event` resolves to a single wave with `coordinatorDirect: true` — the express path is not a bespoke shortcut but that shape executed. Consequently, when the session type is `housekeeping`, the coordinator-direct execution runs the **maintenance loop first** (drift-check, expired sweep, `/evolve analyze`, `/reconcile`, `/evolve dialectic`, `/memory-cleanup` — ordered scope, gates and proving artefacts in `skills/wave-executor/SKILL.md` § Housekeeping Sessions — the Maintenance Loop), and **then** the selected issues in dependency order.

1. **Execute the agreed tasks directly** as coordinator actions, in dependency order. Do NOT dispatch subagents. Do NOT invoke the wave-executor skill.
2. **Append the Express Path deviation to STATE.md** before invoking session-end. Use `appendDeviationOnDisk()` from `scripts/lib/state-md.mjs` — the on-disk wrapper takes the STATE.md lock automatically, serialising any concurrent writers. This step ensures the audit trail exists BEFORE session-end finalizes the file. Equivalent one-liner via Bash:
   ```bash
   node --input-type=module -e "
   import {execSync} from 'node:child_process';
   import {appendDeviationOnDisk} from './scripts/lib/state-md.mjs';
   const repoRoot = execSync('git rev-parse --show-toplevel', {encoding: 'utf8'}).trim();
   await appendDeviationOnDisk(repoRoot, new Date().toISOString(), 'Express path: <N> tasks executed coord-direct (express-path.enabled: true, session-type: housekeeping, scope: <N> issues)');
   "
   ```
3. **Fleet check (#1620), then close.** Measure fleet integration first with the read-only one-liner in `skills/_shared/fleet-protocol.md` § Rücklauf an den Navigator. On `flotte: true` (fleet integration on this host, with or without an active lease) the session does NOT close itself (fleet-protocol § Übergabe Punkt 4): skip the rest of this step and steps 4–5. Instead give the session summary first, then report the wait case `fertig`, write the hand-over and end the reply with `Bereit zum Schließen.` as its last sentence, per fleet-protocol § Übergabe und Zug-Manifest (the coordinator only reads the last 600 characters). The deviation from step 2 is already on disk; the coordinator triggers `/close`, and the regular session-end flow finalizes STATE.md — the step-4 persistence check does not run on this path. On `flotte: false` continue:
   **Invoke `session-orchestrator:session-end`** directly via the `Skill` tool. Session-end finalizes STATE.md (sets `status: completed`, writes `.orchestrator/metrics/sessions.jsonl`, runs vault-mirror if enabled). Without this auto-invocation, every Express Path run leaves no audit trail (issue #320).
4. **Verify persistence after session-end completes:** read `<state-dir>/STATE.md` and confirm `frontmatter.status === 'completed'` and the body's `## Deviations` section contains an `Express path:` entry. If either is missing, warn the user inline with: `⚠ Express Path persistence verification failed — STATE.md not finalized. Re-run /close manually.` Then return the final summary.
5. **Return** the session summary to the user. The express-path execution is complete.

If the banner is **absent**: proceed to "Standard Execution" below.

## Standard Execution

**Invoke the wave-executor skill.** Follow the agreed plan wave by wave. Forward `$ARGUMENTS` (if any) to the wave-executor as priority guidance for agent prompts (see wave-executor Pre-Execution: User Instructions).

Do NOT re-plan. Do NOT re-analyze. Execute the agreed plan NOW with maximum efficiency.
