---
description: End session with verification, commits, and documentation
disable-model-invocation: true
---

# Close Session

The user wants to end the current session.

**Pre-check before invoking session-end:** Determine `<state-dir>` from the current platform (`.claude/`, `.codex/`, `.cursor/`, or `.pi/`). Check if `<state-dir>/STATE.md` exists and read its `status` field. Three exit conditions:

1. **STATE.md does not exist:** Read Session Config to check `persistence`. If `persistence: false`, inform the user: "Session completed (persistence is off — STATE.md was never created). Use `/session` to start a new session." If `persistence: true` (or Session Config unavailable), inform the user: "No active session found. Use `/session` to start a session first." Either way, stop.
2. **STATE.md exists and `status: completed`:** `status: completed` alone is NOT proof that session-end's Phase 3.7 writer ever ran (#429) — the field can be set by hand, or by any path that stops short of that write. Parse STATE.md with `parseStateMd` and parse `.orchestrator/metrics/sessions.jsonl` as JSONL. Import `findRecordedSession` from the plugin's `scripts/lib/session-close-backfill.mjs` and call it with the parsed records and `{ sessionId: frontmatter['session-id'], semanticSessionId: frontmatter.session, startedAt: frontmatter.started_at }`. This is the shared backfill identity reader: native UUIDs take precedence, conflicting native IDs never match through a label, and legacy semantic records remain readable. Do not substitute a text grep or compare the semantic label only against `session_id`. A missing ledger means no record; an unreadable or malformed ledger is inconclusive — report the read/parse failure and stop before repeating close side effects.
   - **A matching completed record exists (including a legacy authoritative record without a `status` field):** Inform the user: "Previous session was already finalized by session-end. Start a new session with `/session`, or inspect `<state-dir>/STATE.md` to review the prior close. (Note: if this is unexpected after an Express Path session, `commands/go.md` should have auto-invoked /close — check that STATE.md `## Deviations` contains an `Express path:` entry.)" and stop.
   - **No matching completed record exists:** Warn the user: "STATE.md completed ohne passenden Abschluss im Ledger — session-end wird zur Vervollständigung ausgeführt (#429)." An abandoned backfill stub does not prove finalization. Do NOT stop — proceed to invoke the session-end skill exactly as in exit condition 3, so the missing completion gets written this time. (The SessionEnd hook's `backfillCompletedFromStateMd` independently self-heals this same gap on a later session's teardown; this Pre-Check branch covers the case where /close is re-run before that hook has had a chance to fire.)
3. **STATE.md exists and `status: active` or `status: paused`:** Proceed to invoke the session-end skill.

For any other `status` value (e.g., `idle`), warn the user: "Unexpected session status `<value>`. Inspect `<state-dir>/STATE.md` and use `/session` to reset if needed." and stop.

If the pre-check passes, invoke the session-end skill.

Verify ALL planned work, create issues for gaps, commit cleanly, and mirror if configured.

- Releases the distributed session-lock (`.orchestrator/session.lock`) before the Phase 4 commit is staged. See `skills/session-end/SKILL.md` § Phase 3.8: Session Lock Release (#330).

Do NOT skip any verification step. Evidence before assertions.
