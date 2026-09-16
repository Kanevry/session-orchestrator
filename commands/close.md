---
description: End session with verification, commits, and documentation
disable-model-invocation: true
---

# Close Session

The user wants to end the current session.

**Invoke the `close` skill** (`skills/close/SKILL.md`). It carries the STATE.md pre-check (three exit conditions, including the #429 ledger cross-check) and hands off to `skills/session-end/SKILL.md`.

Do NOT skip any verification step. Evidence before assertions.
