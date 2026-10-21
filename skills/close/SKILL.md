---
name: close
description: End session with verification, commits, and documentation
user-invocable: true
disable-model-invocation: true
model: inherit
---
# Close Session

## Invocation

The user invokes `/close` (arguments: **$ARGUMENTS** — none are interpreted; anything passed is context only) to end the current session. Run the STATE.md pre-check below, then hand off to `skills/session-end/SKILL.md`. Do NOT skip any verification step — evidence before assertions.

The user wants to end the current session.

**Pre-check before invoking session-end (#1661).** Run, from the project root:

```bash
node "${CLAUDE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-$PLUGIN_ROOT}}/scripts/close-precheck.mjs" --repo-root "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
```

It prints one JSON object (exit 0 for every verdict). It reads `<state-dir>/STATE.md` for the current platform (`.claude/`, `.codex/`, `.cursor/`, `.pi/`) and decides **whose** it is before it looks at `status`: STATE.md `session-id` (#1368) against this process's native id (`readProcessLocalSessionIds()`). Never decide ownership from the session lock: it records the pid of the short-lived hook process, and in a shared checkout it can name a peer. After `/clear` the tab runs under a NEW native id, so the STATE.md of the work before `/clear` reads as foreign — measured 2026-10-17 in three sessions. A STATE.md without `session-id` (before #1368) or a process without a native id (`ownership: legacy` / `unprovable`) keeps the status-only behaviour. Act on `verdict`:

1. **`run-session-end`** — own (or legacy) STATE.md, `status: active` or `paused`: invoke the session-end skill.
2. **`complete-missing-record`** — own STATE.md `status: completed`, but `.orchestrator/metrics/sessions.jsonl` holds no completed record for it (#429: `completed` alone does not prove the Phase 3.7 writer ran; an abandoned backfill stub is no completion). Warn: "STATE.md completed ohne passenden Abschluss im Ledger — session-end wird zur Vervollständigung ausgeführt (#429)." and invoke the session-end skill. (The SessionEnd hook's `backfillCompletedFromStateMd` heals the same gap on a later teardown; this branch covers a `/close` re-run before that.)
3. **`already-finalized`** — a matching completed record exists (a legacy record without `status` counts): "Previous session was already finalized by session-end. Start a new session with `/session`, or inspect `<state-dir>/STATE.md` to review the prior close. (Note: if this is unexpected after an Express Path session, `skills/go/SKILL.md` should have auto-invoked /close — check that STATE.md `## Deviations` contains an `Express path:` entry.)" Stop.
4. **`foreign`** — STATE.md belongs to session `stateSessionId`, not to this one, whatever its `status`. Never invoke session-end on it and never edit it: an `active`/`paused` one is a peer's live session, a `completed` one an earlier tab or a peer. Inform: "STATE.md gehört Session `<stateSessionId>` (status `<status>`), nicht dieser — kein eigener Plan zum Abschließen." With `status: active` or `paused` add: "Ist das der Plan dieses Tabs von vor einem `/clear`, kann ihn dieser Prozess nicht als eigenen belegen; er bleibt offen, der SessionEnd-Hook füllt den Ledger nach." Stop.
5. **`no-state`** — read Session Config `persistence`. `false`: "Session completed (persistence is off — STATE.md was never created). Use `/session` to start a new session." Otherwise: "No active session found. Use `/session` to start a session first." Stop.
6. **`unexpected-status`** (e.g. `idle`): "Unexpected session status `<status>`. Inspect `<state-dir>/STATE.md` and use `/session` to reset if needed." Stop.
7. **`inconclusive`** — STATE.md frontmatter or the ledger is unreadable (`reason`): report it and stop before repeating any close side effect.

**`/close` ohne Plan.** Every stop above (3–7) leaves this session without an own plan to close — the wait case `close-ohne-plan`. With fleet integration, before the report run the queue-mark re-check on the own handover (`skills/session-end/SKILL.md` § 4.5, "Queue marks on the own handover", #1639); its JSON `file` says whether this session has an own handover or train manifest. Then apply `skills/_shared/fleet-protocol.md` § Rücklauf an den Navigator (Pflicht) with the wait case `close-ohne-plan` (exactly one report in this turn, only with fleet integration, fallback chain up to `Meldung gescheitert: <Grund>`, never wait for a reply), and end the answer — after the message quoted above — with exactly one closing sentence (none of those messages is recognised as a waiting answer on its own):
- `Bereit zum Schließen.` only on `already-finalized`, `no-state`, `unexpected-status` or a `foreign` STATE.md with `status: completed`, and only when the re-check found an own handover (`file` not `null`) and reported no unmarked points (exit 0): the work of this session is handed over, and the coordinator may clear the tab (fleet-protocol § Übergabe und Zug-Manifest, Punkt 3). A `foreign` stop is the normal end of a session that worked after `/clear` without its own `/session`.
- `Ich warte auf den nächsten Auftrag.` otherwise — no own handover, unmarked points (exit 3), no fleet integration, `inconclusive` (the status is unknown), or a `foreign` STATE.md that is still `active`/`paused` (a plan that is still open must not let the coordinator clear the tab).

session-end itself never runs on this path. A session that only waits on a pipeline or release train closes normally: its train manifest belongs to the waiting answer BEFORE `/close` (same section, Übergabe und Zug-Manifest), and session-end Phase 4.5 reports the case `zug-<name>` once in the `/close` turn.

If the pre-check passes, invoke the session-end skill.

Verify ALL planned work, create issues for gaps, commit cleanly, and mirror if configured.

- Releases the distributed session-lock (`.orchestrator/session.lock`) before the Phase 4 commit is staged. See `skills/session-end/SKILL.md` § Phase 3.8: Session Lock Release (#330).

Do NOT skip any verification step. Evidence before assertions.
