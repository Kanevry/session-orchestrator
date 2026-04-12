---
description: End session with verification, commits, and documentation
allowed-tools: Bash, Read, Glob, Grep, Agent, Write, Edit, TaskCreate, TaskUpdate
---

# Close Session

The user wants to end the current session.

**Pre-check before invoking session-end:** Determine `<state-dir>` from CLAUDE.md `## Session Config` (default: `.session/`). Check if `<state-dir>/STATE.md` exists. If it does not exist, inform the user: "No active session found. Use `/session` to start a session first." and stop. If `STATE.md` exists but contains `status: completed`, inform the user: "Previous session already closed. Start a new session with `/session`." and stop.

If the pre-check passes, invoke the session-end skill.

Verify ALL planned work, create issues for gaps, commit cleanly, and mirror if configured.

Do NOT skip any verification step. Evidence before assertions.
