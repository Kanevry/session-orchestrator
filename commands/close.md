---
description: End session with verification, commits, and documentation
---

# Close Session

The user wants to end the current session.

**Pre-check before invoking session-end:** Determine `<state-dir>` from the current platform (`.claude/`, `.codex/`, or `.cursor/`). Check if `<state-dir>/STATE.md` exists and read its `status` field. Three exit conditions:

1. **STATE.md does not exist:** Read Session Config to check `persistence`. If `persistence: false`, inform the user: "Session completed (persistence is off — STATE.md was never created). Use `/session` to start a new session." If `persistence: true` (or Session Config unavailable), inform the user: "No active session found. Use `/session` to start a session first." Either way, stop.
2. **STATE.md exists and `status: completed`:** Inform the user: "Previous session was already finalized by session-end. Start a new session with `/session`, or inspect `<state-dir>/STATE.md` to review the prior close. (Note: if this is unexpected after an Express Path session, `commands/go.md` should have auto-invoked /close — check that STATE.md `## Deviations` contains an `Express path:` entry.)" and stop.
3. **STATE.md exists and `status: active` or `status: paused`:** Proceed to invoke the session-end skill.

For any other `status` value (e.g., `idle`), warn the user: "Unexpected session status `<value>`. Inspect `<state-dir>/STATE.md` and use `/session` to reset if needed." and stop.

If the pre-check passes, invoke the session-end skill.

Verify ALL planned work, create issues for gaps, commit cleanly, and mirror if configured.

Do NOT skip any verification step. Evidence before assertions.
